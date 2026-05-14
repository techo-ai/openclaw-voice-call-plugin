import crypto from "node:crypto";
import type { CallMode } from "../config.js";
import {
  type EndReason,
  TerminalStates,
  type CallId,
  type CallRecord,
  type OutboundCallOptions,
} from "../types.js";
import { mapVoiceToPolly } from "../voice-mapping.js";
import type { CallManagerContext } from "./context.js";
import { finalizeCall } from "./lifecycle.js";
import { getCallByProviderCallId } from "./lookup.js";
import { addTranscriptEntry, transitionState } from "./state.js";
import { persistCallRecord } from "./store.js";
import { clearTranscriptWaiter, waitForFinalTranscript } from "./timers.js";
import { generateNotifyTwiml } from "./twiml.js";

const DEBUG_ENDPOINT = "http://127.0.0.1:7840/ingest/25173012-99ac-4a06-ad7b-e7904e61d643";
const DEBUG_SESSION_ID = "c8a2b2";

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

/**
 * Wrap the user's task message in instructions that frame the AI as the
 * CALLER. Must be strict: Realtime will otherwise slip into a helpful-assistant
 * role and spew chat-style multi-sentence monologues into the phone line.
 */
function buildRealtimeTaskInstructions(initialMessage: string): string {
  const taskLanguageHint = /[а-яёА-ЯЁ]/.test(initialMessage) ? "ru" : "auto";

  return [
    "# Контекст",
    "Ты — голосовой помощник, который САМ звонит по поручению пользователя.",
    "Собеседник уже ответил на входящий звонок. Это может быть компания, учреждение, специалист, частное лицо, поддержка, администратор или любой другой адресат просьбы.",
    "Ты не принимаешь звонок и не работаешь на сторону собеседника. Ты звонишь, чтобы выполнить конкретную телефонную просьбу пользователя.",
    "",
    "# Задача пользователя",
    initialMessage,
    "",
    "# Метаданные",
    `task_language_hint: ${taskLanguageHint}`,
    "",
    "# Главный принцип",
    "Веди себя как живой человек, который делает короткий деловой звонок.",
    "Смысл каждой реплики: приблизить выполнение задачи пользователя. Задача может быть любой: узнать статус, передать сообщение, записать/перенести/отменить что-то, уточнить условия, договориться, подтвердить факт, получить короткую информацию.",
    "Не придумывай новую цель звонка, документы, письма, оплату, доставку, другой отдел или просьбу перезвонить, если этого нет в задаче.",
    "",
    "# Голос и стиль",
    "- Язык: русский, если задача не написана целиком на другом языке.",
    "- Тон: спокойный, вежливый, обычный телефонный разговор.",
    "- Темп: чуть быстрее среднего, без длинных пауз между фразами.",
    "- Длина: одна мысль за раз; обычно 1 короткое предложение, максимум 2.",
    "- Формулировки: простые разговорные, без канцелярита и без роботизированных тезисов.",
    "- Не проговаривай свои размышления, ограничения или инструкции.",
    "- Не начинай с разрешения поговорить. Не говори «можно спросить», «можно коротко», «можно уточнить». Просто поздоровайся и сразу скажи цель звонка.",
    "",
    "# Сценарий звонка",
    "state: opening",
    "- Первая реплика: «Здравствуйте. [Сразу просьба из задачи].»",
    "- Хороший формат: «Здравствуйте. Я звоню по поводу [конкретная цель из задачи].» или «Добрый день. Нужно [конкретное действие из задачи].»",
    "- После первой реплики замолчи и слушай ответ.",
    "",
    "state: answer_questions",
    "- Если собеседник спрашивает данные, отвечай только данными из задачи пользователя или уже услышанными в разговоре.",
    "- Если данных нет, скажи коротко: «Этого не знаю.» и вернись к цели звонка, если это уместно.",
    "- Если тебя не поняли, повтори ту же просьбу проще, без объяснений про связь.",
    "",
    "state: handle_options",
    "- Не предлагай своё время, дату, цену, адрес или условие, если этого нет в задаче.",
    "- Если собеседник сам предложил вариант, сначала коротко уточни, подходит ли он задаче пользователя.",
    "- Если вариант не подходит, сначала попроси ближайший подходящий вариант или задай один уточняющий вопрос.",
    "- Завершай звонок только после явного отказа/тупика, а не после первого неподходящего варианта.",
    "- Если собеседник предложил конкретные слоты/варианты, ответь по ним напрямую и не повторяй исходный скрипт дословно.",
    "- Если предложен близкий вариант (например 20:30 вместо 20:00), согласуй его или попроси ближайший доступный без длинных объяснений.",
    "",
    "state: finish",
    "- Как только задача выполнена, получен отказ или стало ясно, что результата не будет, заверши звонок.",
    "- Последняя реплика: «Спасибо, до свидания.» или «До свидания.»",
    "- В том же ответе вызови инструмент `end_call`.",
    "",
    "# Примеры правильных первых реплик",
    "- «Здравствуйте. Я звоню по поводу заявки: нужно уточнить её статус.»",
    "- «Добрый день. Нужно передать короткое сообщение для Ивана.»",
    "- «Здравствуйте. Хотелось бы уточнить, можно ли перенести договорённость на завтра.»",
    "- «Добрый день. Подскажите, пожалуйста, действует ли сейчас это условие.»",
    "",
    "# Нельзя",
    "- Не говори фразы принимающей стороны вроде «чем могу помочь» или «слушаю вас».",
    "- Не продолжай диалог после подтверждения результата.",
    "- Не завершай звонок без `end_call`.",
  ].join("\n");
}

