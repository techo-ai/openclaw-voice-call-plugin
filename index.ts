import { Type } from "typebox";
import {
  definePluginEntry,
  type GatewayRequestHandlerOptions,
  type OpenClawPluginApi,
} from "./api.js";
import { createVoiceCallRuntime, type VoiceCallRuntime } from "./runtime-entry.js";
import { registerVoiceCallCli } from "./src/cli.js";
import {
  VoiceCallConfigSchema,
  resolveVoiceCallConfig,
  validateProviderConfig,
  type VoiceCallConfig,
} from "./src/config.js";
import type { CoreConfig } from "./src/core-bridge.js";

const voiceCallConfigSchema = {
  parse(value: unknown): VoiceCallConfig {
    const raw =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};

    const twilio = raw.twilio as Record<string, unknown> | undefined;
    const legacyFrom = typeof twilio?.from === "string" ? twilio.from : undefined;

    const enabled = typeof raw.enabled === "boolean" ? raw.enabled : true;
    const providerRaw = raw.provider === "log" ? "mock" : raw.provider;
    const provider = providerRaw ?? (enabled ? "mock" : undefined);

    return VoiceCallConfigSchema.parse({
      ...raw,
      enabled,
      provider,
      fromNumber: raw.fromNumber ?? legacyFrom,
    });
  },
  uiHints: {
    provider: {
      label: "Provider",
      help: "Use twilio, telnyx, plivo, asterisk, or mock for dev/no-network.",
    },
    fromNumber: { label: "From Number", placeholder: "+15550001234" },
    toNumber: { label: "Default To Number", placeholder: "+15550001234" },
    inboundPolicy: { label: "Inbound Policy" },
    allowFrom: { label: "Inbound Allowlist" },
    inboundGreeting: { label: "Inbound Greeting", advanced: true },
    "telnyx.apiKey": { label: "Telnyx API Key", sensitive: true },
    "telnyx.connectionId": { label: "Telnyx Connection ID" },
    "telnyx.publicKey": { label: "Telnyx Public Key", sensitive: true },
    "twilio.accountSid": { label: "Twilio Account SID" },
    "twilio.authToken": { label: "Twilio Auth Token", sensitive: true },
    "plivo.authId": { label: "Plivo Auth ID" },
    "plivo.authToken": { label: "Plivo Auth Token", sensitive: true },
    "asterisk.ariUrl": {
      label: "Asterisk ARI URL",
      placeholder: "http://localhost:8088",
    },
    "asterisk.ariUsername": { label: "Asterisk ARI Username" },
    "asterisk.ariPassword": {
      label: "Asterisk ARI Password",
      sensitive: true,
    },
    "asterisk.stasisApp": { label: "Stasis App Name", placeholder: "openclaw" },
    "asterisk.context": {
      label: "SIP Context",
      placeholder: "from-internal",
      advanced: true,
    },
    "asterisk.callerId": { label: "Default Caller ID", advanced: true },
    "asterisk.inboundProfiles.defaultGreeting": {
      label: "Asterisk Inbound Greeting",
      advanced: true,
    },
    "asterisk.inboundProfiles.defaultSystemPrompt": {
      label: "Asterisk Inbound System Prompt",
      advanced: true,
    },
    "outbound.defaultMode": { label: "Default Call Mode" },
    "outbound.notifyHangupDelaySec": {
      label: "Notify Hangup Delay (sec)",
      advanced: true,
    },
    "outbound.sameNumberCooldownSeconds": {
      label: "Same Number Cooldown (sec)",
      advanced: true,
    },
    "serve.port": { label: "Webhook Port" },
    "serve.bind": { label: "Webhook Bind" },
    "serve.path": { label: "Webhook Path" },
    "tailscale.mode": { label: "Tailscale Mode", advanced: true },
    "tailscale.path": { label: "Tailscale Path", advanced: true },
    "tunnel.provider": { label: "Tunnel Provider", advanced: true },
    "tunnel.ngrokAuthToken": {
      label: "ngrok Auth Token",
      sensitive: true,
      advanced: true,
    },
    "tunnel.ngrokDomain": { label: "ngrok Domain", advanced: true },
    "tunnel.allowNgrokFreeTierLoopbackBypass": {
      label: "Allow ngrok Free Tier (Loopback Bypass)",
      advanced: true,
    },
    "streaming.enabled": { label: "Enable Streaming", advanced: true },
    "streaming.openaiApiKey": {
      label: "OpenAI Realtime API Key",
      sensitive: true,
      advanced: true,
    },
    "streaming.sttModel": { label: "Realtime STT Model", advanced: true },
    "streaming.streamPath": { label: "Media Stream Path", advanced: true },
    "tts.provider": {
      label: "TTS Provider Override",
      help: "Deep-merges with messages.tts (Microsoft is ignored for calls).",
      advanced: true,
    },
    "tts.openai.model": { label: "OpenAI TTS Model", advanced: true },
    "tts.openai.voice": { label: "OpenAI TTS Voice", advanced: true },
    "tts.openai.apiKey": {
      label: "OpenAI API Key",
      sensitive: true,
      advanced: true,
    },
    "tts.elevenlabs.modelId": { label: "ElevenLabs Model ID", advanced: true },
    "tts.elevenlabs.voiceId": { label: "ElevenLabs Voice ID", advanced: true },
    "tts.elevenlabs.apiKey": {
      label: "ElevenLabs API Key",
      sensitive: true,
      advanced: true,
    },
    "tts.elevenlabs.baseUrl": { label: "ElevenLabs Base URL", advanced: true },
    publicUrl: { label: "Public Webhook URL", advanced: true },
    skipSignatureVerification: {
      label: "Skip Signature Verification",
      advanced: true,
    },
    store: { label: "Call Log Store Path", advanced: true },
    responseModel: { label: "Response Model", advanced: true },
    responseSystemPrompt: { label: "Response System Prompt", advanced: true },
    responseTimeoutMs: { label: "Response Timeout (ms)", advanced: true },
  },
};

