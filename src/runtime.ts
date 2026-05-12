import type { AsteriskConfig, VoiceCallConfig } from "./config.js";
import { resolveVoiceCallConfig, validateProviderConfig } from "./config.js";
import type { CoreAgentDeps, CoreConfig } from "./core-bridge.js";
import { CallManager } from "./manager.js";
import type { VoiceCallProvider } from "./providers/base.js";
import { MockProvider } from "./providers/mock.js";
import { PlivoProvider } from "./providers/plivo.js";
import { TelnyxProvider } from "./providers/telnyx.js";
import { TwilioProvider } from "./providers/twilio.js";
import { AsteriskProvider } from "./providers/asterisk.js";
import { MultiAsteriskProvider } from "./providers/multi-asterisk.js";
import type { TelephonyTtsRuntime } from "./telephony-tts.js";
import { createTelephonyTtsProvider } from "./telephony-tts.js";
import { startTunnel, type TunnelResult } from "./tunnel.js";
import { VoiceCallWebhookServer } from "./webhook.js";
import { cleanupTailscaleExposure, setupTailscaleExposure } from "./webhook/tailscale.js";

export type VoiceCallRuntime = {
  config: VoiceCallConfig;
  provider: VoiceCallProvider;
  manager: CallManager;
  webhookServer: VoiceCallWebhookServer;
  webhookUrl: string;
  publicUrl: string | null;
  stop: () => Promise<void>;
};

type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug?: (message: string) => void;
};

function createRuntimeResourceLifecycle(params: {
  config: VoiceCallConfig;
  webhookServer: VoiceCallWebhookServer;
}): {
  setTunnelResult: (result: TunnelResult | null) => void;
  stop: (opts?: { suppressErrors?: boolean }) => Promise<void>;
} {
  let tunnelResult: TunnelResult | null = null;
  let stopped = false;

  const runStep = async (step: () => Promise<void>, suppressErrors: boolean) => {
    if (suppressErrors) {
      await step().catch(() => {});
      return;
    }
    await step();
  };

  return {
    setTunnelResult: (result) => {
      tunnelResult = result;
    },
    stop: async (opts) => {
      if (stopped) {
        return;
      }
      stopped = true;
      const suppressErrors = opts?.suppressErrors ?? false;
      await runStep(async () => {
        if (tunnelResult) {
          await tunnelResult.stop();
        }
      }, suppressErrors);
      await runStep(async () => {
        await cleanupTailscaleExposure(params.config);
      }, suppressErrors);
      await runStep(async () => {
        await params.webhookServer.stop();
      }, suppressErrors);
    },
  };
}

function isLoopbackBind(bind: string | undefined): boolean {
  if (!bind) {
    return false;
  }
  return bind === "127.0.0.1" || bind === "::1" || bind === "localhost";
}

function withInboundGreetingFallback(
  config: VoiceCallConfig,
  asteriskConfig: AsteriskConfig | undefined,
): AsteriskConfig | undefined {
  if (!asteriskConfig || !config.inboundGreeting) {
    return asteriskConfig;
  }
  if (asteriskConfig.inboundProfiles?.defaultGreeting) {
    return asteriskConfig;
  }
  return {
    ...asteriskConfig,
    inboundProfiles: {
      ...asteriskConfig.inboundProfiles,
      defaultGreeting: config.inboundGreeting,
      overrides: asteriskConfig.inboundProfiles?.overrides ?? [],
    },
  };
}

