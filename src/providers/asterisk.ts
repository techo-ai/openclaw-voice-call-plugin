import crypto from "node:crypto";
import { appendFileSync } from "node:fs";
import { WebSocket } from "ws";
import type { AsteriskConfig } from "../config.js";
import { resamplePcmTo8k } from "../telephony-audio.js";
import type { TelephonyTtsProvider } from "../telephony-tts.js";
import type {
  GetCallStatusInput,
  GetCallStatusResult,
  HangupCallInput,
  InitiateCallInput,
  InitiateCallResult,
  NormalizedEvent,
  PlayTtsInput,
  ProviderWebhookParseResult,
  StartListeningInput,
  StopListeningInput,
  WebhookContext,
  WebhookVerificationResult,
} from "../types.js";
import {
  createRealtimeVoiceSession,
  type RealtimeVoiceConfig,
  type RealtimeVoiceSession,
} from "./asterisk-realtime.js";
import {
  allocateRtpPort,
  releaseRtpPort,
  startRtpReceiver,
  type RtpReceiver,
} from "./asterisk-rtp.js";
import type { VoiceCallProvider } from "./base.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AsteriskProviderOptions {
  /** Skip webhook verification (ARI uses WS auth, not webhook signatures) */
  skipVerification?: boolean;
}

const DEFAULT_INBOUND_GREETING = "Hello, this is the voice assistant. How can I help?";

const DEFAULT_INBOUND_SYSTEM_PROMPT = [
  "You are a helpful voice assistant answering an inbound phone call.",
  "Keep responses brief, natural, and conversational.",
  "Ask what the caller needs, collect the important details, and close politely.",
  "When the conversation is complete, say goodbye and call the `end_call` tool.",
].join("\n");

export type ResolvedAsteriskInboundProfile = {
  greeting: string;
  systemPrompt: string;
};

export function normalizeAsteriskCallerNumber(raw: string | undefined | null): string {
  const s = (raw ?? "").trim().replace(/^\+/, "");
  if (/^8\d{10}$/.test(s)) return "7" + s.slice(1);
  return s;
}

export function resolveAsteriskInboundProfile(
  config: Pick<AsteriskConfig, "inboundProfiles" | "realtimeSystemPrompt">,
  callerNumber: string | undefined | null,
  fallbackGreeting?: string,
): ResolvedAsteriskInboundProfile {
  const normalizedCaller = normalizeAsteriskCallerNumber(callerNumber);
  const profiles = config.inboundProfiles;
  const matched = profiles?.overrides?.find((override) =>
    override.callerNumbers.some(
      (candidate) => normalizeAsteriskCallerNumber(candidate) === normalizedCaller,
    ),
  );
  const defaultGreeting = profiles?.defaultGreeting ?? fallbackGreeting ?? DEFAULT_INBOUND_GREETING;
  const defaultSystemPrompt =
    profiles?.defaultSystemPrompt ?? config.realtimeSystemPrompt ?? DEFAULT_INBOUND_SYSTEM_PROMPT;

  return {
    greeting: matched?.greeting ?? defaultGreeting,
    systemPrompt: matched?.systemPrompt ?? defaultSystemPrompt,
  };
}

export function rewriteAsteriskOutboundNumber(
  rawNumber: string,
  rewrites: AsteriskConfig["outboundNumberRewrites"] | undefined,
): string {
  const normalized = rawNumber.replace(/^\+/, "");
  if (!rewrites?.length) return normalized;

  for (const rewrite of rewrites) {
    const re = new RegExp(rewrite.pattern, rewrite.flags);
    if (re.test(normalized)) {
      return normalized.replace(re, rewrite.replace);
    }
  }
  return normalized;
}

type AriChannel = {
  id: string;
  name?: string;
  state: string;
  caller?: { number?: string; name?: string };
  connected?: { number?: string; name?: string };
  dialplan?: { exten?: string; context?: string };
  // eslint-disable-next-line @typescript-eslint/no-explicit-unknown -- ARI returns arbitrary fields
  [key: string]: unknown;
};

type AriEvent = {
  type: string;
  channel?: AriChannel;
  digit?: string;
  cause?: number;
  playback?: { id?: string };
  recording?: { name?: string };
  // eslint-disable-next-line @typescript-eslint/no-explicit-unknown
  [key: string]: unknown;
};

type RealtimeVoiceEntry = {
  session: RealtimeVoiceSession;
  receiver: RtpReceiver;
  rtpPort: number;
  bridgeId: string;
  externalChannelId?: string;
};

// ---------------------------------------------------------------------------
// SIP cause code mapping
// ---------------------------------------------------------------------------

// #region agent log
function agentDebugLog(
  hypothesisId: string,
  location: string,
  message: string,
  data: Record<string, unknown>,
): void {
  const payload = {
    sessionId: "c8a2b2",
    hypothesisId,
    location,
    message,
    data,
    timestamp: Date.now(),
  };
  fetch("http://127.0.0.1:7840/ingest/25173012-99ac-4a06-ad7b-e7904e61d643", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "c8a2b2" },
    body: JSON.stringify(payload),
  }).catch(() => {});
  try {
    appendFileSync("/root/.openclaw/agent-debug-c8a2b2.ndjson", `${JSON.stringify(payload)}\n`, "utf8");
  } catch {
    /* no volume in local dev */
  }
}
// #endregion