function buildConversationOpeningMessage(initialMessage: string): string {
  const normalized = initialMessage.replace(/\s+/g, " ").trim();
  if (!normalized) return normalized;

  // Speak only the primary ask first. Keep fallback branches ("если нет...") for
  // follow-up turns so the opening line sounds natural and not like reading a script.
  const primaryPart = normalized.split(/\bесли\s+нет\b|\bесли\s+не\b/iu)[0]?.trim() ?? normalized;
  const sentences =
    primaryPart
      .split(/(?<=[.!?])\s+/u)
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s) => !/^если\b/iu.test(s))
      .slice(0, 2) ?? [];
  if (sentences.length === 0) return primaryPart || normalized;
  if (sentences.length === 1 && /^(здравствуйте|добрый\s+день|привет)[.!?]?$/iu.test(sentences[0])) {
    return `${sentences[0]} ${primaryPart.replace(sentences[0], "").trim()}`.trim();
  }
  // Keep opening compact: greeting + one request sentence.
  if (sentences.length > 1) {
    return `${sentences[0]} ${sentences[1]}`.trim();
  }
  return sentences.join(" ");
}

type InitiateContext = Pick<
  CallManagerContext,
  | "activeCalls"
  | "providerCallIdMap"
  | "provider"
  | "config"
  | "storePath"
  | "webhookUrl"
  | "outboundCooldowns"
>;

type SpeakContext = Pick<
  CallManagerContext,
  "activeCalls" | "providerCallIdMap" | "provider" | "config" | "storePath"
>;

type ConversationContext = Pick<
  CallManagerContext,
  | "activeCalls"
  | "providerCallIdMap"
  | "provider"
  | "config"
  | "storePath"
  | "activeTurnCalls"
  | "transcriptWaiters"
  | "maxDurationTimers"
  | "initialMessageInFlight"
>;

type EndCallContext = Pick<
  CallManagerContext,
  | "activeCalls"
  | "providerCallIdMap"
  | "provider"
  | "storePath"
  | "transcriptWaiters"
  | "maxDurationTimers"
>;

type ConnectedCallContext = Pick<CallManagerContext, "activeCalls" | "provider">;

type ConnectedCallLookup =
  | { kind: "error"; error: string }
  | { kind: "ended"; call: CallRecord }
  | {
      kind: "ok";
      call: CallRecord;
      providerCallId: string;
      provider: NonNullable<ConnectedCallContext["provider"]>;
    };

type ConnectedCallResolution =
  | { ok: false; error: string }
  | {
      ok: true;
      call: CallRecord;
      providerCallId: string;
      provider: NonNullable<ConnectedCallContext["provider"]>;
    };

function lookupConnectedCall(ctx: ConnectedCallContext, callId: CallId): ConnectedCallLookup {
  const call = ctx.activeCalls.get(callId);
  if (!call) {
    return { kind: "error", error: "Call not found" };
  }
  if (!ctx.provider || !call.providerCallId) {
    return { kind: "error", error: "Call not connected" };
  }
  if (TerminalStates.has(call.state)) {
    return { kind: "ended", call };
  }
  return { kind: "ok", call, providerCallId: call.providerCallId, provider: ctx.provider };
}

