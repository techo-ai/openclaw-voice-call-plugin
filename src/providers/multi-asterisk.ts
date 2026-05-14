/**
 * Multi-Asterisk provider: routes outbound calls across several AsteriskProvider
 * instances based on phone-number prefix, and forwards inbound events from any
 * of them through a single CallManager sink.
 *
 * A single OpenClaw can then drive e.g. a KZ box with a Tele2 trunk and a RU
 * box with a Telfin trunk. Provider state (voiceSessions, metadata) still lives
 * in each underlying AsteriskProvider — the wrapper just dispatches calls to
 * the right one by looking up which cluster owns a given providerCallId.
 */

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
import type { RealtimeVoiceConfig } from "./asterisk-realtime.js";
import { AsteriskProvider, type AsteriskProviderOptions } from "./asterisk.js";
import type { VoiceCallProvider } from "./base.js";

interface ClusterConfig {
  name: string;
  routePrefixes: string[];
  isDefault: boolean;
  provider: AsteriskProvider;
}

export interface MultiAsteriskEntry {
  name: string;
  routePrefixes?: string[];
  isDefault?: boolean;
  provider: AsteriskProvider;
}

export class MultiAsteriskProvider implements VoiceCallProvider {
  name = "asterisk" as const;

  private readonly clusters: ClusterConfig[];
  /** providerCallId → cluster name, so we can route hangup/playTts back. */
  private readonly callIdToCluster = new Map<string, string>();
  private eventCallback: ((event: NormalizedEvent) => void) | null = null;

  constructor(entries: MultiAsteriskEntry[]) {
    if (entries.length === 0) {
      throw new Error("MultiAsteriskProvider requires at least one cluster");
    }
    this.clusters = entries.map((e) => ({
      name: e.name,
      routePrefixes: e.routePrefixes ?? [],
      isDefault: e.isDefault ?? false,
      provider: e.provider,
    }));
    // Exactly one default required.
    const defaults = this.clusters.filter((c) => c.isDefault);
    if (defaults.length === 0) {
      // Fallback: first cluster as default to avoid unroutable calls.
      this.clusters[0].isDefault = true;
    } else if (defaults.length > 1) {
      throw new Error(
        `MultiAsteriskProvider: at most one cluster may be marked default, got ${defaults.length}`,
      );
    }
  }

  /** Normalize a number to "7XXXXXXXXXX" form for prefix matching. */
  private normalize(phone: string): string {
    let s = phone.replace(/[^\d]/g, "");
    if (s.startsWith("8") && s.length === 11) {
      s = `7${s.slice(1)}`;
    }
    return s;
  }

  private pickCluster(to: string): ClusterConfig {
    const normalized = this.normalize(to);
    // Longest-prefix match wins. Skips empty routePrefixes.
    let best: { cluster: ClusterConfig; len: number } | null = null;
    for (const cluster of this.clusters) {
      for (const prefix of cluster.routePrefixes) {
        if (normalized.startsWith(prefix)) {
          if (!best || prefix.length > best.len) {
            best = { cluster, len: prefix.length };
          }
        }
      }
    }
    if (best) return best.cluster;
    const fallback = this.clusters.find((c) => c.isDefault);
    if (!fallback) {
      throw new Error(`MultiAsteriskProvider: no cluster matches ${to} and no default set`);
    }
    return fallback;
  }

  verifyWebhook(ctx: WebhookContext): WebhookVerificationResult {
    return this.clusters[0]!.provider.verifyWebhook(ctx);
  }

  parseWebhookEvent(ctx: WebhookContext): ProviderWebhookParseResult {
    // Asterisk uses ARI WebSocket, not HTTP webhooks. Delegate to first cluster
    // so any shared plumbing (e.g. internal self-loop posts) still works.
    return this.clusters[0]!.provider.parseWebhookEvent(ctx);
  }

