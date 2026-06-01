import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted: factory must be self-contained.
// We reuse the same MockWebSocket pattern from asterisk-realtime.outcome.test.ts.
vi.mock("ws", () => {
  const { EventEmitter } = require("node:events") as typeof import("node:events");
  class MockWebSocketImpl extends EventEmitter {
    static readonly OPEN = 1;
    static readonly instances: MockWebSocketImpl[] = [];
    readyState: number = 1;
    sentPayloads: string[] = [];
    closeCalled = false;
    constructor(_url: string, _opts?: unknown) {
      super();
      MockWebSocketImpl.instances.push(this);
      queueMicrotask(() => this.emit("open"));
    }
    send(data: unknown): void {
      if (typeof data === "string") this.sentPayloads.push(data);
    }
    close(): void {
      this.closeCalled = true;
      this.readyState = 3;
      this.emit("close");
    }
  }
  return { default: MockWebSocketImpl, WebSocket: MockWebSocketImpl };
});

import WebSocketImport from "ws";
import { createRealtimeVoiceSession } from "./asterisk-realtime.js";

type MockWS = {
  readyState: number;
  sentPayloads: string[];
  closeCalled: boolean;
  close(): void;
  emit(event: string, ...args: unknown[]): boolean;
};

const getInstances = (): MockWS[] =>
  (WebSocketImport as unknown as { instances: MockWS[] }).instances;

const fakeReceiver = () =>
  ({
    onAudio: null as ((b: Buffer) => void) | null,
    close: () => {},
  }) as unknown as Parameters<typeof createRealtimeVoiceSession>[1];

describe("VOICE-08: Absolute wall-clock duration kill", () => {
  beforeEach(() => {
    getInstances().length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    for (const ws of getInstances()) {
      if (!ws.closeCalled) ws.close();
    }
    getInstances().length = 0;
    vi.useRealTimers();
  });

  // Test 1: After maxDurationSeconds, WS is closed and hangup is requested,
  // even with NO ARI event delivered.
  it("fires absolute kill at maxDurationSeconds even with no ARI events", async () => {
    const maxDurationSeconds = 10; // Use 10s for test speed; fake timers make it instant.
    let hangupRequested = false;

    const session = createRealtimeVoiceSession(
      {
        apiKey: "sk-test",
        systemPrompt: "Test prompt",
        model: "gpt-realtime-mini-2025-12-15",
        maxDurationSeconds,
      },
      fakeReceiver(),
      () => null,
    );

    session.onHangupRequested = () => {
      hangupRequested = true;
    };

    // start() creates the WS and sets the absoluteKillTimer.
    const startPromise = session.start();
    // Flush the microtask that emits "open" on the mock WS.
    await Promise.resolve();
    await startPromise;

    const ws = getInstances()[0]!;
    expect(ws).toBeDefined();
    expect(ws.closeCalled).toBe(false); // not killed yet

    // Advance fake time past the maxDurationSeconds limit.
    vi.advanceTimersByTime(maxDurationSeconds * 1000 + 100);

    // The absolute kill timer fired — WS should be closed and hangup requested.
    expect(ws.closeCalled).toBe(true);
    expect(hangupRequested).toBe(true);
  });

  // Test 2: Normal stop before the timer fires clears the kill timer.
  // No double-close, no late hangup after normal end.
  it("clearing kill timer on normal stop prevents late hangup", async () => {
    const maxDurationSeconds = 60;
    let hangupRequested = false;

    const session = createRealtimeVoiceSession(
      {
        apiKey: "sk-test",
        systemPrompt: "Test prompt",
        model: "gpt-realtime-mini-2025-12-15",
        maxDurationSeconds,
      },
      fakeReceiver(),
      () => null,
    );

    session.onHangupRequested = () => {
      hangupRequested = true;
    };

    const startPromise = session.start();
    await Promise.resolve();
    await startPromise;

    const ws = getInstances()[0]!;
    expect(ws.closeCalled).toBe(false);

    // Normal stop — clears the absoluteKillTimer.
    session.stop();
    expect(ws.closeCalled).toBe(true); // stop() closes the WS

    // Advance time past the original kill timer threshold.
    // The timer was cleared in stop(), so no additional hangup should fire.
    const hangupCountBefore = hangupRequested ? 1 : 0;
    vi.advanceTimersByTime(maxDurationSeconds * 1000 + 1000);

    // hangupRequested must NOT change after stop() — the kill timer is cleared.
    const hangupCountAfter = hangupRequested ? 1 : 0;
    expect(hangupCountAfter).toBe(hangupCountBefore);
    // stop() itself doesn't call onHangupRequested — that's the kill timer's job.
    // Normal stop just closes WS gracefully.
    expect(hangupRequested).toBe(false);
  });
});