function sipCauseToEndReason(
  cause: number | string | undefined,
): "completed" | "busy" | "no-answer" | "failed" {
  // Q.931 16 = normal clearing — appears for BOTH peer BYE and our ARI DELETE on the channel.
  // Do not infer "callee hung up" from mapped "completed" alone; check logs for [asterisk] hangup initiated by openclaw.
  const code = typeof cause === "string" ? parseInt(cause, 10) : (cause ?? 16);
  if (code === 16 || code === 31) return "completed";
  if (code === 17 || code === 21) return "busy";
  if (code === 18 || code === 19) return "no-answer";
  return "failed";
}

// ---------------------------------------------------------------------------
// AsteriskProvider
// ---------------------------------------------------------------------------

/**
 * OpenClaw voice-call provider using Asterisk ARI (Asterisk REST Interface).
 *
 * Unlike cloud providers (Twilio/Telnyx/Plivo) which use HTTP webhooks,
 * Asterisk ARI uses a persistent WebSocket for events and REST API for
 * call control commands.
 */
export class AsteriskProvider implements VoiceCallProvider {
  readonly name = "asterisk" as const;

  private readonly ariUrl: string;
  private readonly ariUsername: string;
  private readonly ariPassword: string;
  private readonly stasisApp: string;
  private readonly context: string;
  private readonly callerId: string;
  private readonly sipTrunk: string;
  private readonly audioUploadUrl: string;
  private readonly audioUploadToken: string;
  private readonly config: AsteriskConfig;

  private ttsProvider: TelephonyTtsProvider | null = null;

  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private connected = false;
  private stopping = false;

  /** Maps ARI channel ID → internal call ID */
  private readonly channelToCallId = new Map<string, string>();
  /** Maps internal call ID → ARI channel ID */
  private readonly callIdToChannel = new Map<string, string>();

  /** Active realtime voice sessions per channel */
  private readonly voiceSessions = new Map<string, RealtimeVoiceEntry>();
  /** Realtime voice config (set from runtime) */
  private realtimeConfig: RealtimeVoiceConfig | null = null;
  /**
   * Per-call context: taskInstructions (task prompt replacing session default),
   * isOutbound (we placed the call), and endToEnd (Realtime drives turn-taking
   * and generates replies — OpenClaw stops pushing speak/continueCall into this call).
   * Populated in initiateCall for outbound calls and via setCallTaskInstructions.
   */
  private readonly callMetadata = new Map<
    string,
    {
      taskInstructions?: string;
      isOutbound: boolean;
      endToEnd: boolean;
      // Optional override for the verbatim greeting line spoken on inbound
      // calls. Lets us switch persona (secretary vs direct-assistant) per
      // caller without rebuilding session config.
      greeting?: string;
    }
  >();

  /**
   * Event callback set by the runtime to deliver ARI WebSocket events
   * into the CallManager without HTTP self-looping.
   */
  private eventCallback: ((event: NormalizedEvent) => void) | null = null;

  constructor(config: AsteriskConfig, _options: AsteriskProviderOptions = {}) {
    if (!config.ariUrl)
      throw new Error("Asterisk ARI URL is required (e.g. http://localhost:8088)");
    if (!config.ariUsername) throw new Error("Asterisk ARI username is required");
    if (!config.ariPassword) throw new Error("Asterisk ARI password is required");

    this.config = config;
    this.ariUrl = config.ariUrl.replace(/\/$/, "");
    this.ariUsername = config.ariUsername;
    this.ariPassword = config.ariPassword;
    this.stasisApp = config.stasisApp ?? "openclaw";
    this.context = config.context ?? "from-internal";
    this.callerId = config.callerId ?? "";
    this.sipTrunk = config.sipTrunk ?? "";
    this.audioUploadUrl = (config.audioUploadUrl ?? "").replace(/\/$/, "");
    this.audioUploadToken = config.audioUploadToken ?? "";
  }

  /** Set a TTS provider for generating speech audio (OpenAI TTS). */
  setTTSProvider(provider: TelephonyTtsProvider): void {
    this.ttsProvider = provider;
  }

  /** Configure real-time voice (OpenAI Realtime API) for bidirectional audio. */
  setRealtimeConfig(cfg: RealtimeVoiceConfig): void {
    this.realtimeConfig = {
      ...cfg,
      ...(this.config.realtimeSystemPrompt
        ? { systemPrompt: this.config.realtimeSystemPrompt }
        : {}),
      ...(this.config.realtimeVoice ? { voice: this.config.realtimeVoice } : {}),
      ...(this.config.realtimeModel ? { model: this.config.realtimeModel } : {}),
      ...(this.config.realtimeInputTranscriptionLanguage !== undefined &&
      this.config.realtimeInputTranscriptionLanguage !== ""
        ? { inputAudioTranscriptionLanguage: this.config.realtimeInputTranscriptionLanguage }
        : {}),
      ...(this.config.realtimeInputTranscriptionModel
        ? { inputAudioTranscriptionModel: this.config.realtimeInputTranscriptionModel }
        : {}),
      ...(this.config.realtimeInputTranscriptionPrompt
        ? { inputAudioTranscriptionPrompt: this.config.realtimeInputTranscriptionPrompt }
        : {}),
    };
  }

