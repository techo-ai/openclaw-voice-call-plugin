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
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let nextTickAt = 0;
  let closed = false;
  let lastQueueDrainAt = 0;

  // Tolerance for "catch-up": if real time has run away from nextTickAt by more
  // than this, flush any backlog and rebase the schedule. Without this, drift
  // accumulates and the 8 kHz µ-law receiver hears the audio "tear".
  const CATCHUP_MS = 40;

  // Warm-up silence prefilled at the start of every fresh utterance (after a
  // quiet gap). Without this, Asterisk's PSTN-side jitter buffer is still cold
  // when the first real audio packet arrives — caller hears the first 80-120ms
  // clipped ("ate the beginning of the word"). 100ms of µ-law silence wakes
  // the buffer at zero perceptual cost.
  const TURN_PREFILL_FRAMES = 5;
  const TURN_IDLE_THRESHOLD_MS = 250;
  const PREFILL_SILENCE_FRAME = Buffer.alloc(SAMPLES_PER_PACKET, SILENCE_BYTE);

  function sendOne(): void {
    if (queue.length === 0 || closed) return;
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
  }

  function scheduleNextTick(): void {
    if (timeoutId || closed || queue.length === 0) return;
    const now = Date.now();
    if (!nextTickAt || now - nextTickAt > CATCHUP_MS) {
      // First tick, or we drifted too far behind — rebase schedule to "now".
      nextTickAt = now;
    }
    const delay = Math.max(0, nextTickAt - now);
    timeoutId = setTimeout(tick, delay);
  }

  function tick(): void {
    timeoutId = null;
    if (closed || queue.length === 0) return;

    // Catch-up: if the event loop stalled and real time is well past where the
    // schedule says we should be, flush enough frames to align with wall clock
    // before resuming the steady cadence. This is what fixes the "torn / bad
    // microphone" perception that comes from setInterval drift.
    let frames = 1;
    const now = Date.now();
    if (now - nextTickAt > CATCHUP_MS) {
      frames = 1 + Math.floor((now - nextTickAt) / PTIME_MS);
    }
    for (let i = 0; i < frames && queue.length > 0; i++) {
      sendOne();
    }
    if (queue.length === 0) {
      lastQueueDrainAt = Date.now();
    }

    nextTickAt += PTIME_MS * frames;
    scheduleNextTick();
  }

  return {
    send(mulawData: Buffer): void {
      // Detect start of a fresh utterance after a quiet gap and prefill µ-law
      // silence. This warms up Asterisk's RTP jitter buffer so the first
      // syllable of the bot's reply isn't clipped on the callee's end.
      const now = Date.now();
      const isTurnStart =
        queue.length === 0 &&
        (lastQueueDrainAt === 0 || now - lastQueueDrainAt > TURN_IDLE_THRESHOLD_MS);
      if (isTurnStart) {
        for (let i = 0; i < TURN_PREFILL_FRAMES; i++) {
          queue.push(PREFILL_SILENCE_FRAME);
        }
      }
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
      scheduleNextTick();
    },
    stopPlayback(): void {
      queue = [];
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      // Reset schedule so the next playback starts cleanly.
      nextTickAt = 0;
      lastQueueDrainAt = Date.now();
    },
    close(): void {
      closed = true;
      queue = [];
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
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