  async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    const cluster = this.pickCluster(input.to);
    console.log(`[multi-asterisk] routing outbound to ${input.to} via cluster "${cluster.name}"`);
    const result = await cluster.provider.initiateCall(input);
    this.callIdToCluster.set(result.providerCallId, cluster.name);
    return result;
  }

  private providerFor(providerCallId: string): AsteriskProvider | undefined {
    const name = this.callIdToCluster.get(providerCallId);
    if (!name) return undefined;
    return this.clusters.find((c) => c.name === name)?.provider;
  }

  async hangupCall(input: HangupCallInput): Promise<void> {
    const p = this.providerFor(input.providerCallId);
    if (p) {
      await p.hangupCall(input);
    }
    this.callIdToCluster.delete(input.providerCallId);
  }

  async playTts(input: PlayTtsInput): Promise<void> {
    const p = this.providerFor(input.providerCallId);
    if (p) await p.playTts(input);
  }

  async startListening(input: StartListeningInput): Promise<void> {
    const p = this.providerFor(input.providerCallId);
    if (p) await p.startListening(input);
  }

  async stopListening(input: StopListeningInput): Promise<void> {
    const p = this.providerFor(input.providerCallId);
    if (p) await p.stopListening(input);
  }

  async getCallStatus(input: GetCallStatusInput): Promise<GetCallStatusResult> {
    const p = this.providerFor(input.providerCallId);
    if (!p) return { status: "not-found", isTerminal: true };
    return p.getCallStatus(input);
  }

  isEmbeddedAgentActive(providerCallId: string): boolean {
    const p = this.providerFor(providerCallId);
    return p ? p.isEndToEnd(providerCallId) : false;
  }

  // ---- Fan-out configuration helpers ----

  setRealtimeConfig(cfg: RealtimeVoiceConfig): void {
    for (const { provider } of this.clusters) {
      provider.setRealtimeConfig(cfg);
    }
  }

  setTTSProvider(tts: TelephonyTtsProvider): void {
    for (const { provider } of this.clusters) {
      provider.setTTSProvider(tts);
    }
  }

  setEventCallback(cb: (event: NormalizedEvent) => void): void {
    this.eventCallback = cb;
    for (const { name, provider } of this.clusters) {
      provider.setEventCallback((event) => {
        // Remember which cluster owns inbound calls so later hangup/tts works.
        if (event.type === "call.initiated" && event.providerCallId) {
          this.callIdToCluster.set(event.providerCallId, name);
        }
        if (event.type === "call.ended" && event.providerCallId) {
          const providerCallId = event.providerCallId;
          // Delete after manager processes it.
          queueMicrotask(() => this.callIdToCluster.delete(providerCallId));
        }
        this.eventCallback?.(event);
      });
    }
  }

  async connect(): Promise<void> {
    const attempts = this.clusters.map(({ name, provider }) =>
      provider
        .connect()
        .then(() => ({ ok: true as const, name }))
        .catch((err: unknown) => {
          console.warn(
            `[multi-asterisk] cluster "${name}" ARI initial connect failed (will retry): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          return { ok: false as const, name, err };
        }),
    );

    try {
      await Promise.any(
        attempts.map((attempt) =>
          attempt.then((result) => (result.ok ? undefined : Promise.reject(result.err))),
        ),
      );
    } catch (err) {
      throw new Error(
        `MultiAsteriskProvider: all cluster ARI initial connections failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    void Promise.all(attempts);
  }

  async disconnect(): Promise<void> {
    await Promise.all(this.clusters.map(({ provider }) => provider.disconnect()));
  }
}

export function createAsteriskProviders(
  entries: Array<{
    name: string;
    config: ConstructorParameters<typeof AsteriskProvider>[0];
    options?: AsteriskProviderOptions;
    routePrefixes?: string[];
    isDefault?: boolean;
  }>,
): MultiAsteriskEntry[] {
  return entries.map((e) => ({
    name: e.name,
    routePrefixes: e.routePrefixes,
    isDefault: e.isDefault,
    provider: new AsteriskProvider(e.config, e.options ?? {}),
  }));
}