function resolveProvider(config: VoiceCallConfig): VoiceCallProvider {
  const allowNgrokFreeTierLoopbackBypass =
    config.tunnel?.provider === "ngrok" &&
    isLoopbackBind(config.serve?.bind) &&
    (config.tunnel?.allowNgrokFreeTierLoopbackBypass ?? false);

  switch (config.provider) {
    case "telnyx":
      return new TelnyxProvider(
        {
          apiKey: config.telnyx?.apiKey,
          connectionId: config.telnyx?.connectionId,
          publicKey: config.telnyx?.publicKey,
        },
        {
          skipVerification: config.skipSignatureVerification,
        },
      );
    case "twilio":
      return new TwilioProvider(
        {
          accountSid: config.twilio?.accountSid,
          authToken: config.twilio?.authToken,
        },
        {
          allowNgrokFreeTierLoopbackBypass,
          publicUrl: config.publicUrl,
          skipVerification: config.skipSignatureVerification,
          streamPath: config.streaming?.enabled ? config.streaming.streamPath : undefined,
          webhookSecurity: config.webhookSecurity,
        },
      );
    case "plivo":
      return new PlivoProvider(
        {
          authId: config.plivo?.authId,
          authToken: config.plivo?.authToken,
        },
        {
          publicUrl: config.publicUrl,
          skipVerification: config.skipSignatureVerification,
          ringTimeoutSec: Math.max(1, Math.floor(config.ringTimeoutMs / 1000)),
          webhookSecurity: config.webhookSecurity,
        },
      );
    case "asterisk": {
      // Multi-cluster mode: config.asterisks is an array, each with its own
      // ARI + SIP trunk. OpenClaw picks which cluster dials out based on
      // phone-number prefix (e.g. KZ numbers via Tele2, RU numbers via Telfin).
      const clusters = (config.asterisks ?? []).filter((c) => c?.ariUrl);
      if (clusters.length > 0) {
        const entries = clusters.map((rawCluster, i) => {
          const c = withInboundGreetingFallback(config, rawCluster)!;
          return {
            name: c.name ?? `cluster-${i}`,
            routePrefixes: c.routePrefixes,
            isDefault: c.default,
            provider: new AsteriskProvider(c, {
              skipVerification: config.skipSignatureVerification,
            }),
          };
        });
        return new MultiAsteriskProvider(entries);
      }
      // Single-cluster legacy mode (unchanged behavior).
      const asteriskConfig = withInboundGreetingFallback(config, config.asterisk);
      return new AsteriskProvider(
        asteriskConfig ?? {},
        {
          skipVerification: config.skipSignatureVerification,
        },
      );
    }
    case "mock":
      return new MockProvider();
    default:
      throw new Error(`Unsupported voice-call provider: ${String(config.provider)}`);
  }
}

// Module-level singleton cache keyed on webhook port + provider.
// Prevents duplicate AsteriskProvider / ARI WebSocket initialisation when the
// plugin `register()` runs more than once per process (e.g. gateway + tool
// context both loading voice-call). Without this, two providers subscribe to
// the same Stasis app and the second one's cleanup hangs up active channels.
const runtimeCache = new Map<string, Promise<VoiceCallRuntime>>();

function cacheKey(config: VoiceCallConfig): string {
  const clusters = (config.asterisks ?? [])
    .map((c) => c?.ariUrl ?? "")
    .filter(Boolean)
    .sort()
    .join("|");
  return `${config.provider}:${config.serve?.port ?? 0}:${clusters}`;
}

export function createVoiceCallRuntime(params: {
  config: VoiceCallConfig;
  coreConfig: CoreConfig;
  agentRuntime: CoreAgentDeps;
  ttsRuntime?: TelephonyTtsRuntime;
  logger?: Logger;
  /**
   * Optional fan-out hook invoked once a call has been finalized (record
   * persisted, timers cleared). Consumers can use this to mirror call records
   * into their own workflow without blocking call cleanup.
   */
  onCallFinalized?: (call: import("./types.js").CallRecord) => void;
}): Promise<VoiceCallRuntime> {
  const log = params.logger ?? {
    info: console.log,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };
  const resolved = resolveVoiceCallConfig(params.config);
  if (!resolved.enabled) {
    return Promise.reject(new Error("Voice call disabled. Enable the plugin entry in config."));
  }
  const key = cacheKey(resolved);
  const cached = runtimeCache.get(key);
  if (cached) {
    log.info("[voice-call] Reusing existing runtime (singleton cache hit)");
    return cached;
  }
  const promise = buildVoiceCallRuntime(params, key);
  runtimeCache.set(key, promise);
  promise.catch(() => runtimeCache.delete(key));
  return promise;
}

