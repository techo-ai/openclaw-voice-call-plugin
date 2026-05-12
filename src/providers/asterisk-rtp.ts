/**
 * RTP stream handler for Asterisk ExternalMedia channels.
 *
 * Handles bidirectional UDP RTP audio between Asterisk and OpenClaw.
 * Audio format: G.711 mu-law, 8kHz mono, 160 samples per 20ms packet.
 */

import dgram from "node:dgram";

const SAMPLES_PER_PACKET = 160;
const PTIME_MS = 20;
const RTP_HEADER_SIZE = 12;
const SILENCE_BYTE = 0x7f;

// ---------------------------------------------------------------------------
// Port allocation
// ---------------------------------------------------------------------------

const usedPorts = new Set<number>();

export function allocateRtpPort(startPort: number): number {
  let port = startPort;
  while (usedPorts.has(port)) port += 2;
  usedPorts.add(port);
  return port;
}

export function releaseRtpPort(port: number): void {
  usedPorts.delete(port);
}

// ---------------------------------------------------------------------------
// RTP header
// ---------------------------------------------------------------------------

function buildRtpHeader(seq: number, timestamp: number, ssrc: number): Buffer {
  const header = Buffer.alloc(RTP_HEADER_SIZE);
  header[0] = 0x80;
  header[1] = 0x00; // payload type 0 = PCMU
  header.writeUInt16BE(seq & 0xffff, 2);
  header.writeUInt32BE(timestamp >>> 0, 4);
  header.writeUInt32BE(ssrc >>> 0, 8);
  return header;
}

// ---------------------------------------------------------------------------
// RTP receiver (Asterisk → OpenClaw)
// ---------------------------------------------------------------------------

export interface RtpSource {
  address: string;
  port: number;
}

export interface RtpReceiver {
  readonly port: number;
  rtpSource: RtpSource | null;
  onAudio: ((mulawPayload: Buffer) => void) | null;
  close(): void;
}

export function startRtpReceiver(port: number, bindAddress = "0.0.0.0"): RtpReceiver {
  const socket = dgram.createSocket("udp4");
  let rtpSource: RtpSource | null = null;
  let onAudio: ((mulawPayload: Buffer) => void) | null = null;

  const receiver: RtpReceiver = {
    port,
    get rtpSource() {
      return rtpSource;
    },
    set rtpSource(v) {
      rtpSource = v;
    },
    get onAudio() {
      return onAudio;
    },
    set onAudio(v) {
      onAudio = v;
    },
    close() {
      try {
        socket.close();
      } catch {
        // already closed
      }
    },
  };

  socket.on("message", (msg: Buffer, rinfo: dgram.RemoteInfo) => {
    if (!rtpSource) {
      rtpSource = { address: rinfo.address, port: rinfo.port };
    }
    // Strip 12-byte RTP header → raw mu-law payload
    if (msg.length > RTP_HEADER_SIZE && onAudio) {
      onAudio(msg.subarray(RTP_HEADER_SIZE));
    }
  });

  socket.on("error", (err) => {
    console.error(`[asterisk-rtp] Receiver error on port ${port}:`, err.message);
  });

  socket.bind(port, bindAddress);
  return receiver;
}

// ---------------------------------------------------------------------------
// RTP sender (OpenClaw → Asterisk)
// ---------------------------------------------------------------------------

export interface RtpSender {
  /** Queue mu-law audio for paced 20ms RTP transmission. */
  send(mulawData: Buffer): void;
  /** Flush queue and stop playback (barge-in). */
  stopPlayback(): void;
  /** Close the UDP socket. */
  close(): void;
}

export function createRtpSender(target: RtpSource): RtpSender {
  const socket = dgram.createSocket("udp4");
  let seq = Math.floor(Math.random() * 65535);
  let timestamp = 0;
  const ssrc = Math.floor(Math.random() * 0xffffffff);
  let queue: Buffer[] = [];
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  function processQueue(): void {
    if (intervalId) return;
    intervalId = setInterval(() => {
      if (queue.length === 0 || closed) {
        if (intervalId) {
          clearInterval(intervalId);
          intervalId = null;
        }
        return;
      }
      const payload = queue.shift()!;
      const header = buildRtpHeader(seq, timestamp, ssrc);
      seq = (seq + 1) & 0xffff;
      timestamp += SAMPLES_PER_PACKET;
      const packet = Buffer.concat([header, payload]);
      socket.send(packet, target.port, target.address, (err) => {
        if (err && !closed) {
          console.error("[asterisk-rtp] Send error:", err.message);
        }
      });
    }, PTIME_MS);
  }

  return {
    send(mulawData: Buffer): void {
      // Split into 160-byte packets
      for (let offset = 0; offset < mulawData.length; offset += SAMPLES_PER_PACKET) {
        let chunk = mulawData.subarray(offset, offset + SAMPLES_PER_PACKET);
        if (chunk.length < SAMPLES_PER_PACKET) {
          const padded = Buffer.alloc(SAMPLES_PER_PACKET, SILENCE_BYTE);
          chunk.copy(padded);
          chunk = padded;
        }
        queue.push(chunk);
      }
      processQueue();
    },
    stopPlayback(): void {
      queue = [];
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    },
    close(): void {
      closed = true;
      queue = [];
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
      try {
        socket.close();
      } catch {
        // already closed
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Silence helper
// ---------------------------------------------------------------------------

export function createSilenceBuffer(durationMs: number): Buffer {
  const packets = Math.ceil(durationMs / PTIME_MS);
  return Buffer.alloc(packets * SAMPLES_PER_PACKET, SILENCE_BYTE);
}