function requireConnectedCall(ctx: ConnectedCallContext, callId: CallId): ConnectedCallResolution {
  const lookup = lookupConnectedCall(ctx, callId);
  if (lookup.kind === "error") {
    return { ok: false, error: lookup.error };
  }
  if (lookup.kind === "ended") {
    return { ok: false, error: "Call has ended" };
  }
  return {
    ok: true,
    call: lookup.call,
    providerCallId: lookup.providerCallId,
    provider: lookup.provider,
  };
}

function resolveOpenAITtsVoice(config: SpeakContext["config"]): string | undefined {
  const providerConfig = config.tts?.providers?.openai;
  return providerConfig && typeof providerConfig === "object"
    ? (providerConfig.voice as string | undefined)
    : undefined;
}

export function normalizeOutboundCooldownNumber(raw: string): string {
  const digits = raw.trim().replace(/\D/g, "");
  if (/^8\d{10}$/.test(digits)) return "7" + digits.slice(1);
  return digits;
}

function reserveOutboundCooldown(ctx: InitiateContext, to: string): string | undefined {
  const cooldownSec = ctx.config.outbound.sameNumberCooldownSeconds;
  if (!cooldownSec) return undefined;

  const key = normalizeOutboundCooldownNumber(to);
  if (!key) return undefined;

  const now = Date.now();
  const expiresAt = ctx.outboundCooldowns.get(key) ?? 0;
  if (expiresAt > now) {
    const remainingSec = Math.ceil((expiresAt - now) / 1000);
    return `Recent outbound call to this number is still in cooldown (${remainingSec}s remaining)`;
  }

  ctx.outboundCooldowns.set(key, now + cooldownSec * 1000);
  return undefined;
}