  /**
   * Attach per-call task context to a provider call ID. When set before
   * startRealtimeVoice runs, the Realtime session uses these instructions
   * instead of the default system prompt and switches to end-to-end mode:
   * Realtime generates its own replies, OpenClaw stops speaking into the call.
   */
  setCallTaskInstructions(providerCallId: string, instructions: string): void {
    const existing = this.callMetadata.get(providerCallId) ?? {
      isOutbound: false,
      endToEnd: false,
    };
    this.callMetadata.set(providerCallId, {
      ...existing,
      taskInstructions: instructions,
      endToEnd: true,
    });
  }

  /** Returns true if Realtime should drive turn-taking for this call. */
  isEndToEnd(providerCallId: string): boolean {
    return this.callMetadata.get(providerCallId)?.endToEnd ?? false;
  }

  /** VoiceCallProvider hook — used by CallManager.speak to skip redundant TTS. */
  isEmbeddedAgentActive(providerCallId: string): boolean {
    return this.isEndToEnd(providerCallId);
  }

  // -------------------------------------------------------------------------
  // Event delivery
  // -------------------------------------------------------------------------

  /**
   * Register a callback for delivering ARI events into the call manager.
   * Called by the runtime after the webhook server is ready.
   */
  setEventCallback(callback: (event: NormalizedEvent) => void): void {
    this.eventCallback = callback;
  }

  private deliverEvent(event: NormalizedEvent): void {
    if (this.eventCallback) {
      this.eventCallback(event);
    }
  }

  // -------------------------------------------------------------------------
  // ARI REST API
  // -------------------------------------------------------------------------

  private async ariRequest<T = unknown>(
    method: string,
    endpoint: string,
    body?: Record<string, unknown>,
  ): Promise<T | null> {
    const separator = endpoint.includes("?") ? "&" : "?";
    const fullUrl =
      `${this.ariUrl}/ari${endpoint}${separator}` +
      `api_key=${encodeURIComponent(`${this.ariUsername}:${this.ariPassword}`)}`;

    const fetchOpts: RequestInit = {
      method,
      headers: { "Content-Type": "application/json" },
    };
    if (body && method !== "GET" && method !== "DELETE") {
      fetchOpts.body = JSON.stringify(body);
    }

    const response = await fetch(fullUrl, fetchOpts);

    if (!response.ok) {
      if (response.status === 404) return null;
      const errorText = await response.text();
      throw new Error(`ARI API error: ${response.status} ${errorText}`);
    }

    const text = await response.text();
    return text ? (JSON.parse(text) as T) : (undefined as unknown as T);
  }

  // -------------------------------------------------------------------------
  // ARI WebSocket (event stream)
  // -------------------------------------------------------------------------

