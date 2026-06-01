/**
 * OpenAI Realtime voice session for Asterisk.
 *
 * Full-duplex audio: receives mu-law from RTP receiver, sends to OpenAI,
 * receives audio deltas back, forwards to RTP sender.
 * Supports barge-in (user speech interrupts assistant playback).
 */

import crypto from "node:crypto";
import WebSocket from "ws";
import { DEFAULT_ASTERISK_REALTIME_MODEL } from "../config.js";
import type { RecordedCallOutcome } from "../types.js";
import type { RtpReceiver, RtpSender, RtpSource } from "./asterisk-rtp.js";
import { createRtpSender, createSilenceBuffer } from "./asterisk-rtp.js";

const REALTIME_PROMPT_VERSION = "caller-general-task-state-machine-2026-05-15";
const DEBUG_ENDPOINT = "http://127.0.0.1:7840/ingest/25173012-99ac-4a06-ad7b-e7904e61d643";
const DEBUG_SESSION_ID = "c8a2b2";

function promptHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function agentDebugLog(payload: {
  runId: string;
  hypothesisId: string;
  location: string;
  message: string;
  data: Record<string, unknown>;
}): void {
  fetch(DEBUG_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": DEBUG_SESSION_ID,
    },
    body: JSON.stringify({
      sessionId: DEBUG_SESSION_ID,
      timestamp: Date.now(),
      ...payload,
    }),
  }).catch(() => {});
}

/** GA Realtime rejects the legacy beta `session.update` + `OpenAI-Beta: realtime=v1` combo. */
function isGaRealtimeModelId(model: string): boolean {
  return model.trim().toLowerCase().startsWith("gpt-realtime-2");
}

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
  /** If set, passed to Realtime input_audio_transcription.language (e.g. "ru"). Omit for auto / multilingual. */
  inputAudioTranscriptionLanguage?: string;
  /** Optional STT model id (default gpt-4o-transcribe). */
  inputAudioTranscriptionModel?: string;
  /** Optional vocabulary hint for the transcription model (venue names, jargon). */
  inputAudioTranscriptionPrompt?: string;
}

/**
 * Structured result the Realtime agent records via the outcome_summary tool.
 * Kept as an alias of the shared RecordedCallOutcome so provider plumbing
 * (asterisk.ts, multi-asterisk.ts) and the voice_call tool result stay in sync.
 *   - "done"        — task fully completed (booking made, info obtained, message delivered)
 *   - "partial"     — partial result (alt slot, partial answer, callee proposed something)
 *   - "no_result"   — clear no/refusal/closed/wrong number
 *   - "voicemail"   — answering machine / IVR / no human
 *   - "unclear"     — ended without clear outcome
 */
