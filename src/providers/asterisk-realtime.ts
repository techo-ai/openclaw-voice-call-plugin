/**
 * OpenAI Realtime voice session for Asterisk.
 *
 * Full-duplex audio: receives mu-law from RTP receiver, sends to OpenAI,
 * receives audio deltas back, forwards to RTP sender.
 * Supports barge-in (user speech interrupts assistant playback).
 */

import WebSocket from "ws";
import type { RtpReceiver, RtpSender, RtpSource } from "./asterisk-rtp.js";
import { createRtpSender, createSilenceBuffer } from "./asterisk-rtp.js";

export interface RealtimeVoiceConfig {
  apiKey: string;
  model?: string;
  systemPrompt: string;
  initialMessage?: string;
  voice?: string;
  vadThreshold?: number;
  vadPrefixPaddingMs?: number;
  vadSilenceDurationMs?: number;
  silencePaddingMs?: number;
  /**
   * When true (default), OpenAI Realtime generates its own reply after each
   * user turn via server VAD. Set false for calls where OpenClaw drives the
   * conversation with pre-rendered TTS (notify mode) — otherwise Realtime
   * barges in on top of our TTS, producing garbled overlapping audio.
   */
  autoRespond?: boolean;
}

export interface RealtimeVoiceSession {
  /** Start the session: connect to OpenAI and wire audio. */
  start(): Promise<void>;
  /** Stop everything and clean up. */
  stop(): void;
  /** Send text to be spoken by the assistant via OpenAI Realtime TTS. */
  speakText(text: string): void;
  /** Send pre-generated mu-law audio directly to the RTP sender (bypasses OpenAI). */
  sendAudio(mulawData: Buffer): void;
  /**
   * Ask Realtime to produce the opening turn based on session instructions.
   * Used on outbound calls so the caller side speaks first.
   */
  triggerGreeting(): void;
  /** Callback when assistant produces a transcript. */
  onAssistantTranscript: ((text: string) => void) | null;
  /** Callback when user speech is transcribed. */
  onUserTranscript: ((text: string) => void) | null;
  /**
   * Fired when the model invokes the built-in end_call tool. The provider is
   * expected to hang up the call cleanly once this arrives.
   */
  onHangupRequested: (() => void) | null;
}

