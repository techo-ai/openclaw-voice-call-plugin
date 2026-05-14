import { describe, expect, it, vi } from "vitest";
import type { InitiateCallInput } from "../types.js";
import type { AsteriskProvider } from "./asterisk.js";
import { MultiAsteriskProvider } from "./multi-asterisk.js";

function createProvider(providerCallId: string, status = "in-progress") {
  return {
    parseWebhookEvent: vi.fn(() => ({ events: [], statusCode: 200 })),
    verifyWebhook: vi.fn(() => ({ ok: true })),
    initiateCall: vi.fn(async () => ({ providerCallId, status: "initiated" as const })),
    hangupCall: vi.fn(async () => {}),
    playTts: vi.fn(async () => {}),
    startListening: vi.fn(async () => {}),
    stopListening: vi.fn(async () => {}),
    getCallStatus: vi.fn(async () => ({ status, isTerminal: false })),
    isEndToEnd: vi.fn(() => false),
    isEmbeddedAgentActive: vi.fn(() => false),
    setRealtimeConfig: vi.fn(),
    setTTSProvider: vi.fn(),
    setEventCallback: vi.fn(),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
  } as unknown as AsteriskProvider & {
    initiateCall: ReturnType<typeof vi.fn>;
    getCallStatus: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  };
}

function input(to: string): InitiateCallInput {
  return {
    callId: `call-${to}`,
    from: "+15550000000",
    to,
    webhookUrl: "http://localhost/voice/webhook",
  };
}

describe("MultiAsteriskProvider", () => {
  it("routes outbound calls by longest matching prefix", async () => {
    const primary = createProvider("primary-call");
    const secondary = createProvider("secondary-call");
    const provider = new MultiAsteriskProvider([
      { name: "primary", routePrefixes: ["1"], isDefault: true, provider: primary },
      { name: "secondary", routePrefixes: ["1555"], provider: secondary },
    ]);

    const result = await provider.initiateCall(input("+15550001234"));

    expect(result.providerCallId).toBe("secondary-call");
    expect(secondary.initiateCall).toHaveBeenCalledOnce();
    expect(primary.initiateCall).not.toHaveBeenCalled();
  });

  it("uses the default cluster when no prefix matches and delegates getCallStatus", async () => {
    const primary = createProvider("primary-call", "ringing");
    const secondary = createProvider("secondary-call");
    const provider = new MultiAsteriskProvider([
      { name: "primary", routePrefixes: ["1"], isDefault: true, provider: primary },
      { name: "secondary", routePrefixes: ["44"], provider: secondary },
    ]);

    const result = await provider.initiateCall(input("+33123456789"));
    const status = await provider.getCallStatus({ providerCallId: result.providerCallId });

    expect(result.providerCallId).toBe("primary-call");
    expect(status).toEqual({ status: "ringing", isTerminal: false });
    expect(primary.getCallStatus).toHaveBeenCalledWith({ providerCallId: "primary-call" });
  });

  it("normalizes leading 8 before prefix matching", async () => {
    const primary = createProvider("primary-call");
    const kz = createProvider("kz-call");
    const provider = new MultiAsteriskProvider([
      { name: "primary", routePrefixes: ["1"], isDefault: true, provider: primary },
      { name: "kz", routePrefixes: ["77"], provider: kz },
    ]);

    const result = await provider.initiateCall(input("87029990503"));

    expect(result.providerCallId).toBe("kz-call");
    expect(kz.initiateCall).toHaveBeenCalledOnce();
  });

  it("does not block startup on a slow secondary cluster once another connects", async () => {
    const primary = createProvider("primary-call");
    const secondary = createProvider("secondary-call");
    let resolveSecondary!: () => void;
    secondary.connect.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSecondary = resolve;
        }),
    );
    const provider = new MultiAsteriskProvider([
      { name: "primary", routePrefixes: ["1"], isDefault: true, provider: primary },
      { name: "secondary", routePrefixes: ["44"], provider: secondary },
    ]);

    await expect(provider.connect()).resolves.toBeUndefined();

    expect(primary.connect).toHaveBeenCalledOnce();
    expect(secondary.connect).toHaveBeenCalledOnce();
    resolveSecondary();
  });

  it("fails startup when every cluster initial connection fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const primary = createProvider("primary-call");
    const secondary = createProvider("secondary-call");
    primary.connect.mockRejectedValue(new Error("primary down"));
    secondary.connect.mockRejectedValue(new Error("secondary down"));
    const provider = new MultiAsteriskProvider([
      { name: "primary", routePrefixes: ["1"], isDefault: true, provider: primary },
      { name: "secondary", routePrefixes: ["44"], provider: secondary },
    ]);

    await expect(provider.connect()).rejects.toThrow(/all cluster ARI initial connections failed/);
    warn.mockRestore();
  });
});