const VoiceCallToolSchema = Type.Union([
  Type.Object({
    action: Type.Literal("initiate_call"),
    to: Type.Optional(Type.String({ description: "Call target" })),
    message: Type.String({ description: "Intro message" }),
    mode: Type.Optional(Type.Union([Type.Literal("notify"), Type.Literal("conversation")])),
  }),
  Type.Object({
    action: Type.Literal("continue_call"),
    callId: Type.String({ description: "Call ID" }),
    message: Type.String({ description: "Follow-up message" }),
  }),
  Type.Object({
    action: Type.Literal("speak_to_user"),
    callId: Type.String({ description: "Call ID" }),
    message: Type.String({ description: "Message to speak" }),
  }),
  Type.Object({
    action: Type.Literal("end_call"),
    callId: Type.String({ description: "Call ID" }),
  }),
  Type.Object({
    action: Type.Literal("get_status"),
    callId: Type.String({ description: "Call ID" }),
  }),
  Type.Object({
    mode: Type.Optional(Type.Union([Type.Literal("call"), Type.Literal("status")])),
    to: Type.Optional(Type.String({ description: "Call target" })),
    sid: Type.Optional(Type.String({ description: "Call SID" })),
    message: Type.Optional(Type.String({ description: "Optional intro message" })),
  }),
]);

