import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted: factory must be self-contained — no closure over outer
// classes. We keep the constructed instances on the module export so tests can
// grab them after start() and feed events / inspect sent payloads.
vi.mock("ws", () => {
  const { EventEmitter } = require("node:events") as typeof import("node:events");
  class MockWebSocketImpl extends EventEmitter {
    static readonly OPEN = 1;
    static readonly instances: MockWebSocketImpl[] = [];
    readyState: number = 1;
    sentPayloads: string[] = [];
    constructor(_url: string, _opts?: unknown) {
      super();
      MockWebSocketImpl.instances.push(this);
      queueMicrotask(() => this.emit("open"));
    }
    send(data: unknown): void {
      if (typeof data === "string") this.sentPayloads.push(data);
    }
    close(): void {
      this.readyState = 3;
      this.emit("close");
    }
    feed(event: object): void {
      this.emit("message", Buffer.from(JSON.stringify(event)));
    }
  }
  return { default: MockWebSocketImpl, WebSocket: MockWebSocketImpl };
});

import WebSocketImport from "ws";
import { createRealtimeVoiceSession } from "./asterisk-realtime.js";

type MockWS = {
  readyState: number;
  sentPayloads: string[];
  feed(event: object): void;
  close(): void;
};

const getInstances = (): MockWS[] =>
  (WebSocketImport as unknown as { instances: MockWS[] }).instances;

const fakeReceiver = () =>
  ({
    onAudio: null as ((b: Buffer) => void) | null,
    close: () => {},
  }) as unknown as Parameters<typeof createRealtimeVoiceSession>[1];

describe("Realtime outcome_summary tool wiring", () => {
  beforeEach(() => {
    getInstances().length = 0;
  });

  afterEach(() => {
    for (const ws of getInstances()) ws.close();
    getInstances().length = 0;
  });

  it("registers both outcome_summary and end_call tools in session.update (GA wire)", async () => {
    const session = createRealtimeVoiceSession(
      {
        apiKey: "sk-test",
        systemPrompt: "Test system prompt",
        model: "gpt-realtime-2",
      },
      fakeReceiver(),
      () => null,
    );
    await session.start();

    const ws = getInstances()[0]!;
    const sessionUpdate = ws.sentPayloads
      .map((p) => JSON.parse(p) as { type?: string; session?: { tools?: Array<{ name?: string }> } })
      .find((p) => p.type === "session.update");

    expect(sessionUpdate).toBeDefined();
    const toolNames = (sessionUpdate!.session?.tools ?? []).map((t) => t.name);
    expect(toolNames).toContain("outcome_summary");
    expect(toolNames).toContain("end_call");
    expect(toolNames.indexOf("outcome_summary")).toBeLessThan(toolNames.indexOf("end_call"));

    session.stop();
  });

  it("captures outcome from function_call_arguments.done and exposes via getLastOutcome", async () => {
    const session = createRealtimeVoiceSession(
      {
        apiKey: "sk-test",
        systemPrompt: "Test system prompt",
        model: "gpt-realtime-2",
      },
      fakeReceiver(),
      () => null,
    );
    const captured: Array<{ status: string; summary: string }> = [];
    session.onOutcomeRecorded = (outcome) => {
      captured.push({ status: outcome.status, summary: outcome.summary });
    };

    await session.start();
    const ws = getInstances()[0]!;

    ws.feed({
      type: "response.function_call_arguments.done",
      name: "outcome_summary",
      call_id: "call_abc",
      arguments: JSON.stringify({
        status: "partial",
        summary: "Свободно только 21:30, на 20:30 занято",
        details: "Ресторан предложил перенести на 21:30",
      }),
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({
      status: "partial",
      summary: "Свободно только 21:30, на 20:30 занято",
    });

    const last = session.getLastOutcome();
    expect(last).not.toBeNull();
    expect(last!.status).toBe("partial");
    expect(last!.details).toBe("Ресторан предложил перенести на 21:30");
    expect(typeof last!.recordedAt).toBe("number");

    const ack = ws.sentPayloads
      .map((p) => JSON.parse(p) as { type?: string; item?: { type?: string; output?: string } })
      .find((p) => p.type === "conversation.item.create" && p.item?.type === "function_call_output");
    expect(ack).toBeDefined();
    expect(JSON.parse(ack!.item!.output!)).toEqual({ ok: true, recorded: true });

    session.stop();
  });

  it("coerces unknown status to 'unclear' to keep the contract safe", async () => {
    const session = createRealtimeVoiceSession(
      {
        apiKey: "sk-test",
        systemPrompt: "Test system prompt",
        model: "gpt-realtime-2",
      },
      fakeReceiver(),
      () => null,
    );
    await session.start();
    const ws = getInstances()[0]!;

    ws.feed({
      type: "response.function_call_arguments.done",
      name: "outcome_summary",
      call_id: "call_xyz",
      arguments: JSON.stringify({
        status: "weird-status-value",
        summary: "Something happened",
      }),
    });

    expect(session.getLastOutcome()?.status).toBe("unclear");
    session.stop();
  });
});