export function createRealtimeVoiceSession(
  config: RealtimeVoiceConfig,
  rtpReceiver: RtpReceiver,
  rtpSourcePromise: () => RtpSource | null,
): RealtimeVoiceSession {
  let ws: WebSocket | null = null;
  let sender: RtpSender | null = null;
  let stopped = false;
  let onAssistantTranscript: ((text: string) => void) | null = null;
  let onUserTranscript: ((text: string) => void) | null = null;
  let onHangupRequested: (() => void) | null = null;

  const silencePaddingMs = config.silencePaddingMs ?? 100;

  // Track which response ID was triggered by our speakText() call.
  // VAD auto-responses get different IDs — we only forward audio for ours.
  let ourResponseId: string | null = null;
  let pendingOurResponse = false; // set true by speakText, consumed by next response.created
  // Tracks whether OpenAI Realtime currently has a response in flight.
  // Used to skip response.cancel when there is nothing to cancel (avoids
  // "no active response found" warnings from the API on every VAD tick).
  let responseActive = false;
  // Timestamp (ms) until which barge-in is suppressed. Set by triggerGreeting
  // so that ring-down tones or initial callee noise don't cancel our opening
  // line mid-sentence, producing truncated/overlapping greetings.
  let suppressBargeUntil = 0;
  // Watchdog: if the assistant says goodbye but the model forgets to invoke
  // end_call in the same turn, we hang up 2.5s after the farewell transcript.
  let farewellHangupTimer: ReturnType<typeof setTimeout> | null = null;

  function isFarewell(text: string): boolean {
    const s = text.toLowerCase();
    return (
      s.includes("до свидания") ||
      s.includes("всего доброго") ||
      s.includes("хорошего дня") ||
      s.includes("goodbye") ||
      s.includes("bye bye")
    );
  }

  function scheduleFarewellHangup(): void {
    if (farewellHangupTimer) return;
    farewellHangupTimer = setTimeout(() => {
      farewellHangupTimer = null;
      console.log("[asterisk-realtime] farewell watchdog: invoking hangup");
      if (onHangupRequested) onHangupRequested();
    }, 2500);
  }

  let handleMessage = (data: string): void => {
    let event: {
      type: string;
      delta?: string;
      transcript?: string;
      item?: { role?: string; id?: string };
      response?: { id?: string };
      response_id?: string;
      error?: { message?: string };
      name?: string;
      call_id?: string;
      arguments?: string;
    };
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }

    switch (event.type) {
      case "session.created":
      case "session.updated":
        break;

      case "response.created": {
        const rid = event.response?.id ?? "";
        responseActive = true;
        if (pendingOurResponse) {
          ourResponseId = rid;
          pendingOurResponse = false;
        }
        break;
      }

      case "conversation.item.created":
        // Barge-in: user started speaking → stop assistant playback
        if (event.item?.role === "user" && sender) {
          sender.stopPlayback();
          ourResponseId = null;
        }
        break;

      case "input_audio_buffer.speech_started":
        // Early barge-in: VAD just detected speech start. Flush buffered TTS
        // frames and cancel any in-flight response so the user isn't talked over.
        //
        // Skip cancellation during the greeting grace window — the line often
        // has ring-down tones or a reply like "Алло" that would otherwise
        // interrupt our opening sentence mid-word.
        if (Date.now() < suppressBargeUntil) {
          break;
        }
        if (sender) sender.stopPlayback();
        if (responseActive && ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "response.cancel" }));
          responseActive = false;
        }
        break;

      case "response.audio.delta": {
        // Forward audio for every response. Session is configured per-call with
        // task-specific instructions so VAD auto-responses are the correct reply.
        if (event.delta && sender) {
          const audio = Buffer.from(event.delta, "base64");
          if (audio.length > 0) {
            sender.send(audio);
          }
        }
        break;
      }

      case "response.audio_transcript.done":
        if (event.transcript && onAssistantTranscript) {
          onAssistantTranscript(event.transcript);
        }
        // Safety net: if the assistant said a farewell but the model forgot to
        // invoke end_call in the same turn, hang up after a short delay so the
        // caller doesn't sit on dead air waiting for acknowledgement.
        if (event.transcript && isFarewell(event.transcript)) {
          scheduleFarewellHangup();
        }
        break;

      case "conversation.item.input_audio_transcription.completed":
        if (event.transcript && onUserTranscript) {
          onUserTranscript(event.transcript);
        }
        break;

      case "response.function_call_arguments.done":
        // Built-in tool dispatch. Currently the only tool registered is end_call,
        // which the model invokes after saying goodbye to hang up cleanly.
        if (event.name === "end_call") {
          console.log("[asterisk-realtime] end_call tool invoked — hanging up");
          if (farewellHangupTimer) {
            clearTimeout(farewellHangupTimer);
            farewellHangupTimer = null;
          }
          if (onHangupRequested) onHangupRequested();
        } else {
          console.warn(`[asterisk-realtime] unknown tool call: ${event.name ?? "(no name)"}`);
        }
        break;

      case "response.audio.done":
      case "response.done": {
        const doneRid = event.response_id ?? (event.response as { id?: string } | undefined)?.id ?? "";
        if (doneRid === ourResponseId) {
          ourResponseId = null;
        }
        if (event.type === "response.done") {
          responseActive = false;
        }
        break;
      }

      case "error":
        console.error("[asterisk-realtime] OpenAI error:", event.error?.message);
        break;
    }
  };

  return {
    get onAssistantTranscript() {
      return onAssistantTranscript;
    },
    set onAssistantTranscript(v) {
      onAssistantTranscript = v;
    },
    get onHangupRequested() {
      return onHangupRequested;
    },
    set onHangupRequested(v) {
      onHangupRequested = v;
    },
    get onUserTranscript() {
      return onUserTranscript;
    },
    set onUserTranscript(v) {
      onUserTranscript = v;
    },

    speakText(text: string): void {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.warn("[asterisk-realtime] Cannot speak: WS not open");
        return;
      }
      // Stop any current playback first
      if (sender) sender.stopPlayback();

      // Mark that the NEXT response.created is ours
      pendingOurResponse = true;

      // Use per-response instructions to make the model speak the exact text.
      // Sending as role:"user" + response.create causes the model to RESPOND to
      // the text instead of reading it verbatim. Per-response instructions override
      // session instructions and directly tell the model what to say.
      ws.send(JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions: `Say the following text exactly, word for word, without any changes, additions, or interpretation. Do not respond to it, just read it aloud:\n\n${text}`,
          output_audio_format: "g711_ulaw",
        },
      }));
      console.log(`[asterisk-realtime] speakText: "${text.slice(0, 80)}"`);
    },

    sendAudio(mulawData: Buffer): void {
      if (sender) {
        sender.stopPlayback();
        sender.send(mulawData);
        console.log(`[asterisk-realtime] sendAudio: ${mulawData.length} bytes via RTP`);
      } else {
        // Sender not ready yet — try to create it now
        const src = rtpSourcePromise();
        if (src) {
          sender = createRtpSender(src);
          sender.send(mulawData);
          console.log(`[asterisk-realtime] sendAudio: created sender, ${mulawData.length} bytes`);
        } else {
          console.warn("[asterisk-realtime] sendAudio: no RTP source, audio dropped");
        }
      }
    },

    triggerGreeting(): void {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.warn("[asterisk-realtime] Cannot trigger greeting: WS not open");
        return;
      }
      // Grace window: ignore VAD-triggered barge-in for 4s so ring-down tones
      // or a brief initial hello don't cancel our opening sentence midway.
      suppressBargeUntil = Date.now() + 4000;
      // Inject an explicit "phone just connected, speak NOW" cue. Without this,
      // the model occasionally emits stage-direction text like "(waiting)"
      // instead of an actual greeting, since a bare response.create with no
      // user turn leaves the situation ambiguous.
      ws.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "system",
          content: [{
            type: "input_text",
            text:
              "The phone just connected. Say the first spoken line now: a short greeting plus the task request. " +
              "Use the same language as the task instructions. One phrase, up to 12 words. " +
              "No pauses, no waiting, no parenthetical stage directions.",
          }],
        },
      }));
      ws.send(JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          output_audio_format: "g711_ulaw",
          instructions:
            "Speak now: ONE short phrase, greeting plus the request from the task. " +
            "Use the same language as the task instructions. " +
            "No parentheses, no stage directions, no narration of your own actions. " +
            "Only the spoken words the callee should hear.",
        },
      }));
      console.log("[asterisk-realtime] triggerGreeting sent (with explicit speak-now cue)");
    },

    async start(): Promise<void> {
      if (stopped) return;

      const url = `wss://api.openai.com/v1/realtime?model=${config.model ?? "gpt-realtime-1.5"}`;
      ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "OpenAI-Beta": "realtime=v1",
        },
      });

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("OpenAI Realtime connection timeout")), 10_000);

        ws!.on("open", () => {
          clearTimeout(timeout);
          console.log("[asterisk-realtime] OpenAI Realtime connected");

          // Configure session with server_vad for quality STT.
          // VAD will auto-trigger responses, but we filter them in handleMessage —
          // only audio from our speakText() calls (ourResponseActive=true) is sent to RTP.
          ws!.send(
            JSON.stringify({
              type: "session.update",
              session: {
                modalities: ["audio", "text"],
                voice: config.voice ?? "coral",
                instructions: config.systemPrompt,
                input_audio_format: "g711_ulaw",
                output_audio_format: "g711_ulaw",
                input_audio_transcription: { model: "gpt-4o-transcribe", language: "ru" },
                turn_detection: {
                  type: "server_vad",
                  threshold: config.vadThreshold ?? 0.5,
                  prefix_padding_ms: config.vadPrefixPaddingMs ?? 200,
                  silence_duration_ms: config.vadSilenceDurationMs ?? 300,
                  // Realtime auto-responds after each user turn only in
                  // end-to-end mode. For notify/outbound where OpenClaw
                  // renders the message via TTS API itself, disable this —
                  // otherwise Realtime talks over our pre-recorded line.
                  create_response: config.autoRespond ?? true,
                },
                tools: [
                  {
                    type: "function",
                    name: "end_call",
                    description:
                      "Call when the phone conversation is complete and you have already said goodbye. This hangs up the line. Invoke after your farewell reply, not before.",
                    parameters: {
                      type: "object",
                      properties: {
                        reason: {
                          type: "string",
                          description:
                            "Short internal note: 'done' if task completed, 'cannot_help' if callee refused, 'dead_end' otherwise.",
                        },
                      },
                      required: [],
                    },
                  },
                ],
                tool_choice: "auto",
              },
            }),
          );

          // No initial message — OpenClaw agent handles the greeting via playTts
          if (config.initialMessage) {
            ws!.send(
              JSON.stringify({
                type: "conversation.item.create",
                item: {
                  type: "message",
                  role: "user",
                  content: [{ type: "input_text", text: config.initialMessage }],
                },
              }),
            );
            ws!.send(
              JSON.stringify({
                type: "response.create",
                response: {
                  modalities: ["audio", "text"],
                  output_audio_format: "g711_ulaw",
                },
              }),
            );
          }

          resolve();
        });

        ws!.on("error", (err) => {
          clearTimeout(timeout);
          console.error("[asterisk-realtime] WS error:", (err as Error).message);
          reject(err);
        });
      });

      // Buffer audio deltas until sender is ready
      let pendingAudio: Buffer[] = [];

      // Wire RTP receiver → OpenAI (user audio in)
      rtpReceiver.onAudio = (mulawPayload: Buffer) => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "input_audio_buffer.append",
            audio: mulawPayload.toString("base64"),
          }));
        }

        // Create sender once we know the RTP source address
        if (!sender) {
          const src = rtpSourcePromise();
          if (src) {
            console.log(`[asterisk-realtime] RTP source discovered: ${src.address}:${src.port}`);
            sender = createRtpSender(src);
            sender.send(createSilenceBuffer(silencePaddingMs));
            // Flush any buffered audio
            for (const buf of pendingAudio) {
              sender.send(buf);
            }
            pendingAudio = [];
          }
        }
      };

      // Wire OpenAI → RTP sender (assistant audio out)
      // Override handleMessage to buffer audio if sender not ready
      const origHandleMessage = handleMessage;
      handleMessage = (data: string) => {
        // Intercept audio deltas to buffer if sender not ready
        try {
          const event = JSON.parse(data);
          if (event.type === "response.audio.delta" && event.delta && !sender) {
            const audio = Buffer.from(event.delta, "base64");
            if (audio.length > 0) {
              pendingAudio.push(audio);
            }
            return;
          }
        } catch {
          // fall through to original handler
        }
        origHandleMessage(data);
      };

      ws.on("message", (data: Buffer | string) => {
        if (stopped) return;
        handleMessage(data.toString());
      });

      ws.on("close", () => {
        console.log("[asterisk-realtime] OpenAI WS closed");
      });
    },

    stop(): void {
      stopped = true;
      rtpReceiver.onAudio = null;
      if (farewellHangupTimer) {
        clearTimeout(farewellHangupTimer);
        farewellHangupTimer = null;
      }
      if (ws) {
        try {
          ws.close();
        } catch {
          // ignore
        }
        ws = null;
      }
      if (sender) {
        sender.close();
        sender = null;
      }
    },
  };
}