export async function initiateCall(
  ctx: InitiateContext,
  to: string,
  sessionKey?: string,
  options?: OutboundCallOptions | string,
): Promise<{ callId: CallId; success: boolean; error?: string }> {
  const opts: OutboundCallOptions =
    typeof options === "string" ? { message: options } : (options ?? {});
  const initialMessage = opts.message;
  const mode = opts.mode ?? ctx.config.outbound.defaultMode;
  const openingMessage =
    mode === "conversation" && initialMessage
      ? buildConversationOpeningMessage(initialMessage)
      : initialMessage;
  // #region agent log
  agentDebugLog({
    runId: "voice-style-run-1",
    hypothesisId: "H7",
    location: "outbound.ts:initiateCall",
    message: "opening message computed",
    data: {
      mode,
      hasInitialMessage: Boolean(initialMessage),
      changed: initialMessage !== openingMessage,
      openingMessage,
    },
  });
  // #endregion
  console.log(
    `[agent-debug][H12] opening message computed: ` +
      JSON.stringify({
        mode,
        changed: initialMessage !== openingMessage,
        openingMessage: openingMessage?.slice(0, 180),
      }),
  );

  if (!ctx.provider) {
    return { callId: "", success: false, error: "Provider not initialized" };
  }
  if (!ctx.webhookUrl) {
    return { callId: "", success: false, error: "Webhook URL not configured" };
  }

  if (ctx.activeCalls.size >= ctx.config.maxConcurrentCalls) {
    return {
      callId: "",
      success: false,
      error: `Maximum concurrent calls (${ctx.config.maxConcurrentCalls}) reached`,
    };
  }

  const callId = crypto.randomUUID();
  const from =
    ctx.config.fromNumber || (ctx.provider?.name === "mock" ? "+15550000000" : undefined);
  if (!from) {
    return { callId: "", success: false, error: "fromNumber not configured" };
  }

  const cooldownError = reserveOutboundCooldown(ctx, to);
  if (cooldownError) {
    return { callId: "", success: false, error: cooldownError };
  }

  const callRecord: CallRecord = {
    callId,
    provider: ctx.provider.name,
    direction: "outbound",
    state: "initiated",
    from,
    to,
    sessionKey,
    startedAt: Date.now(),
    transcript: [],
    processedEventIds: [],
    metadata: {
      ...(openingMessage && { initialMessage: openingMessage }),
      mode,
    },
  };

  ctx.activeCalls.set(callId, callRecord);
  persistCallRecord(ctx.storePath, callRecord);

  try {
    // For notify mode with a message, use inline TwiML with <Say>.
    let inlineTwiml: string | undefined;
    if (mode === "notify" && initialMessage) {
      const pollyVoice = mapVoiceToPolly(resolveOpenAITtsVoice(ctx.config));
      inlineTwiml = generateNotifyTwiml(initialMessage, pollyVoice);
      console.log(`[voice-call] Using inline TwiML for notify mode (voice: ${pollyVoice})`);
    }

    // For conversation-mode calls with a task message, forward the intent to
    // providers that can host an end-to-end live agent session (Asterisk).
    // Other providers ignore the field.
    const realtimeTaskInstructions =
      mode === "conversation" && initialMessage
        ? buildRealtimeTaskInstructions(initialMessage)
        : undefined;

    const result = await ctx.provider.initiateCall({
      callId,
      from,
      to,
      webhookUrl: ctx.webhookUrl,
      inlineTwiml,
      realtimeTaskInstructions,
    });

    callRecord.providerCallId = result.providerCallId;
    ctx.providerCallIdMap.set(result.providerCallId, callId);
    persistCallRecord(ctx.storePath, callRecord);

    return { callId, success: true };
  } catch (err) {
    finalizeCall({
      ctx,
      call: callRecord,
      endReason: "failed",
    });

    return {
      callId,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function speak(
  ctx: SpeakContext,
  callId: CallId,
  text: string,
): Promise<{ success: boolean; error?: string }> {
  const connected = requireConnectedCall(ctx, callId);
  if (!connected.ok) {
    return { success: false, error: connected.error };
  }
  const { call, providerCallId, provider } = connected;

  try {
    // Embedded live agent (e.g. OpenAI Realtime) is already driving the call.
    // Skip our own TTS and transcript write — the provider emits authoritative
    // call.bot_speech events with what was actually spoken.
    if (provider.isEmbeddedAgentActive?.(providerCallId)) {
      return { success: true };
    }

    transitionState(call, "speaking");
    persistCallRecord(ctx.storePath, call);

    const voice = provider.name === "twilio" ? resolveOpenAITtsVoice(ctx.config) : undefined;
    await provider.playTts({
      callId,
      providerCallId,
      text,
      voice,
    });

    addTranscriptEntry(call, "bot", text);
    persistCallRecord(ctx.storePath, call);

    return { success: true };
  } catch (err) {
    // A failed playback should not leave the call stuck in speaking state.
    transitionState(call, "listening");
    persistCallRecord(ctx.storePath, call);
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function speakInitialMessage(
  ctx: ConversationContext,
  providerCallId: string,
): Promise<void> {
  const call = getCallByProviderCallId({
    activeCalls: ctx.activeCalls,
    providerCallIdMap: ctx.providerCallIdMap,
    providerCallId,
  });
  if (!call) {
    console.warn(`[voice-call] speakInitialMessage: no call found for ${providerCallId}`);
    return;
  }

  const initialMessage = call.metadata?.initialMessage as string | undefined;
  const mode = (call.metadata?.mode as CallMode) ?? "conversation";
  const openingMessage =
    mode === "conversation" && initialMessage
      ? buildConversationOpeningMessage(initialMessage)
      : initialMessage;
  // #region agent log
  agentDebugLog({
    runId: "voice-style-run-1",
    hypothesisId: "H8",
    location: "outbound.ts:speakInitialMessage",
    message: "opening message selected for first utterance",
    data: {
      callId: call.callId,
      mode,
      openingMessage,
    },
  });
  // #endregion
  console.log(
    `[agent-debug][H13] opening message selected for first utterance: ` +
      JSON.stringify({
        callId: call.callId,
        mode,
        openingMessage: openingMessage?.slice(0, 180),
      }),
  );

  if (!openingMessage) {
    console.log(`[voice-call] speakInitialMessage: no initial message for ${call.callId}`);
    return;
  }

  if (ctx.initialMessageInFlight.has(call.callId)) {
    console.log(
      `[voice-call] speakInitialMessage: initial message already in flight for ${call.callId}`,
    );
    return;
  }
  ctx.initialMessageInFlight.add(call.callId);

  try {
    console.log(`[voice-call] Speaking initial message for call ${call.callId} (mode: ${mode})`);
    const embeddedActive =
      Boolean(call.providerCallId) && ctx.provider?.isEmbeddedAgentActive?.(call.providerCallId);
    if (embeddedActive && call.providerCallId) {
      await ctx.provider!.playTts({
        callId: call.callId,
        providerCallId: call.providerCallId,
        text: openingMessage,
      });
    } else {
      const result = await speak(ctx, call.callId, openingMessage);
      if (!result.success) {
        console.warn(`[voice-call] Failed to speak initial message: ${result.error}`);
        return;
      }
    }

    // Clear only after successful playback so transient provider failures can retry.
    if (call.metadata) {
      delete call.metadata.initialMessage;
      persistCallRecord(ctx.storePath, call);
    }

    if (mode === "notify") {
      const delaySec = ctx.config.outbound.notifyHangupDelaySec;
      console.log(`[voice-call] Notify mode: auto-hangup in ${delaySec}s for call ${call.callId}`);
      setTimeout(async () => {
        const currentCall = ctx.activeCalls.get(call.callId);
        if (currentCall && !TerminalStates.has(currentCall.state)) {
          console.log(`[voice-call] Notify mode: hanging up call ${call.callId}`);
          await endCall(ctx, call.callId);
        }
      }, delaySec * 1000);
    }
  } finally {
    ctx.initialMessageInFlight.delete(call.callId);
  }
}

export async function continueCall(
  ctx: ConversationContext,
  callId: CallId,
  prompt: string,
): Promise<{ success: boolean; transcript?: string; error?: string }> {
  const connected = requireConnectedCall(ctx, callId);
  if (!connected.ok) {
    return { success: false, error: connected.error };
  }
  const { call, providerCallId, provider } = connected;

  if (ctx.activeTurnCalls.has(callId) || ctx.transcriptWaiters.has(callId)) {
    return { success: false, error: "Already waiting for transcript" };
  }
  ctx.activeTurnCalls.add(callId);

  const turnStartedAt = Date.now();
  const turnToken = provider.name === "twilio" ? crypto.randomUUID() : undefined;

  try {
    // Skip speaking if prompt is empty (e.g., waiting for first user response after greeting)
    if (prompt) {
      await speak(ctx, callId, prompt);
    }

    transitionState(call, "listening");
    persistCallRecord(ctx.storePath, call);

    const listenStartedAt = Date.now();
    await provider.startListening({ callId, providerCallId, turnToken });

    const transcript = await waitForFinalTranscript(ctx, callId, turnToken);
    const transcriptReceivedAt = Date.now();

    // Best-effort: stop listening after final transcript.
    await provider.stopListening({ callId, providerCallId });

    const lastTurnLatencyMs = transcriptReceivedAt - turnStartedAt;
    const lastTurnListenWaitMs = transcriptReceivedAt - listenStartedAt;
    const turnCount =
      call.metadata && typeof call.metadata.turnCount === "number"
        ? call.metadata.turnCount + 1
        : 1;

    call.metadata = {
      ...(call.metadata ?? {}),
      turnCount,
      lastTurnLatencyMs,
      lastTurnListenWaitMs,
      lastTurnCompletedAt: transcriptReceivedAt,
    };
    persistCallRecord(ctx.storePath, call);

    console.log(
      "[voice-call] continueCall latency call=" +
        call.callId +
        " totalMs=" +
        String(lastTurnLatencyMs) +
        " listenWaitMs=" +
        String(lastTurnListenWaitMs),
    );

    return { success: true, transcript };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    ctx.activeTurnCalls.delete(callId);
    clearTranscriptWaiter(ctx, callId);
  }
}

export async function endCall(
  ctx: EndCallContext,
  callId: CallId,
  options?: { reason?: EndReason },
): Promise<{ success: boolean; error?: string }> {
  const lookup = lookupConnectedCall(ctx, callId);
  if (lookup.kind === "error") {
    return { success: false, error: lookup.error };
  }
  if (lookup.kind === "ended") {
    return { success: true };
  }
  const { call, providerCallId, provider } = lookup;
  const reason = options?.reason ?? "hangup-bot";

  try {
    await provider.hangupCall({
      callId,
      providerCallId,
      reason,
    });

    finalizeCall({
      ctx,
      call,
      endReason: reason,
    });

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