  /** Connect to ARI WebSocket for real-time events. */
  async connect(): Promise<void> {
    if (this.ws) return;
    this.stopping = false;

    const wsUrl =
      `${this.ariUrl.replace(/^http/, "ws")}/ari/events` +
      `?api_key=${encodeURIComponent(`${this.ariUsername}:${this.ariPassword}`)}` +
      `&app=${encodeURIComponent(this.stasisApp)}`;

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      let resolved = false;

      ws.on("open", () => {
        console.log("[asterisk] ARI WebSocket connected");
        this.ws = ws;
        this.connected = true;
        this.reconnectAttempts = 0;
        if (!resolved) {
          resolved = true;
          resolve();
        }
      });

      ws.on("message", (data: Buffer | string) => {
        try {
          const event = JSON.parse(data.toString()) as AriEvent;
          this.handleAriEvent(event);
        } catch (err) {
          console.error("[asterisk] Failed to parse ARI event:", err);
        }
      });

      ws.on("close", () => {
        console.warn("[asterisk] ARI WebSocket closed");
        this.connected = false;
        this.ws = null;
        if (!this.stopping) this.scheduleReconnect();
      });

      ws.on("error", (err: Error) => {
        console.error("[asterisk] ARI WebSocket error:", err.message);
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });
    });
  }

  /** Disconnect from ARI WebSocket. */
  async disconnect(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  private scheduleReconnect(): void {
    if (this.stopping) return;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30_000);
    this.reconnectAttempts++;
    console.log(`[asterisk] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch (err) {
        console.error("[asterisk] Reconnect failed:", (err as Error).message);
      }
    }, delay);
  }

  // -------------------------------------------------------------------------
  // ARI event → NormalizedEvent mapping
  // -------------------------------------------------------------------------

  private handleAriEvent(event: AriEvent): void {
    const channel = event.channel;
    if (!channel) return;

    const channelId = channel.id;
    const callId = this.channelToCallId.get(channelId);
    const eventMeta = event as AriEvent & {
      cause_txt?: string;
      dialstatus?: string;
      dialstring?: string;
      endpoint?: string;
    };

    // #region agent log
    if (
      callId &&
      (event.type === "StasisStart" ||
        event.type === "ChannelStateChange" ||
        event.type === "ChannelHangupRequest" ||
        event.type === "ChannelDestroyed")
    ) {
      agentDebugLog("H9", "asterisk.ts:handleAriEvent", "outbound lifecycle trace", {
        callId,
        channelId,
        eventType: event.type,
        channelState: channel.state,
        cause: event.cause,
        causeText: eventMeta.cause_txt,
        dialstatus: eventMeta.dialstatus,
        dialstring: eventMeta.dialstring,
        endpoint: eventMeta.endpoint,
      });
    }
    // #endregion

    switch (event.type) {
      case "StasisStart": {
        // Ignore ExternalMedia (UnicastRTP) channels — handled internally
        if (channel.name?.startsWith("UnicastRTP") || channel.name?.startsWith("Local/")) return;

        if (callId) {
          // Outbound call entered Stasis — wait for answer (ChannelStateChange "Up")
          console.log(`[asterisk] Outbound StasisStart for ${channelId}, waiting for answer`);
          return;
        }

        // Inbound call
        const newCallId = crypto.randomUUID();
        this.channelToCallId.set(channelId, newCallId);
        this.callIdToChannel.set(newCallId, channelId);

        const fromNumber = channel.caller?.number ?? "";
        const inboundProfile = resolveAsteriskInboundProfile(this.config, fromNumber);
        this.callMetadata.set(channelId, {
          isOutbound: false,
          endToEnd: true,
          taskInstructions: inboundProfile.systemPrompt,
          greeting: inboundProfile.greeting,
        });

        this.deliverEvent({
          id: crypto.randomUUID(),
          callId: newCallId,
          providerCallId: channelId,
          timestamp: Date.now(),
          type: "call.initiated",
          direction: "inbound",
          from: channel.caller?.number ?? "",
          to: channel.dialplan?.exten ?? channel.connected?.number ?? "",
        });

        // Auto-answer and start realtime voice session
        this.ariRequest("POST", `/channels/${encodeURIComponent(channelId)}/answer`)
          .then(() => this.startRealtimeVoice(channelId))
          .catch((err) => {
            console.error("[asterisk] Failed to answer/start realtime:", (err as Error).message);
          });
        break;
      }

      case "ChannelStateChange": {
        if (!callId) return;
        const state = channel.state;
        if (state === "Ringing" || state === "Ring") {
          agentDebugLog("H5", "asterisk.ts:ChannelStateChange", "ringing", {
            callId,
            channelId,
            state,
            channelName: channel.name,
          });
          this.deliverEvent({
            id: crypto.randomUUID(),
            callId,
            providerCallId: channelId,
            timestamp: Date.now(),
            type: "call.ringing",
          });
        } else if (state === "Up") {
          agentDebugLog("H5", "asterisk.ts:ChannelStateChange", "channel_up", {
            callId,
            channelId,
            state,
            channelName: channel.name,
          });
          // Start realtime voice FIRST so it's ready when manager calls playTts
          if (!this.voiceSessions.has(channelId) && this.realtimeConfig) {
            console.log(`[asterisk] Call answered, starting realtime voice for ${channelId}`);
            this.startRealtimeVoice(channelId)
              .then(() => {
                // Only deliver call.answered AFTER realtime is ready
                this.deliverEvent({
                  id: crypto.randomUUID(),
                  callId: callId!,
                  providerCallId: channelId,
                  timestamp: Date.now(),
                  type: "call.answered",
                });
              })
              .catch((err) => {
                console.error("[asterisk] Failed to start realtime voice:", (err as Error).message);
                // Still deliver answered even if realtime fails
                this.deliverEvent({
                  id: crypto.randomUUID(),
                  callId: callId!,
                  providerCallId: channelId,
                  timestamp: Date.now(),
                  type: "call.answered",
                });
              });
          } else {
            this.deliverEvent({
              id: crypto.randomUUID(),
              callId,
              providerCallId: channelId,
              timestamp: Date.now(),
              type: "call.answered",
            });
          }
        }
        break;
      }

      case "ChannelDtmfReceived": {
        if (!callId) return;
        this.deliverEvent({
          id: crypto.randomUUID(),
          callId,
          providerCallId: channelId,
          timestamp: Date.now(),
          type: "call.dtmf",
          digits: event.digit ?? "",
        });
        break;
      }

      case "StasisEnd":
      case "ChannelDestroyed": {
        // Ignore ExternalMedia teardown
        if (channel.name?.startsWith("UnicastRTP") || channel.name?.startsWith("Local/")) return;
        if (!callId) return;
        agentDebugLog("H1", "asterisk.ts:ChannelDestroyed", "channel teardown", {
          eventType: event.type,
          callId,
          channelId,
          rawCause: event.cause,
          rawCauseText: eventMeta.cause_txt,
          rawDialstatus: eventMeta.dialstatus,
          mappedEndReason: sipCauseToEndReason(event.cause),
          channelName: channel.name,
          channelState: channel.state,
          caller: channel.caller,
          connected: channel.connected,
          hint: "Asterisk cause 21 is often call rejected; we map 17|21 to busy",
        });
        console.log(
          `[asterisk] ${event.type}: channel=${channelId} name=${channel.name ?? "?"} raw_sip_cause=${JSON.stringify(event.cause)} → endReason=${sipCauseToEndReason(event.cause)}`,
        );
        this.cleanupRealtimeVoice(channelId);
        this.deliverEvent({
          id: crypto.randomUUID(),
          callId,
          providerCallId: channelId,
          timestamp: Date.now(),
          type: "call.ended",
          reason: sipCauseToEndReason(event.cause),
        });
        this.channelToCallId.delete(channelId);
        this.callIdToChannel.delete(callId);
        break;
      }

      case "ChannelHangupRequest": {
        if (!callId) return;
        this.deliverEvent({
          id: crypto.randomUUID(),
          callId,
          providerCallId: channelId,
          timestamp: Date.now(),
          type: "call.ended",
          reason: sipCauseToEndReason(event.cause),
        });
        break;
      }

      case "PlaybackFinished": {
        if (!callId) return;
        this.deliverEvent({
          id: crypto.randomUUID(),
          callId,
          providerCallId: channelId,
          timestamp: Date.now(),
          type: "call.active",
        });
        break;
      }

      default:
        break;
    }
  }

  // -------------------------------------------------------------------------
  // VoiceCallProvider interface
  // -------------------------------------------------------------------------

  /**
   * Verify webhook — ARI uses WebSocket auth, not webhook signatures.
   * Always returns ok for self-forwarded events.
   */
  verifyWebhook(_ctx: WebhookContext): WebhookVerificationResult {
    return { ok: true, reason: "asterisk-ari-trusted" };
  }

  /**
   * Parse webhook events. For Asterisk, events arrive via WebSocket and
   * are delivered through the eventCallback. This method handles any
   * self-forwarded events from the provider.
   */
  parseWebhookEvent(ctx: WebhookContext, _options?: unknown): ProviderWebhookParseResult {
    try {
      const body = JSON.parse(ctx.rawBody) as { provider?: string; events?: NormalizedEvent[] };
      if (body.provider !== "asterisk") {
        return { events: [], statusCode: 200 };
      }
      return {
        events: Array.isArray(body.events) ? body.events : [],
        statusCode: 200,
        providerResponseBody: JSON.stringify({ ok: true }),
        providerResponseHeaders: { "Content-Type": "application/json" },
      };
    } catch {
      return { events: [], statusCode: 400 };
    }
  }

  /**
   * Initiate an outbound call via ARI.
   */
  async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    const to = rewriteAsteriskOutboundNumber(input.to, this.config.outboundNumberRewrites);
    const endpoint = this.sipTrunk ? `PJSIP/${to}@${this.sipTrunk}` : `PJSIP/${to}`;

    console.log(
      `[asterisk] Originating call: endpoint=${endpoint} app=${this.stasisApp} sipTrunk=${this.sipTrunk} ariUrl=${this.ariUrl}`,
    );

    const result = await this.ariRequest<{ id: string }>("POST", "/channels", {
      endpoint,
      app: this.stasisApp,
      callerId: input.from || this.callerId,
      timeout: 30,
      variables: { OPENCLAW_CALL_ID: input.callId },
    });

    if (!result?.id) {
      throw new Error("ARI channel create returned no channel ID");
    }

    this.channelToCallId.set(result.id, input.callId);
    this.callIdToChannel.set(input.callId, result.id);

    agentDebugLog("H2", "asterisk.ts:initiateCall", "outbound originate ok", {
      callId: input.callId,
      channelId: result.id,
      to,
      endpoint,
      callerId: input.from || this.callerId,
      ariUrl: this.ariUrl,
    });

    // Mark as outbound and attach any per-call task instructions synchronously
    // (before StasisStart → startRealtimeVoice fires). When instructions are
    // present the call runs end-to-end with Realtime driving turn-taking.
    this.callMetadata.set(result.id, {
      isOutbound: true,
      endToEnd: Boolean(input.realtimeTaskInstructions),
      taskInstructions: input.realtimeTaskInstructions,
    });

    return { providerCallId: result.id, status: "initiated" };
  }

  /**
   * Hang up a call via ARI.
   */
  async hangupCall(input: HangupCallInput): Promise<void> {
    const channelId = input.providerCallId;
    console.log(
      `[asterisk] hangupCall (OpenClaw-initiated): channel=${channelId} reason=${input.reason ?? "unspecified"}`,
    );
    // ARI DELETE /channels/{id} with no reason uses normal clearing (Q.931 16).
    // reason_code must be numeric if provided; the literal "normal" is rejected.
    await this.ariRequest("DELETE", `/channels/${encodeURIComponent(channelId)}`);
    const callId = this.channelToCallId.get(channelId);
    if (callId) {
      this.channelToCallId.delete(channelId);
      this.callIdToChannel.delete(callId);
    }
    this.callMetadata.delete(channelId);
  }

  /**
   * Play TTS audio via ARI channel playback.
   *
   * When a TTS provider and audioUploadUrl are configured, generates speech
   * via OpenAI TTS, converts to 8kHz signed-linear, uploads to the Asterisk
   * sounds directory, and plays back via ARI. Cleans up the file afterwards.
   */
  async playTts(input: PlayTtsInput): Promise<void> {
    const channelId = input.providerCallId;

    // End-to-end mode: Realtime is driving the call and generating its own replies
    // from task instructions. For the very first outbound line we still allow
    // exact read-aloud through Realtime so the opening request is deterministic.
    if (this.isEndToEnd(channelId)) {
      const voiceEntry = this.voiceSessions.get(channelId);
      if (voiceEntry) {
        console.log(`[asterisk] playTts via Realtime speakText (end-to-end): ${input.text.slice(0, 80)}`);
        voiceEntry.session.speakText(input.text);
        return;
      }
      console.log(
        `[asterisk] playTts ignored (end-to-end, no active session yet): ${input.text.slice(0, 80)}`,
      );
      return;
    }

    // Legacy/inbound path: synthesize via TTS API and stream mu-law through the
    // Realtime RTP sender (Realtime's own speakText is unreliable for verbatim).
    const voiceEntry = this.voiceSessions.get(channelId);
    if (voiceEntry && this.ttsProvider) {
      console.log(
        `[asterisk] playTts via TTS API + RTP for ${channelId}: ${input.text.slice(0, 80)}`,
      );
      try {
        const mulawAudio = await this.ttsProvider.synthesizeForTelephony(input.text);
        voiceEntry.session.sendAudio(mulawAudio);
        return;
      } catch (err) {
        console.error("[asterisk] TTS API + RTP failed:", (err as Error).message);
        // Fall through to other methods
      }
    }

    const playbackId = crypto.randomUUID();
    console.log(
      `[asterisk] playTts: ttsProvider=${!!this.ttsProvider} audioUploadUrl=${this.audioUploadUrl || "none"} channelId=${channelId}`,
    );

    if (this.ttsProvider && this.audioUploadUrl) {
      try {
        await this.playTtsViaUpload(input.text, channelId, playbackId);
        return;
      } catch (err) {
        console.error("[asterisk] TTS via upload failed:", (err as Error).message);
      }
    }

    // Fallback: play a beep and set text as channel variable
    console.warn("[asterisk] TTS provider not configured, using beep fallback");
    await this.ariRequest("POST", `/channels/${encodeURIComponent(channelId)}/variable`, {
      variable: "OPENCLAW_TTS_TEXT",
      value: input.text,
    });
    await this.ariRequest(
      "POST",
      `/channels/${encodeURIComponent(channelId)}/play/${encodeURIComponent(playbackId)}`,
      { media: "sound:beep" },
    );
  }

  /**
   * Generate TTS audio, upload to Asterisk sounds dir, play, then clean up.
   */
  private async playTtsViaUpload(
    text: string,
    channelId: string,
    playbackId: string,
  ): Promise<void> {
    if (!this.ttsProvider) throw new Error("TTS provider not set");

    const filename = `tts-${playbackId}`;

    // 1. Generate mu-law audio (8kHz) via TTS provider, then convert to slin16
    //    TelephonyTtsProvider returns mu-law; we need raw slin for Asterisk .sln files.
    //    Instead, call the underlying synthesize and resample ourselves.
    const mulawAudio = await this.ttsProvider.synthesizeForTelephony(text);

    // mu-law is 8kHz 8-bit; convert to 8kHz 16-bit signed linear for Asterisk .sln
    const slnAudio = Buffer.alloc(mulawAudio.length * 2);
    for (let i = 0; i < mulawAudio.length; i++) {
      slnAudio.writeInt16LE(mulawDecode(mulawAudio[i]!), i * 2);
    }

    // 2. Upload .sln file to Asterisk audio server
    const uploadUrl = `${this.audioUploadUrl}/${filename}.sln`;
    const uploadRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "X-Auth-Token": this.audioUploadToken,
        "Content-Length": String(slnAudio.length),
      },
      body: slnAudio,
    });
    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      throw new Error(`Audio upload failed: ${uploadRes.status} ${errText}`);
    }

    // 3. Play via ARI
    try {
      await this.ariRequest(
        "POST",
        `/channels/${encodeURIComponent(channelId)}/play/${encodeURIComponent(playbackId)}`,
        { media: `sound:openclaw/${filename}` },
      );
    } finally {
      // 4. Clean up the uploaded file after a delay (let playback finish)
      setTimeout(() => {
        fetch(uploadUrl, {
          method: "DELETE",
          headers: { "X-Auth-Token": this.audioUploadToken },
        }).catch(() => {});
      }, 30_000);
    }
  }

  /**
   * Start listening for speech via ARI recording.
   * Records audio segment, which can be transcribed by an external STT service.
   */
  async startListening(input: StartListeningInput): Promise<void> {
    const channelId = input.providerCallId;

    // When realtime voice is active, STT is already running via OpenAI Realtime.
    // No need to start a separate ARI recording.
    if (this.voiceSessions.has(channelId)) {
      console.log(
        `[asterisk] startListening: realtime active, STT already running for ${channelId}`,
      );
      return;
    }

    const recordingName = `openclaw-${crypto.randomUUID()}`;
    try {
      await this.ariRequest("POST", `/channels/${encodeURIComponent(channelId)}/record`, {
        name: recordingName,
        format: "wav",
        maxSilenceSeconds: 2,
        maxDurationSeconds: 30,
        beep: false,
        terminateOn: "#",
      });
    } catch (err) {
      console.error("[asterisk] startListening failed:", (err as Error).message);
    }
  }

  /**
   * Stop listening — ARI recordings auto-stop on silence or max duration.
   */
  async stopListening(_input: StopListeningInput): Promise<void> {
    // no-op: ARI recordings stop automatically
  }

  /**
   * Get call status via ARI channel query.
   */
  async getCallStatus(input: GetCallStatusInput): Promise<GetCallStatusResult> {
    try {
      const data = await this.ariRequest<{ state: string }>(
        "GET",
        `/channels/${encodeURIComponent(input.providerCallId)}`,
      );

      if (!data) return { status: "not-found", isTerminal: true };

      const stateMap: Record<string, string> = {
        Down: "initiated",
        Rsrvd: "initiated",
        OffHook: "initiated",
        Dialing: "initiated",
        Ring: "ringing",
        Ringing: "ringing",
        Up: "in-progress",
        Busy: "busy",
        "Dialing Offhook": "initiated",
        "Pre-ring": "initiated",
      };

      const normalizedStatus = stateMap[data.state] ?? "unknown";
      const terminalStatuses = new Set(["busy", "not-found"]);

      return {
        status: normalizedStatus,
        isTerminal: terminalStatuses.has(normalizedStatus),
      };
    } catch {
      return { status: "error", isTerminal: false, isUnknown: true };
    }
  }

  // -------------------------------------------------------------------------
  // Realtime voice: bridge + ExternalMedia + OpenAI Realtime
  // -------------------------------------------------------------------------

  private async startRealtimeVoice(channelId: string): Promise<void> {
    if (!this.realtimeConfig) {
      console.warn("[asterisk] Realtime voice not configured, skipping");
      return;
    }

    let bridgeId: string | undefined;
    let externalChannelId: string | undefined;
    let receiver: RtpReceiver | undefined;
    let rtpPort: number | undefined;

    try {
      // 1. Create mixing bridge
      bridgeId = `${channelId}_bridge`;
      await this.ariRequest("POST", "/bridges", {
        bridgeId,
        type: "mixing,proxy_media",
      });

      // 2. Add SIP channel to bridge
      await this.ariRequest("POST", `/bridges/${encodeURIComponent(bridgeId)}/addChannel`, {
        channel: channelId,
      });

      // 3. Allocate RTP port and start receiver
      //    Receiver listens on 0.0.0.0 so Asterisk (remote server) can reach it.
      //    ExternalMedia points to OpenClaw's public IP.
      rtpPort = allocateRtpPort(12000);
      receiver = startRtpReceiver(rtpPort, "0.0.0.0");

      // Resolve OpenClaw's reachable IP from the ARI URL host
      const asteriskHost = new URL(this.ariUrl).hostname;
      // If Asterisk is remote, ExternalMedia must send RTP to OpenClaw's IP.
      // Use Docker host's public IP (from env or derive from ARI connection).
      const rtpListenHost = process.env.OPENCLAW_PUBLIC_IP ?? "0.0.0.0";
      const externalHost =
        rtpListenHost === "0.0.0.0"
          ? `${asteriskHost}:${rtpPort}` // fallback: send to Asterisk itself (won't work for remote)
          : `${rtpListenHost}:${rtpPort}`;

      console.log(
        `[asterisk] ExternalMedia target: ${externalHost}, receiver on 0.0.0.0:${rtpPort}`,
      );

      // 4. Create ExternalMedia channel for bidirectional RTP
      const extChannel = await this.ariRequest<{ id: string }>("POST", "/channels/externalMedia", {
        app: this.stasisApp,
        external_host: externalHost,
        format: "ulaw",
        transport: "udp",
        encapsulation: "rtp",
        connection_type: "client",
        direction: "both",
      });

      if (extChannel?.id) {
        externalChannelId = extChannel.id;
        // 5. Add ExternalMedia channel to the same bridge
        await this.ariRequest("POST", `/bridges/${encodeURIComponent(bridgeId)}/addChannel`, {
          channel: extChannel.id,
        });
        console.log(`[asterisk] ExternalMedia ${extChannel.id} bridged on port ${rtpPort}`);
      }

      // 6. Build per-call Realtime config. When the call has task instructions
      // attached (via setCallTaskInstructions from the runtime), they replace the
      // default system prompt and Realtime drives the conversation end-to-end.
      // Otherwise (notify mode, one-shot TTS-API message) autoRespond is OFF so
      // Realtime's VAD doesn't barge in on our pre-rendered audio.
      const meta = this.callMetadata.get(channelId) ?? { isOutbound: false, endToEnd: false };
      const effectiveConfig: RealtimeVoiceConfig = {
        ...this.realtimeConfig,
        ...(meta.taskInstructions ? { systemPrompt: meta.taskInstructions } : {}),
        autoRespond: meta.endToEnd,
      };
      // #region agent log
      console.log(
        `[agent-debug][H1] realtime config for ${channelId}: ` +
          JSON.stringify({
            runId: "prompt-state-machine-v2",
            hasTaskInstructions: Boolean(meta.taskInstructions),
            taskLanguageHintRu: /task_language_hint:\s*ru/.test(meta.taskInstructions ?? ""),
            taskLanguageHintAuto: /task_language_hint:\s*auto/.test(meta.taskInstructions ?? ""),
            promptVersionGeneral: (meta.taskInstructions ?? "").includes(
              "caller-general-task-state-machine-2026-05-15",
            ),
            endToEnd: meta.endToEnd,
          }),
      );
      // #endregion

      if (!receiver) throw new Error("RTP receiver was not initialized");
      const activeReceiver = receiver;
      const session = createRealtimeVoiceSession(
        effectiveConfig,
        activeReceiver,
        () => activeReceiver.rtpSource,
      );

      session.onAssistantTranscript = (text) => {
        console.log(`[asterisk] Assistant: ${text}`);
        const cid = this.channelToCallId.get(channelId);
        if (cid) {
          this.deliverEvent({
            id: crypto.randomUUID(),
            callId: cid,
            providerCallId: channelId,
            timestamp: Date.now(),
            type: "call.bot_speech",
            transcript: text,
          });
        }
      };

      // Deliver user speech transcripts into OpenClaw's call manager.
      // For end-to-end calls, Realtime already handled the turn — the event is
      // kept only for transcript storage and post-call summaries (runtime.ts
      // skips handleInboundResponse for these).
      session.onUserTranscript = (text) => {
        console.log(`[asterisk] User: ${text}`);
        const cid = this.channelToCallId.get(channelId);
        if (cid) {
          this.deliverEvent({
            id: crypto.randomUUID(),
            callId: cid,
            providerCallId: channelId,
            timestamp: Date.now(),
            type: "call.speech",
            transcript: text,
            isFinal: true,
          });
        }
      };

      // end_call tool fires here: give the goodbye audio a moment to flush,
      // then drop the channel via ARI. cleanup runs from StasisEnd afterward.
      session.onHangupRequested = () => {
        console.log(
          `[asterisk] realtime session requested hangup → ARI DELETE in 1500ms for channel=${channelId}`,
        );
        setTimeout(() => {
          console.log(`[asterisk] executing ARI DELETE after realtime hangup for channel=${channelId}`);
          this.ariRequest("DELETE", `/channels/${encodeURIComponent(channelId)}`).catch((err) =>
            console.error("[asterisk] end_call hangup failed:", (err as Error).message),
          );
        }, 1500);
      };

      this.voiceSessions.set(channelId, {
        session,
        receiver,
        rtpPort,
        bridgeId,
        externalChannelId,
      });
      await session.start();
      console.log(
        `[asterisk] Realtime voice started for channel ${channelId}` +
          (meta.endToEnd ? " (end-to-end agent mode)" : ""),
      );

      // End-to-end mode: Realtime needs to speak first.
      //
      // Outbound: we called someone — let the model compose the greeting based
      // on the per-call task instructions. triggerGreeting() biases it toward
      // an immediate "in-character" first sentence.
      //
      // Inbound: the caller dialed our number, so they are waiting for a
      // configured greeting. Speak it verbatim instead of asking the model to
      // reproduce it from the system prompt.
      if (meta.endToEnd) {
        if (meta.isOutbound) {
          // Outbound deterministic opening is sent by speakInitialMessage() via
          // session.speakText(). Calling triggerGreeting() in parallel creates a
          // second active response and can make the model ad-lib the first line.
          console.log("[asterisk] Outbound end-to-end: skip triggerGreeting, waiting for initial message");
        } else {
          const greeting = meta.greeting ?? DEFAULT_INBOUND_GREETING;
          setTimeout(() => {
            session.speakText(greeting);
          }, 1500);
        }
      }
    } catch (err) {
      console.error("[asterisk] Failed to start realtime voice:", (err as Error).message);
      if (this.voiceSessions.has(channelId)) {
        this.cleanupRealtimeVoice(channelId);
        return;
      }

      receiver?.close();
      if (rtpPort !== undefined) releaseRtpPort(rtpPort);
      void this.cleanupAriRealtimeResources(channelId, {
        bridgeId,
        externalChannelId,
      });
    }
  }

  private cleanupRealtimeVoice(channelId: string): void {
    const entry = this.voiceSessions.get(channelId);
    if (!entry) {
      this.callMetadata.delete(channelId);
      return;
    }
    this.voiceSessions.delete(channelId);
    entry.session.stop();
    entry.receiver.close();
    releaseRtpPort(entry.rtpPort);
    void this.cleanupAriRealtimeResources(channelId, entry);
    this.callMetadata.delete(channelId);
    console.log(`[asterisk] Realtime voice cleaned up for ${channelId}`);
  }

  private async cleanupAriRealtimeResources(
    channelId: string,
    resources: Pick<Partial<RealtimeVoiceEntry>, "bridgeId" | "externalChannelId">,
  ): Promise<void> {
    const deleteChannel = resources.externalChannelId
      ? this.ariRequest("DELETE", `/channels/${encodeURIComponent(resources.externalChannelId)}`)
      : Promise.resolve(null);
    const deleteBridge = resources.bridgeId
      ? this.ariRequest("DELETE", `/bridges/${encodeURIComponent(resources.bridgeId)}`)
      : Promise.resolve(null);

    const results = await Promise.allSettled([deleteChannel, deleteBridge]);
    for (const result of results) {
      if (result.status === "rejected") {
        console.warn(
          `[asterisk] Realtime ARI cleanup warning for ${channelId}: ${
            result.reason instanceof Error ? result.reason.message : String(result.reason)
          }`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// mu-law decode (ITU G.711)
// ---------------------------------------------------------------------------

function mulawDecode(mulaw: number): number {
  mulaw = ~mulaw & 0xff;
  const sign = mulaw & 0x80;
  const exponent = (mulaw >> 4) & 0x07;
  const mantissa = mulaw & 0x0f;
  let sample = ((mantissa << 3) + 132) << exponent;
  sample -= 132;
  return sign ? -sample : sample;
}