async function buildVoiceCallRuntime(
  params: {
    config: VoiceCallConfig;
    coreConfig: CoreConfig;
    agentRuntime: CoreAgentDeps;
    ttsRuntime?: TelephonyTtsRuntime;
    logger?: Logger;
    onCallFinalized?: (call: import("./types.js").CallRecord) => void;
  },
  cacheKeyValue: string,
): Promise<VoiceCallRuntime> {
  const {
    config: rawConfig,
    coreConfig,
    agentRuntime,
    ttsRuntime,
    logger,
    onCallFinalized,
  } = params;
  const log = logger ?? {
    info: console.log,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };

  const config = resolveVoiceCallConfig(rawConfig);

  if (!config.enabled) {
    throw new Error("Voice call disabled. Enable the plugin entry in config.");
  }

  if (config.skipSignatureVerification) {
    log.warn(
      "[voice-call] SECURITY WARNING: skipSignatureVerification=true disables webhook signature verification (development only). Do not use in production.",
    );
  }

  const validation = validateProviderConfig(config);
  if (!validation.valid) {
    throw new Error(`Invalid voice-call config: ${validation.errors.join("; ")}`);
  }

  const provider = resolveProvider(config);
  const manager = new CallManager(config, undefined, { onCallFinalized });
  const webhookServer = new VoiceCallWebhookServer(
    config,
    manager,
    provider,
    coreConfig,
    agentRuntime,
  );
  const lifecycle = createRuntimeResourceLifecycle({ config, webhookServer });

  const localUrl = await webhookServer.start();

  // Wrap remaining initialization in try/catch so the webhook server is
  // properly stopped if any subsequent step fails.  Without this, the server
  // keeps the port bound while the runtime promise rejects, causing
  // EADDRINUSE on the next attempt.  See: #32387
  try {
    // Determine public URL - priority: config.publicUrl > tunnel > legacy tailscale
    let publicUrl: string | null = config.publicUrl ?? null;

    if (!publicUrl && config.tunnel?.provider && config.tunnel.provider !== "none") {
      try {
        const nextTunnelResult = await startTunnel({
          provider: config.tunnel.provider,
          port: config.serve.port,
          path: config.serve.path,
          ngrokAuthToken: config.tunnel.ngrokAuthToken,
          ngrokDomain: config.tunnel.ngrokDomain,
        });
        lifecycle.setTunnelResult(nextTunnelResult);
        publicUrl = nextTunnelResult?.publicUrl ?? null;
      } catch (err) {
        log.error(
          `[voice-call] Tunnel setup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (!publicUrl && config.tailscale?.mode !== "off") {
      publicUrl = await setupTailscaleExposure(config);
    }

    const webhookUrl = publicUrl ?? localUrl;

    if (publicUrl && provider.name === "twilio") {
      (provider as TwilioProvider).setPublicUrl(publicUrl);
    }

    if (provider.name === "twilio" && config.streaming?.enabled) {
      const twilioProvider = provider as TwilioProvider;
      if (ttsRuntime?.textToSpeechTelephony) {
        try {
          const ttsProvider = createTelephonyTtsProvider({
            coreConfig,
            ttsOverride: config.tts,
            runtime: ttsRuntime,
          });
          twilioProvider.setTTSProvider(ttsProvider);
          log.info("[voice-call] Telephony TTS provider configured");
        } catch (err) {
          log.warn(
            `[voice-call] Failed to initialize telephony TTS: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      } else {
        log.warn("[voice-call] Telephony TTS unavailable; streaming TTS disabled");
      }

      const mediaHandler = webhookServer.getMediaStreamHandler();
      if (mediaHandler) {
        twilioProvider.setMediaStreamHandler(mediaHandler);
        log.info("[voice-call] Media stream handler wired to provider");
      }
    }

    // Asterisk: connect ARI WebSocket, wire event delivery, and configure TTS.
    // Matches both single-cluster AsteriskProvider and multi-cluster wrapper.
    const isAsterisk =
      provider instanceof AsteriskProvider || provider instanceof MultiAsteriskProvider;
    if (isAsterisk) {
      const asteriskProvider = provider as AsteriskProvider | MultiAsteriskProvider;
      asteriskProvider.setEventCallback((event) => {
        manager.processEvent(event);

        // Auto-respond to speech events for conversation-mode calls (mirrors Twilio media stream logic).
        // Skip if the agent is already driving the conversation via continueCall (has active waiter).
        // Also skip when the call is running end-to-end with Realtime as the agent —
        // Realtime already generated the reply via VAD, duplicating here would dub on top.
        if (event.type === "call.speech" && event.isFinal && event.transcript) {
          const call = manager.getCall(event.callId);
          const providerCallId = call?.providerCallId;
          const isE2E = providerCallId
            ? asteriskProvider.isEmbeddedAgentActive(providerCallId)
            : false;
          if (call && !manager.hasActiveWaiter(call.callId) && !isE2E) {
            const callMode = call.metadata?.mode as string | undefined;
            const shouldRespond = call.direction === "inbound" || callMode === "conversation";
            if (shouldRespond) {
              webhookServer.handleInboundResponse(call.callId, event.transcript).catch((err) => {
                log.warn(`[voice-call] Asterisk auto-respond failed: ${err instanceof Error ? err.message : String(err)}`);
              });
            }
          }
        }
      });

      // Wire TTS provider for Asterisk (same as Twilio)
      if (ttsRuntime?.textToSpeechTelephony) {
        try {
          const ttsProvider = createTelephonyTtsProvider({
            coreConfig,
            ttsOverride: config.tts,
            runtime: ttsRuntime,
          });
          asteriskProvider.setTTSProvider(ttsProvider);
          log.info("[voice-call] Asterisk TTS provider configured");
        } catch (err) {
          log.warn(
            `[voice-call] Failed to initialize Asterisk TTS: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      } else {
        log.warn("[voice-call] Asterisk TTS unavailable; no ttsRuntime provided");
      }

      // Configure realtime voice (OpenAI Realtime API for bidirectional audio)
      const streamingKey =
        config.streaming?.openaiApiKey ??
        process.env.OPENAI_API_KEY ??
        "";
      if (streamingKey) {
        const realtimePrompt =
          config.asterisk?.realtimeSystemPrompt ??
          "You are a helpful, friendly voice assistant speaking over a phone call in Russian. Keep answers short, natural and conversational. If the user asks for information you don't have access to, politely say so. Do not read punctuation aloud. Do not explain that you are an AI unless asked directly.";
        asteriskProvider.setRealtimeConfig({
          apiKey: streamingKey,
          systemPrompt: realtimePrompt,
          voice: config.asterisk?.realtimeVoice ?? "marin",
          // VAD made less twitchy: bot was getting cut off mid-word by
          // background noise / breath / STT hallucinations on short clips.
          // Higher threshold filters quieter noise; longer silence window
          // means the model waits more before deciding the user took the
          // turn — at the cost of slightly slower turn-taking.
          vadThreshold: 0.65,
          vadPrefixPaddingMs: 300,
          vadSilenceDurationMs: 700,
          silencePaddingMs: 200,
        });
        log.info("[voice-call] Asterisk realtime voice configured (end-to-end agent)");
      } else {
        log.warn("[voice-call] No OpenAI API key for Asterisk realtime voice");
      }

      try {
        await asteriskProvider.connect();
        log.info("[voice-call] Asterisk ARI WebSocket connected");
      } catch (err) {
        log.warn(
          `[voice-call] Asterisk ARI initial connect failed (will retry): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    await manager.initialize(provider, webhookUrl);

    const stop = async () => {
      runtimeCache.delete(cacheKeyValue);
      if (
        provider instanceof AsteriskProvider ||
        provider instanceof MultiAsteriskProvider
      ) {
        await provider.disconnect();
      }
      await lifecycle.stop();
    };

    log.info("[voice-call] Runtime initialized");
    log.info(`[voice-call] Webhook URL: ${webhookUrl}`);
    if (publicUrl) {
      log.info(`[voice-call] Public URL: ${publicUrl}`);
    }

    return {
      config,
      provider,
      manager,
      webhookServer,
      webhookUrl,
      publicUrl,
      stop,
    };
  } catch (err) {
    // If any step after the server started fails, clean up every provisioned
    // resource (tunnel, tailscale exposure, and webhook server) so retries
    // don't leak processes or keep the port bound.
    await lifecycle.stop({ suppressErrors: true });
    throw err;
  }
}