export type RealtimeOutcome = RecordedCallOutcome;

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
  /** Fired whenever the model writes/updates an outcome via outcome_summary. */
  onOutcomeRecorded: ((outcome: RealtimeOutcome) => void) | null;
  /** Latest outcome the model recorded for this call, if any. */
  getLastOutcome(): RealtimeOutcome | null;
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
  let onOutcomeRecorded: ((outcome: RealtimeOutcome) => void) | null = null;
  let lastOutcome: RealtimeOutcome | null = null;

  const silencePaddingMs = config.silencePaddingMs ?? 100;
  /** Set in `start()` before the socket opens; used by `speakText` / `triggerGreeting`. */
  let wireFormat: "beta" | "ga" = "beta";

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
  // Post-outcome watchdog: GA Realtime wire ends the response immediately after
  // a function tool call, so the model often records outcome_summary and then
  // goes silent. We force a deterministic farewell+hangup if no further speech
  // happens within 5s of outcome being recorded.
  let postOutcomeWatchdog: ReturnType<typeof setTimeout> | null = null;
  // VOICE-08: Absolute wall-clock duration kill (true runaway guard).
  // This timer force-closes the Realtime WS + RTP sender and requests ARI hangup
  // on wall-clock alone, independent of any ARI event or farewell watchdog.
  // It fires even if the ARI event stream has wedged and staleCallReaper is starved.
  // Default: config.maxDurationSeconds (300s). Cleared in stop() to prevent a
  // late hangup after a normal call end.
  let absoluteKillTimer: ReturnType<typeof setTimeout> | null = null;
  /** Callee produced at least one non-empty final STT line. */
  let calleeHeardUtterance = false;
  /** Assistant `response.audio_transcript.done` events with non-empty text (per session). */
  let assistantAudioTranscriptDoneCount = 0;
  /** Last assistant transcript text — gates premature end_call hangup. */
  let lastAssistantTranscript = "";
  /** Debug timings for hang diagnosis. */
  let lastSpeakTextAt = 0;
  let lastUserTranscriptAt = 0;
  let currentResponseCreatedAt = 0;
  let firstAudioDeltaLoggedForCurrentResponse = false;
  let bufferedAudioLogged = false;

  function isFarewell(text: string): boolean {
    const s = text.toLowerCase();
    // Do not match bare "хорошего дня" — it appears in polite greetings
    // ("желаю хорошего дня") and used to trigger the farewell watchdog wrongly.
    return (
      s.includes("до свидания") ||
      s.includes("всего доброго") ||
      s.includes("goodbye") ||
      s.includes("bye bye")
    );
  }

  function scheduleFarewellHangup(): void {
    if (farewellHangupTimer) return;
    // Without a recorded outcome the user in Telegram learns nothing about how
    // the call ended. Refuse to auto-hang up in that case — let the model
    // either record outcome_summary and invoke end_call itself, or keep the
    // line open for a follow-up turn. This stops the most common false
    // positive: callee says "до свидания, не интересно" → bot mirrors farewell
    // → watchdog ends the call before any outcome is captured.
    if (!lastOutcome) {
      console.log(
        "[asterisk-realtime] farewell watchdog: skipped (no outcome_summary recorded yet)",
      );
      return;
    }
    farewellHangupTimer = setTimeout(() => {
      farewellHangupTimer = null;
      console.log("[asterisk-realtime] farewell watchdog: invoking hangup");
      if (onHangupRequested) onHangupRequested();
    }, 4000);
  }

  function clearPostOutcomeWatchdog(): void {
    if (postOutcomeWatchdog) {
      clearTimeout(postOutcomeWatchdog);
      postOutcomeWatchdog = null;
    }
  }

  function schedulePostOutcomeWatchdog(): void {
    if (postOutcomeWatchdog) return;
    postOutcomeWatchdog = setTimeout(() => {
      postOutcomeWatchdog = null;
      if (!lastOutcome) return;
      if (isFarewell(lastAssistantTranscript)) {
        // Model already said goodbye; existing farewell watchdog handles hangup.
        return;
      }
      console.log(
        "[asterisk-realtime] post-outcome watchdog: model silent after outcome_summary, forcing farewell + hangup",
      );
      try {
        speakText("Спасибо, до свидания.");
      } catch (err) {
        console.warn("[asterisk-realtime] post-outcome forced speakText failed", err);
      }
      // Give the forced farewell ~2s to render through RTP before tearing the
      // call down. This is shorter than scheduleFarewellHangup's 4s because we
      // already know the call is done — no follow-up turn is expected.
      setTimeout(() => {
        if (onHangupRequested) onHangupRequested();
      }, 2200);
    }, 5000);
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
        currentResponseCreatedAt = Date.now();
        firstAudioDeltaLoggedForCurrentResponse = false;
        // #region agent log
        agentDebugLog({
          runId: "hang-debug-2026-05-15",
          hypothesisId: "H1-response-created-late",
          location: "asterisk-realtime.ts:response.created",
          message: "Realtime response created",
          data: {
            rid,
            pendingOurResponse,
            msSinceSpeakText: lastSpeakTextAt ? currentResponseCreatedAt - lastSpeakTextAt : null,
            msSinceUserTranscript: lastUserTranscriptAt
              ? currentResponseCreatedAt - lastUserTranscriptAt
              : null,
          },
        });
        // #endregion
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
        // #region agent log
        console.log(
          `[agent-debug][H17] speech_started: ` +
            JSON.stringify({
              now: Date.now(),
              suppressBargeUntil,
              suppressed: Date.now() < suppressBargeUntil,
              responseActive,
            }),
        );
        // #endregion
        if (Date.now() < suppressBargeUntil) {
          break;
        }
        if (sender) sender.stopPlayback();
        if (responseActive && ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "response.cancel" }));
          responseActive = false;
        }
        break;

      // Newer Realtime models (e.g. gpt-realtime-2) emit response.output_audio.*;
      // older stacks used response.audio.* — handle both so RTP is not silent.
      case "response.audio.delta":
      case "response.output_audio.delta": {
        if (!firstAudioDeltaLoggedForCurrentResponse) {
          firstAudioDeltaLoggedForCurrentResponse = true;
          // #region agent log
          agentDebugLog({
            runId: "hang-debug-2026-05-15",
            hypothesisId: "H2-audio-delta-delayed",
            location: "asterisk-realtime.ts:response.audio.delta",
            message: "First assistant audio delta for response",
            data: {
              senderReady: Boolean(sender),
              msSinceResponseCreated: currentResponseCreatedAt
                ? Date.now() - currentResponseCreatedAt
                : null,
            },
          });
          // #endregion
        }
        // Forward audio for every response. Session is configured per-call with
        // task-specific instructions so VAD auto-responses are the correct reply.
        if (event.delta && sender) {
          const audio = Buffer.from(event.delta, "base64");
          if (audio.length > 0) {
            sender.send(audio);
            // While assistant audio streams, brief line noise / callee breath can
            // trigger input_audio_buffer.speech_started → response.cancel and cut
            // the bot mid-sentence. Extend barge-in suppression on each chunk.
            suppressBargeUntil = Math.max(suppressBargeUntil, Date.now() + 900);
          }
        }
        break;
      }

      case "response.audio_transcript.done":
      case "response.output_audio_transcript.done":
        if (event.transcript) {
          assistantAudioTranscriptDoneCount += 1;
          lastAssistantTranscript = event.transcript;
          // #region agent log
          if (assistantAudioTranscriptDoneCount <= 2) {
            const lower = event.transcript.toLowerCase();
            console.log(
              `[agent-debug][H4] early assistant transcript: ` +
                JSON.stringify({
                  runId: "prompt-state-machine-v2",
                  idx: assistantAudioTranscriptDoneCount,
                  hasReceptionistPhrase:
                    lower.includes("чем могу помочь") ||
                    lower.includes("чем могу быть полез") ||
                    lower.includes("слушаю вас"),
                  hasPermissionOpening:
                    lower.includes("можно спросить") ||
                    lower.includes("можно коротко") ||
                    lower.includes("можно уточнить"),
                  text: event.transcript.slice(0, 160),
                }),
            );
          }
          // #endregion
        }
        if (event.transcript && onAssistantTranscript) {
          onAssistantTranscript(event.transcript);
        }
        // Safety net: if the assistant said a farewell but the model forgot to
        // invoke end_call in the same turn, hang up after a short delay so the
        // caller doesn't sit on dead air waiting for acknowledgement.
        //
        // Gate: do not arm on the very first assistant line alone — some models
        // briefly mis-speak or STT echoes can contain "goodbye"-like substrings
        // before any callee speech; real goodbyes happen after the callee spoke
        // or on the 2nd+ assistant turn.
        if (
          event.transcript &&
          isFarewell(event.transcript) &&
          (calleeHeardUtterance || assistantAudioTranscriptDoneCount >= 2)
        ) {
          scheduleFarewellHangup();
        }
        break;

      case "conversation.item.input_audio_transcription.completed":
        lastUserTranscriptAt = Date.now();
        // #region agent log
        agentDebugLog({
          runId: "hang-debug-2026-05-15",
          hypothesisId: "H3-user-turn-no-followup",
          location: "asterisk-realtime.ts:user-transcription.completed",
          message: "User transcription completed",
          data: {
            hasTranscript: Boolean((event.transcript ?? "").trim()),
            transcriptPreview: (event.transcript ?? "").slice(0, 120),
            responseActive,
          },
        });
        // #endregion
        // #region agent log
        console.log(
          `[agent-debug][H18] user transcription completed: ` +
            JSON.stringify({
              hasTranscript: Boolean((event.transcript ?? "").trim()),
              transcriptPreview: (event.transcript ?? "").slice(0, 120),
            }),
        );
        // #endregion
        if ((event.transcript ?? "").trim()) {
          calleeHeardUtterance = true;
        }
        if (event.transcript && onUserTranscript) {
          onUserTranscript(event.transcript);
        }
        break;

      case "response.function_call_arguments.done":
        // Built-in tool dispatch. Two tools are registered:
        //   - outcome_summary: model records structured result before hangup
        //   - end_call:        model hangs up after saying goodbye
        if (event.name === "outcome_summary") {
          let parsed: { status?: string; summary?: string; details?: string } = {};
          try {
            parsed = JSON.parse(event.arguments ?? "{}");
          } catch {
            parsed = {};
          }
          const statusRaw = String(parsed.status ?? "").trim().toLowerCase();
          const statusAllowed: RealtimeOutcome["status"][] = [
            "done",
            "partial",
            "no_result",
            "voicemail",
            "unclear",
          ];
          const status = (
            statusAllowed.includes(statusRaw as RealtimeOutcome["status"])
              ? statusRaw
              : "unclear"
          ) as RealtimeOutcome["status"];
          const summary = String(parsed.summary ?? "").trim();
          const details =
            typeof parsed.details === "string" && parsed.details.trim()
              ? parsed.details.trim()
              : undefined;
          lastOutcome = {
            status,
            summary: summary || "(no summary)",
            details,
            recordedAt: Date.now(),
          };
          console.log(
            `[asterisk-realtime] outcome_summary recorded: status=${status} summary=${lastOutcome.summary.slice(0, 160)}`,
          );
          if (onOutcomeRecorded) onOutcomeRecorded(lastOutcome);
          schedulePostOutcomeWatchdog();
          if (ws && ws.readyState === WebSocket.OPEN) {
            const callId = event.call_id ?? "";
            ws.send(
              JSON.stringify({
                type: "conversation.item.create",
                item: {
                  type: "function_call_output",
                  call_id: callId,
                  output: JSON.stringify({ ok: true, recorded: true }),
                },
              }),
            );
          }
          break;
        }
        if (event.name === "end_call") {
          // Premature-hangup guard: the model sometimes calls end_call after the
          // FIRST callee reply even when the task isn't resolved (e.g. the user
          // proposed an alternative and the bot just hangs up).
          // Require: assistant spoke at least 2 turns (greeting + ≥1 follow-up)
          // AND the LAST assistant turn was an actual farewell phrase.
          const lastWasFarewell = isFarewell(lastAssistantTranscript);
          const okToEnd = assistantAudioTranscriptDoneCount >= 2 && lastWasFarewell;
          // #region agent log
          agentDebugLog({
            runId: "voice-ux-2026-05-15",
            hypothesisId: "H-end-call-premature",
            location: "asterisk-realtime.ts:response.function_call_arguments.done",
            message: "end_call invoked",
            data: {
              okToEnd,
              assistantTurns: assistantAudioTranscriptDoneCount,
              calleeHeardUtterance,
              lastAssistantPreview: lastAssistantTranscript.slice(0, 160),
              modelReason: (event.arguments ?? "").slice(0, 200),
            },
          });
          // #endregion
          if (!okToEnd) {
            console.warn(
              `[asterisk-realtime] end_call REJECTED (premature): assistantTurns=${assistantAudioTranscriptDoneCount} lastWasFarewell=${lastWasFarewell} calleeHeard=${calleeHeardUtterance}`,
            );
            if (ws && ws.readyState === WebSocket.OPEN) {
              const callId = event.call_id ?? "";
              ws.send(
                JSON.stringify({
                  type: "conversation.item.create",
                  item: {
                    type: "function_call_output",
                    call_id: callId,
                    output: JSON.stringify({
                      ok: false,
                      error:
                        "Too early to end the call. The callee has not yet given a final answer. First respond to their last reply, ask one short clarifying question or accept the closest available option, and only call end_call AFTER you actually said goodbye out loud.",
                    }),
                  },
                }),
              );
              if (wireFormat === "ga") {
                ws.send(
                  JSON.stringify({
                    type: "response.create",
                    response: {
                      output_modalities: ["audio"],
                      audio: { output: { format: { type: "audio/pcmu" } } },
                      instructions:
                        "Continue the call. Respond to the callee's last reply in their language: either accept the closest available option, ask one short clarifying question, or briefly say you'll need to check. Do NOT say goodbye yet.",
                    },
                  }),
                );
              } else {
                ws.send(
                  JSON.stringify({
                    type: "response.create",
                    response: {
                      modalities: ["audio", "text"],
                      output_audio_format: "g711_ulaw",
                      instructions:
                        "Continue the call. Respond to the callee's last reply in their language: either accept the closest available option, ask one short clarifying question, or briefly say you'll need to check. Do NOT say goodbye yet.",
                    },
                  }),
                );
              }
            }
            break;
          }
          console.log("[asterisk-realtime] end_call tool invoked — hanging up");
          if (farewellHangupTimer) {
            clearTimeout(farewellHangupTimer);
            farewellHangupTimer = null;
          }
          clearPostOutcomeWatchdog();
          if (onHangupRequested) onHangupRequested();
        } else {
          console.warn(`[asterisk-realtime] unknown tool call: ${event.name ?? "(no name)"}`);
        }
        break;

      case "response.audio.done":
      case "response.output_audio.done":
      case "response.done": {
        const doneRid =
          event.response_id ?? (event.response as { id?: string } | undefined)?.id ?? "";
        if (doneRid === ourResponseId) {
          ourResponseId = null;
        }
        if (event.type === "response.done" || event.type === "response.output_audio.done") {
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
    get onOutcomeRecorded() {
      return onOutcomeRecorded;
    },
    set onOutcomeRecorded(v) {
      onOutcomeRecorded = v;
    },
    getLastOutcome(): RealtimeOutcome | null {
      return lastOutcome;
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
      lastSpeakTextAt = Date.now();
      // Mirror the grace window that triggerGreeting() uses: while WE are
      // producing a verbatim response, VAD on ring-down tones / callee "Алло"
      // must not fire response.cancel and silence us mid-sentence. This race
      // is also what made the model occasionally ad-lib a receptionist-style
      // opener instead of reading the task's opening line.
      suppressBargeUntil = Math.max(suppressBargeUntil, Date.now() + 5500);
      // #region agent log
      agentDebugLog({
        runId: "hang-debug-2026-05-15",
        hypothesisId: "H1-response-created-late",
        location: "asterisk-realtime.ts:speakText",
        message: "speakText requested",
        data: {
          textLength: text.length,
          responseActive,
        },
      });
      // #endregion

      // Use per-response instructions to make the model speak the exact text.
      // Sending as role:"user" + response.create causes the model to RESPOND to
      // the text instead of reading it verbatim. Per-response instructions override
      // session instructions and directly tell the model what to say.
      //
      // The explicit "do NOT play receptionist" lines exist because we have
      // seen the model open with «я ассистент Темирлана, чем могу помочь» —
      // it slips into the call-recipient role when the verbatim text is short
      // and the session prompt is long.
      const readAloudInstructions =
        "Read the text below ALOUD, exactly, word for word, without changes, additions, prefixes, or interpretation. " +
        "Do NOT add a greeting that isn't already in the text. " +
        "Do NOT introduce yourself as an assistant. " +
        "Do NOT offer help, do NOT ask «чем могу помочь», do NOT ask what to convey. " +
        "You are the outbound caller stating a request — never the receptionist who picked up.\n\n" +
        text;
      if (wireFormat === "ga") {
        ws.send(
          JSON.stringify({
            type: "response.create",
            response: {
              output_modalities: ["audio"],
              audio: {
                output: {
                  format: { type: "audio/pcmu" },
                },
              },
              instructions: readAloudInstructions,
              // The opening turn must never invoke end_call. Tool dispatch in
              // the very first response was the source of one premature-hangup
              // class — pin it off until the conversation actually starts.
              tool_choice: "none",
            },
          }),
        );
      } else {
        ws.send(
          JSON.stringify({
            type: "response.create",
            response: {
              modalities: ["audio", "text"],
              instructions: readAloudInstructions,
              output_audio_format: "g711_ulaw",
              tool_choice: "none",
            },
          }),
        );
      }
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
      // Grace window: ignore VAD-triggered barge-in for ~5.5s so ring-down tones
      // or a brief initial hello don't cancel our opening sentence midway.
      suppressBargeUntil = Date.now() + 5500;
      // Opening language: English-only trigger cues ("same language as task")
      // made the model sometimes pick Spanish. When instructions contain Cyrillic,
      // pin the first line to Russian; otherwise follow the task language.
      const taskLooksRussian = /task_language_hint:\s*ru/.test(config.systemPrompt);
      // #region agent log
      console.log(
        `[agent-debug][H2] triggerGreeting language decision: ` +
          JSON.stringify({
            runId: "prompt-state-machine-v2",
            taskLooksRussian,
            hasHintRu: /task_language_hint:\s*ru/.test(config.systemPrompt),
            hasHintAuto: /task_language_hint:\s*auto/.test(config.systemPrompt),
            promptVersion: REALTIME_PROMPT_VERSION,
          }),
      );
      // #endregion
      const openingLanguageRule = taskLooksRussian
        ? "The task is in Russian. The first spoken turn must be Russian. Use this shape: «Здравствуйте. [specific request from the task].» You are the caller with a request; do not sound like the person answering the phone."
        : "Use the task language. First spoken turn shape: greeting plus the specific request from the task. You are the caller with a request; do not sound like the person answering the phone.";
      const systemCue =
        "The callee has picked up. Start state: opening. Speak the opening line now: greeting plus the concrete request from the task. " +
        openingLanguageRule +
        " One short conversational sentence is best; use two only if the task needs it. No pauses, no waiting, no parenthetical stage directions.";
      const greetingResponseInstructions =
        "Speak now as the outbound caller. Say only the opening turn: greeting plus the request from the task. " +
        openingLanguageRule +
        " No parentheses, no stage directions, no narration of your own actions. " +
        "Only the spoken words the callee should hear.";
      // #region agent log
      agentDebugLog({
        runId: "prompt-state-machine-v1",
        hypothesisId: "H2-opening-cue-weak",
        location: "asterisk-realtime.ts:triggerGreeting",
        message: "Realtime opening cue emitted",
        data: {
          promptVersion: REALTIME_PROMPT_VERSION,
          promptHash: promptHash(config.systemPrompt),
          taskLooksRussian,
          hasStateMachine: config.systemPrompt.includes("state: opening"),
          hasReceptionistBoundary: config.systemPrompt.includes("чем могу помочь"),
        },
      });
      // #endregion
      if (wireFormat === "ga") {
        ws.send(
          JSON.stringify({
            type: "response.create",
            response: {
              output_modalities: ["audio"],
              audio: {
                output: {
                  format: { type: "audio/pcmu" },
                },
              },
              instructions: `${systemCue}\n\n${greetingResponseInstructions}`,
              tool_choice: "none",
            },
          }),
        );
      } else {
        ws.send(
          JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "system",
              content: [
                {
                  type: "input_text",
                  text: systemCue,
                },
              ],
            },
          }),
        );
        ws.send(
          JSON.stringify({
            type: "response.create",
            response: {
              modalities: ["audio", "text"],
              output_audio_format: "g711_ulaw",
              instructions: greetingResponseInstructions,
              tool_choice: "none",
            },
          }),
        );
      }
      console.log("[asterisk-realtime] triggerGreeting sent (with explicit speak-now cue)");
    },

    async start(): Promise<void> {
      if (stopped) return;

      const realtimeModel = config.model ?? DEFAULT_ASTERISK_REALTIME_MODEL;
      wireFormat = isGaRealtimeModelId(realtimeModel) ? "ga" : "beta";
      const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(realtimeModel)}`;
      const wsHeaders: Record<string, string> = {
        Authorization: `Bearer ${config.apiKey}`,
      };
      // Beta: flat `session.*` + `g711_ulaw` + `OpenAI-Beta: realtime=v1`.
      // GA (`gpt-realtime-2*`): nested `session.audio`, μ-law as `{ type: "audio/pcmu" }`, no beta header.
      if (wireFormat === "beta") {
        wsHeaders["OpenAI-Beta"] = "realtime=v1";
      }
      console.log(`[asterisk-realtime] connecting Realtime wire=${wireFormat} model=${realtimeModel}`);
      ws = new WebSocket(url, { headers: wsHeaders });

      // VOICE-08: Absolute wall-clock duration kill.
      // Set immediately when the WS is created (not just when it opens) so the timer
      // starts from the call attempt, not from the first audio frame.
      // Fires even if ARI events wedge or the farewell/outcome watchdogs are suppressed.
      // Cleared in stop() so a normal call end does not produce a late hangup.
      const maxDurMs = (config.maxDurationSeconds ?? 300) * 1000;
      absoluteKillTimer = setTimeout(() => {
        absoluteKillTimer = null;
        if (!stopped) {
          console.warn(
            `[asterisk-realtime] VOICE-08 absolute duration kill fired after ${config.maxDurationSeconds ?? 300}s — force-closing WS + requesting hangup`,
          );
          // Force-close directly (mirrors stop() closure operations).
          stopped = true;
          rtpReceiver.onAudio = null;
          if (farewellHangupTimer) {
            clearTimeout(farewellHangupTimer);
            farewellHangupTimer = null;
          }
          clearPostOutcomeWatchdog();
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
          // Request ARI hangup so Asterisk tears down the channel.
          if (onHangupRequested) {
            onHangupRequested();
          }
        }
      }, maxDurMs);

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("OpenAI Realtime connection timeout")),
          25_000,
        );

        ws!.on("open", () => {
          clearTimeout(timeout);
          console.log("[asterisk-realtime] OpenAI Realtime connected");

          // Configure session with server_vad for quality STT.
          // VAD will auto-trigger responses, but we filter them in handleMessage —
          // only audio from our speakText() calls (ourResponseActive=true) is sent to RTP.
          const transcription: Record<string, string> = {
            model: config.inputAudioTranscriptionModel ?? "gpt-4o-transcribe",
          };
          const lang = (config.inputAudioTranscriptionLanguage ?? "").trim();
          if (lang) {
            transcription.language = lang;
          }
          const sttPrompt = (config.inputAudioTranscriptionPrompt ?? "").trim();
          if (sttPrompt) {
            transcription.prompt = sttPrompt;
          }

          const endCallTool = {
            type: "function" as const,
            name: "end_call",
            description:
              "Call when the phone conversation is complete and you have already said goodbye AND you have already recorded the result via outcome_summary. This hangs up the line. Invoke after your farewell reply, not before.",
            parameters: {
              type: "object",
              properties: {
                reason: {
                  type: "string",
                  description:
                    "Short internal note: 'done' if task completed, 'cannot_help' if callee refused, 'dead_end' otherwise.",
                },
              },
              required: [] as string[],
            },
          };

          const outcomeSummaryTool = {
            type: "function" as const,
            name: "outcome_summary",
            description:
              "REQUIRED before end_call. Record a structured summary of the call result so the user who requested the call can be informed. " +
              "Always call this with the concrete data you heard (times, prices, names, statuses, refusals). The user will not learn what happened unless you call this. " +
              "If new information arrives later in the same call, call it again — only the most recent invocation is kept.",
            parameters: {
              type: "object",
              properties: {
                status: {
                  type: "string",
                  enum: ["done", "partial", "no_result", "voicemail", "unclear"],
                  description:
                    "done = task fully completed; partial = partial/alternative result; no_result = clear no/refusal/closed/wrong number; voicemail = answering machine or IVR with no human; unclear = call ended without a clear outcome.",
                },
                summary: {
                  type: "string",
                  description:
                    "One short sentence in the same language as the user's original task. Concrete result the user needs to know (e.g. 'Booked for two at 21:30 instead of 20:30', 'Order #1234 ships Friday', 'Closed for the day, retry tomorrow').",
                },
                details: {
                  type: "string",
                  description:
                    "Optional follow-up: caller-side notes, suggested next step, alt time/price, or quoted phrase the callee used.",
                },
              },
              required: ["status", "summary"],
            },
          };

          // #region agent log
          agentDebugLog({
            runId: "prompt-state-machine-v1",
            hypothesisId: "H3-runtime-bundle-or-config-stale",
            location: "asterisk-realtime.ts:session.update",
            message: "Realtime session prompt version selected",
            data: {
              promptVersion: REALTIME_PROMPT_VERSION,
              promptHash: promptHash(config.systemPrompt),
              promptLength: config.systemPrompt.length,
              wireFormat,
              model: realtimeModel,
              voice: config.voice ?? "coral",
              autoRespond: config.autoRespond ?? true,
              hasStateMachine: config.systemPrompt.includes("state: opening"),
              hasCallerBoundary:
                config.systemPrompt.includes("You are the caller") ||
                config.systemPrompt.includes("Ты звонишь"),
            },
          });
          // #endregion

          if (wireFormat === "ga") {
            ws!.send(
              JSON.stringify({
                type: "session.update",
                session: {
                  type: "realtime",
                  model: realtimeModel,
                  instructions: config.systemPrompt,
                  output_modalities: ["audio"],
                  audio: {
                    input: {
                      format: { type: "audio/pcmu" },
                      transcription,
                      turn_detection: {
                        type: "server_vad",
                        threshold: config.vadThreshold ?? 0.5,
                        prefix_padding_ms: config.vadPrefixPaddingMs ?? 200,
                        silence_duration_ms: config.vadSilenceDurationMs ?? 300,
                        create_response: config.autoRespond ?? true,
                      },
                    },
                    output: {
                      format: { type: "audio/pcmu" },
                      voice: config.voice ?? "coral",
                    },
                  },
                  tools: [outcomeSummaryTool, endCallTool],
                  tool_choice: "auto",
                },
              }),
            );
          } else {
            ws!.send(
              JSON.stringify({
                type: "session.update",
                session: {
                  modalities: ["audio", "text"],
                  voice: config.voice ?? "coral",
                  instructions: config.systemPrompt,
                  input_audio_format: "g711_ulaw",
                  output_audio_format: "g711_ulaw",
                  input_audio_transcription: transcription,
                  turn_detection: {
                    type: "server_vad",
                    threshold: config.vadThreshold ?? 0.5,
                    prefix_padding_ms: config.vadPrefixPaddingMs ?? 200,
                    silence_duration_ms: config.vadSilenceDurationMs ?? 300,
                    create_response: config.autoRespond ?? true,
                  },
                  tools: [outcomeSummaryTool, endCallTool],
                  tool_choice: "auto",
                },
              }),
            );
          }

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
            if (wireFormat === "ga") {
              ws!.send(
                JSON.stringify({
                  type: "response.create",
                  response: {
                    output_modalities: ["audio"],
                    audio: {
                      output: {
                        format: { type: "audio/pcmu" },
                      },
                    },
                  },
                }),
              );
            } else {
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
          ws.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: mulawPayload.toString("base64"),
            }),
          );
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
          if (
            (event.type === "response.audio.delta" ||
              event.type === "response.output_audio.delta") &&
            event.delta &&
            !sender
          ) {
            const audio = Buffer.from(event.delta, "base64");
            if (audio.length > 0) {
              pendingAudio.push(audio);
              if (!bufferedAudioLogged) {
                bufferedAudioLogged = true;
                // #region agent log
                agentDebugLog({
                  runId: "hang-debug-2026-05-15",
                  hypothesisId: "H2-audio-buffering",
                  location: "asterisk-realtime.ts:buffer-audio-before-sender",
                  message: "Audio buffered before RTP sender is ready",
                  data: {
                    pendingAudioChunks: pendingAudio.length,
                    firstChunkBytes: audio.length,
                  },
                });
                // #endregion
              }
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
        console.log(
          `[asterisk-realtime] OpenAI WS closed ` +
            JSON.stringify({
              calleeHeardUtterance,
              assistantAudioTranscriptDoneCount,
              stopped,
            }),
        );
        // If the upstream Realtime socket dies on its own (rate limit, geo
        // block, transient network), the call would otherwise sit in dead air
        // until the telco timed out. Tear it down explicitly so OpenClaw at
        // least logs an end state.
        if (!stopped && onHangupRequested) {
          console.log(
            "[asterisk-realtime] unexpected WS close — requesting hangup",
          );
          try {
            onHangupRequested();
          } catch (err) {
            console.error(
              "[asterisk-realtime] onHangupRequested threw:",
              (err as Error).message,
            );
          }
        }
      });
    },

    stop(): void {
      stopped = true;
      rtpReceiver.onAudio = null;
      // VOICE-08: Clear the absolute kill timer on normal stop to prevent late hangup.
      if (absoluteKillTimer) {
        clearTimeout(absoluteKillTimer);
        absoluteKillTimer = null;
      }
      if (farewellHangupTimer) {
        clearTimeout(farewellHangupTimer);
        farewellHangupTimer = null;
      }
      clearPostOutcomeWatchdog();
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
