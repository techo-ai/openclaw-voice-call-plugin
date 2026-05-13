import { describe, expect, it } from "vitest";
import {
  normalizeAsteriskCallerNumber,
  rewriteAsteriskOutboundNumber,
  resolveAsteriskInboundProfile,
} from "./asterisk.js";

describe("Asterisk inbound profiles", () => {
  it("normalizes caller numbers for profile matching", () => {
    expect(normalizeAsteriskCallerNumber("+15550001234")).toBe("15550001234");
    expect(normalizeAsteriskCallerNumber("81234567890")).toBe("71234567890");
    expect(normalizeAsteriskCallerNumber(undefined)).toBe("");
  });

  it("uses the default inbound profile when no caller override matches", () => {
    const profile = resolveAsteriskInboundProfile(
      {
        inboundProfiles: {
          defaultGreeting: "Hello from default",
          defaultSystemPrompt: "Default inbound prompt",
          overrides: [
            {
              callerNumbers: ["+15550009999"],
              greeting: "Known caller greeting",
              systemPrompt: "Known caller prompt",
            },
          ],
        },
      },
      "+15550001234",
    );

    expect(profile).toEqual({
      greeting: "Hello from default",
      systemPrompt: "Default inbound prompt",
    });
  });

  it("uses caller-number-specific overrides after normalization", () => {
    const profile = resolveAsteriskInboundProfile(
      {
        inboundProfiles: {
          defaultGreeting: "Hello from default",
          defaultSystemPrompt: "Default inbound prompt",
          overrides: [
            {
              callerNumbers: ["71234567890"],
              greeting: "Direct caller greeting",
              systemPrompt: "Direct caller prompt",
            },
          ],
        },
      },
      "81234567890",
    );

    expect(profile).toEqual({
      greeting: "Direct caller greeting",
      systemPrompt: "Direct caller prompt",
    });
  });

  it("falls back to inboundGreeting and realtimeSystemPrompt when profile fields are absent", () => {
    const profile = resolveAsteriskInboundProfile(
      {
        realtimeSystemPrompt: "Global realtime prompt",
        inboundProfiles: {
          overrides: [],
        },
      },
      "+15550001234",
      "Top-level inbound greeting",
    );

    expect(profile).toEqual({
      greeting: "Top-level inbound greeting",
      systemPrompt: "Global realtime prompt",
    });
  });

  it("rewrites outbound numbers before creating provider endpoints", () => {
    expect(
      rewriteAsteriskOutboundNumber("+77123456789", [
        { pattern: "^7(\\d{10})$", replace: "8$1" },
      ]),
    ).toBe("87123456789");
    expect(
      rewriteAsteriskOutboundNumber("15550001234", [
        { pattern: "^7(\\d{10})$", replace: "8$1" },
      ]),
    ).toBe("15550001234");
  });
});