export default definePluginEntry({
  id: "voice-call-asterisk",
  name: "Voice Call (Asterisk + Realtime)",
  description:
    "Voice-call plugin with Telnyx, Twilio, Plivo, Asterisk (multi-cluster ARI + OpenAI Realtime end-to-end agent), and mock providers. Distinct id from the bundled openclaw 'voice-call' so it can live alongside without schema clashes.",
  configSchema: voiceCallConfigSchema,
  register(api: OpenClawPluginApi) {
    const config = resolveVoiceCallConfig(voiceCallConfigSchema.parse(api.pluginConfig));
    const validation = validateProviderConfig(config);

    if (api.pluginConfig && typeof api.pluginConfig === "object") {
      const raw = api.pluginConfig as Record<string, unknown>;
      const twilio = raw.twilio as Record<string, unknown> | undefined;
      if (raw.provider === "log") {
        api.logger.warn('[voice-call] provider "log" is deprecated; use "mock" instead');
      }
      if (typeof twilio?.from === "string") {
        api.logger.warn("[voice-call] twilio.from is deprecated; use fromNumber instead");
      }
    }

    let runtimePromise: Promise<VoiceCallRuntime> | null = null;
    let runtime: VoiceCallRuntime | null = null;

    const ensureRuntime = async () => {
      if (!config.enabled) {
        throw new Error("Voice call disabled in plugin config");
      }
      if (!validation.valid) {
        throw new Error(validation.errors.join("; "));
      }
      if (runtime) {
        return runtime;
      }
      if (!runtimePromise) {
        runtimePromise = createVoiceCallRuntime({
          config,
          coreConfig: api.config as CoreConfig,
          agentRuntime: api.runtime.agent,
          ttsRuntime: api.runtime.tts,
          logger: api.logger,
        });
      }
      try {
        runtime = await runtimePromise;
      } catch (err) {
        // Reset so the next call can retry instead of caching the
        // rejected promise forever (which also leaves the port orphaned
        // if the server started before the failure).  See: #32387
        runtimePromise = null;
        throw err;
      }
      return runtime;
    };

    const sendError = (respond: (ok: boolean, payload?: unknown) => void, err: unknown) => {
      respond(false, { error: err instanceof Error ? err.message : String(err) });
    };

    const resolveCallMessageRequest = async (params: GatewayRequestHandlerOptions["params"]) => {
      const callId = typeof params?.callId === "string" ? params.callId.trim() : "";
      const message = typeof params?.message === "string" ? params.message.trim() : "";
      if (!callId || !message) {
        return { error: "callId and message required" } as const;
      }
      const rt = await ensureRuntime();
      return { rt, callId, message } as const;
    };
    const initiateCallAndRespond = async (params: {
      rt: VoiceCallRuntime;
      respond: GatewayRequestHandlerOptions["respond"];
      to: string;
      message?: string;
      mode?: "notify" | "conversation";
    }) => {
      const result = await params.rt.manager.initiateCall(params.to, undefined, {
        message: params.message,
        mode: params.mode,
      });
      if (!result.success) {
        params.respond(false, { error: result.error || "initiate failed" });
        return;
      }
      params.respond(true, { callId: result.callId, initiated: true });
    };

    const respondToCallMessageAction = async (params: {
      requestParams: GatewayRequestHandlerOptions["params"];
      respond: GatewayRequestHandlerOptions["respond"];
      action: (
        request: Exclude<Awaited<ReturnType<typeof resolveCallMessageRequest>>, { error: string }>,
      ) => Promise<{
        success: boolean;
        error?: string;
        transcript?: string;
      }>;
      failure: string;
      includeTranscript?: boolean;
    }) => {
      const request = await resolveCallMessageRequest(params.requestParams);
      if ("error" in request) {
        params.respond(false, { error: request.error });
        return;
      }
      const result = await params.action(request);
      if (!result.success) {
        params.respond(false, { error: result.error || params.failure });
        return;
      }
      params.respond(
        true,
        params.includeTranscript
          ? { success: true, transcript: result.transcript }
          : { success: true },
      );
    };

    api.registerGatewayMethod(
      "voicecall.initiate",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const message = typeof params?.message === "string" ? params.message.trim() : "";
          if (!message) {
            respond(false, { error: "message required" });
            return;
          }
          const rt = await ensureRuntime();
          const to =
            typeof params?.to === "string" && params.to.trim()
              ? params.to.trim()
              : rt.config.toNumber;
          if (!to) {
            respond(false, { error: "to required" });
            return;
          }
          const mode =
            params?.mode === "notify" || params?.mode === "conversation" ? params.mode : undefined;
          await initiateCallAndRespond({
            rt,
            respond,
            to,
            message,
            mode,
          });
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "voicecall.continue",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          await respondToCallMessageAction({
            requestParams: params,
            respond,
            action: (request) => request.rt.manager.continueCall(request.callId, request.message),
            failure: "continue failed",
            includeTranscript: true,
          });
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "voicecall.speak",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          await respondToCallMessageAction({
            requestParams: params,
            respond,
            action: (request) => request.rt.manager.speak(request.callId, request.message),
            failure: "speak failed",
          });
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "voicecall.end",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const callId = typeof params?.callId === "string" ? params.callId.trim() : "";
          if (!callId) {
            respond(false, { error: "callId required" });
            return;
          }
          const rt = await ensureRuntime();
          const result = await rt.manager.endCall(callId);
          if (!result.success) {
            respond(false, { error: result.error || "end failed" });
            return;
          }
          respond(true, { success: true });
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "voicecall.status",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const raw =
            typeof params?.callId === "string"
              ? params.callId.trim()
              : typeof params?.sid === "string"
                ? params.sid.trim()
                : "";
          if (!raw) {
            respond(false, { error: "callId required" });
            return;
          }
          const rt = await ensureRuntime();
          const call = rt.manager.getCall(raw) || rt.manager.getCallByProviderCallId(raw);
          if (!call) {
            respond(true, { found: false });
            return;
          }
          respond(true, { found: true, call });
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "voicecall.start",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const to = typeof params?.to === "string" ? params.to.trim() : "";
          const message = typeof params?.message === "string" ? params.message.trim() : "";
          if (!to) {
            respond(false, { error: "to required" });
            return;
          }
          const rt = await ensureRuntime();
          await initiateCallAndRespond({
            rt,
            respond,
            to,
            message: message || undefined,
          });
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerTool({
      name: "voice_call",
      label: "Voice Call",
      description: `Place a phone call and have a real voice conversation on the user's behalf.

ALWAYS use action="initiate_call" with mode="conversation" for any real call.
In this mode an embedded live AI on the phone handles the entire conversation
end-to-end. You do NOT call continue_call or speak_to_user — the live agent
already speaks and listens through the phone.

CRITICAL: the "message" param is the OPENING line the bot will speak to the
person who picks up. Keep it SHORT — ONE sentence, ≤15 words, plain spoken
Russian. Treat it like the FIRST thing you'd say after «Алло». Do NOT pack
multiple conditions, fallback options, or meta-instructions ("если..., то...",
"если для брони нужен..., то скажите...", "в конце зафиксируйте результат...")
into the message. Just the immediate ask, e.g.:
  "Здравствуйте. Подскажите, есть ли свободный столик на двоих на 21:30 сегодня?"
NOT: "Здравствуйте. Я звоню от имени Темирлана по поводу столика. Если на
20:00 нет, спросите про 21:00..." — that is a task brief, not speech.
The live agent already has its own brief in the session prompt; the message
is only the opening utterance. Long messages cause the bot to recite a
monologue at the callee, which is broken UX.

Also: do NOT include "от имени <name>", "по поручению <name>", "меня зовут"
in the message — the bot calls anonymously and provides the name only if
asked for booking. The name comes from the user task (which you pass
implicitly via the call), not from the spoken opening.

The tool BLOCKS until the call ends (or up to ~90s) and returns:
- "outcome":   structured result the live agent recorded — { status, summary, details }
               where status is one of: done | partial | no_result | voicemail | unclear.
               This is what you report back to the user.
- "transcript": full call transcript (both sides) as an array of { speaker, text }.
- "ended" and "endReason": call lifecycle info.

If "outcome" is present, prefer its "summary" verbatim when telling the user
what happened. Do NOT make a second call to the same number based on a partial
result — accept what was offered or ask the user before retrying.

continue_call / speak_to_user are legacy paths kept only for non-Asterisk
providers; never call them after initiate_call returns in conversation mode.`,
      parameters: VoiceCallToolSchema,
      async execute(_toolCallId, params) {
        const json = (payload: unknown) => ({
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
          details: payload,
        });

        try {
          const rt = await ensureRuntime();

          if (typeof params?.action === "string") {
            switch (params.action) {
              case "initiate_call": {
                const message = String(params.message || "").trim();
                if (!message) {
                  throw new Error("message required");
                }
                const to =
                  typeof params.to === "string" && params.to.trim()
                    ? params.to.trim()
                    : rt.config.toNumber;
                if (!to) {
                  throw new Error("to required");
                }
                const callMode =
                  params.mode === "notify" || params.mode === "conversation"
                    ? params.mode
                    : undefined;
                const result = await rt.manager.initiateCall(to, undefined, {
                  message,
                  mode: callMode,
                });
                if (!result.success) {
                  throw new Error(result.error || "initiate failed");
                }

                // Conversation mode with an embedded live agent (Asterisk + OpenAI
                // Realtime) drives turn-taking on the phone itself. Block the tool
                // until the call ends (or a short watchdog fires) and return the
                // structured outcome + full transcript so the caller-side agent can
                // report back to the user without doing continue_call gymnastics.
                if (callMode === "conversation") {
                  const callId = result.callId!;
                  const provider = rt.manager.getProvider();
                  const isEmbedded =
                    provider?.isEmbeddedAgentActive?.(
                      rt.manager.getCall(callId)?.providerCallId ?? "",
                    ) ?? false;
                  // Hard cap so the OpenClaw main agent's LLM request doesn't time
                  // out on long calls. Slightly under typical 120s LLM timeouts.
                  const maxWaitMs = 90_000;
                  const startedAt = Date.now();

                  if (isEmbedded) {
                    while (Date.now() - startedAt < maxWaitMs) {
                      const call = rt.manager.getCall(callId);
                      if (!call) break; // already finalized & evicted
                      const terminal = new Set([
                        "completed",
                        "hangup-user",
                        "hangup-bot",
                        "timeout",
                        "error",
                        "failed",
                        "no-answer",
                        "busy",
                        "voicemail",
                      ]);
                      if (terminal.has(call.state)) break;
                      await new Promise((r) => setTimeout(r, 500));
                    }
                    const finalCall =
                      rt.manager.getCall(callId) ??
                      (await rt.manager.getCallHistory(20)).find((c) => c.callId === callId) ??
                      null;
                    const outcome = provider?.getRecordedOutcome?.(callId) ?? null;
                    const transcript = finalCall?.transcript ?? [];
                    const endReason = finalCall?.endReason;
                    const ended = Boolean(finalCall?.endedAt) || !rt.manager.getCall(callId);
                    return json({
                      callId,
                      initiated: true,
                      ended,
                      endReason: endReason ?? null,
                      outcome,
                      transcript,
                      hint: outcome
                        ? "The AI on the phone recorded this outcome. Report it to the user in their language."
                        : "Call ended without a structured outcome — summarize the transcript for the user.",
                    });
                  }

                  // Legacy non-embedded path: keep the old "wait for first user
                  // reply" behavior so providers that need OpenClaw-side turn
                  // control (Twilio, mock) still work.
                  let ready = false;
                  while (Date.now() - startedAt < maxWaitMs) {
                    const call = rt.manager.getCall(callId);
                    if (!call || call.state === "failed") break;
                    if (call.state === "listening" || call.state === "active") {
                      ready = true;
                      break;
                    }
                    await new Promise((r) => setTimeout(r, 500));
                  }
                  if (ready) {
                    const continueResult = await rt.manager.continueCall(callId, "");
                    if (continueResult.success && continueResult.transcript) {
                      return json({
                        callId,
                        initiated: true,
                        userResponse: continueResult.transcript,
                        hint: "Use continue_call with callId to keep the conversation going. Use end_call when done.",
                      });
                    }
                  }
                }

                return json({ callId: result.callId, initiated: true });
              }
              case "continue_call": {
                const callId = String(params.callId || "").trim();
                const message = String(params.message || "").trim();
                if (!callId || !message) {
                  throw new Error("callId and message required");
                }
                const result = await rt.manager.continueCall(callId, message);
                if (!result.success) {
                  throw new Error(result.error || "continue failed");
                }
                return json({ success: true, transcript: result.transcript });
              }
              case "speak_to_user": {
                const callId = String(params.callId || "").trim();
                const message = String(params.message || "").trim();
                if (!callId || !message) {
                  throw new Error("callId and message required");
                }
                const result = await rt.manager.speak(callId, message);
                if (!result.success) {
                  throw new Error(result.error || "speak failed");
                }
                return json({ success: true });
              }
              case "end_call": {
                const callId = String(params.callId || "").trim();
                if (!callId) {
                  throw new Error("callId required");
                }
                const result = await rt.manager.endCall(callId);
                if (!result.success) {
                  throw new Error(result.error || "end failed");
                }
                return json({ success: true });
              }
              case "get_status": {
                const callId = String(params.callId || "").trim();
                if (!callId) {
                  throw new Error("callId required");
                }
                const call =
                  rt.manager.getCall(callId) || rt.manager.getCallByProviderCallId(callId);
                return json(call ? { found: true, call } : { found: false });
              }
            }
          }

          const mode = params?.mode ?? "call";
          if (mode === "status") {
            const sid = typeof params.sid === "string" ? params.sid.trim() : "";
            if (!sid) {
              throw new Error("sid required for status");
            }
            const call = rt.manager.getCall(sid) || rt.manager.getCallByProviderCallId(sid);
            return json(call ? { found: true, call } : { found: false });
          }

          const to =
            typeof params.to === "string" && params.to.trim()
              ? params.to.trim()
              : rt.config.toNumber;
          if (!to) {
            throw new Error("to required for call");
          }
          const result = await rt.manager.initiateCall(to, undefined, {
            message:
              typeof params.message === "string" && params.message.trim()
                ? params.message.trim()
                : undefined,
          });
          if (!result.success) {
            throw new Error(result.error || "initiate failed");
          }
          return json({ callId: result.callId, initiated: true });
        } catch (err) {
          return json({
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    });

    api.registerCli(
      ({ program }) =>
        registerVoiceCallCli({
          program,
          config,
          ensureRuntime,
          logger: api.logger,
        }),
      { commands: ["voicecall"] },
    );

    api.registerService({
      id: "voicecall",
      start: async () => {
        if (!config.enabled) {
          return;
        }
        try {
          await ensureRuntime();
        } catch (err) {
          api.logger.error(
            `[voice-call] Failed to start runtime: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      },
      stop: async () => {
        if (!runtimePromise) {
          return;
        }
        try {
          const rt = await runtimePromise;
          await rt.stop();
        } finally {
          runtimePromise = null;
          runtime = null;
        }
      },
    });
  },
});
