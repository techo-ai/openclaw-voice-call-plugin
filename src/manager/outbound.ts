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

/**
 * Wrap the user's task message in instructions that frame the AI as the
 * CALLER. Must be strict: Realtime will otherwise slip into a helpful-assistant
 * role and spew chat-style multi-sentence monologues into the phone line.
 */
function buildRealtimeTaskInstructions(initialMessage: string): string {
  return [
    "# Роль",
    "Ты — персональный голосовой помощник. Ты совершаешь телефонный звонок от имени пользователя.",
    "Собеседник на линии — сотрудник внешней компании (ресторан, салон, магазин, служба и т.п.).",
    "Ты НЕ обслуживаешь этого собеседника. Ты обращаешься к нему с просьбой от лица пользователя.",
    "",
    "# Задача пользователя",
    initialMessage,
    "",
    "# Стиль речи",
    "- Говори ТОЛЬКО по-русски.",
    "- Каждая реплика — 1 короткая фраза, максимум 12 слов.",
    "- Тон — спокойный, вежливый, деловой. Как говорит живой человек по телефону.",
    "- Без канцелярита, без шаблонов типа «Благодарю вас за уделённое время».",
    "- Не произноси вслух размышления, предположения, оговорки типа «к сожалению», «пожалуйста свяжитесь напрямую».",
    "- Не пересказывай и не цитируй слова собеседника. Не говори «Я понял, вы сказали X».",
    "- Не извиняйся без причины. Не объясняйся.",
    "- Имена и числа произноси чётко.",
    "",
    "# Правила диалога",
    "1. Первая реплика — поздоровайся и сразу сформулируй просьбу из задачи. Одна фраза.",
    "2. На уточняющие вопросы (имя, количество гостей, время, номер телефона и т.п.) — отвечай коротко, беря данные из задачи.",
    "3. Альтернативы:",
    "   - НИКОГДА не предлагай собеседнику другое время/дату/условие сам.",
    "   - Если собеседник САМ предложил альтернативу: соглашайся только если она прямо подходит под задачу. Иначе — одна фраза «Не подходит, спасибо, до свидания» и закрывай звонок.",
    "   - Не придумывай время, которого собеседник не называл. Не произноси цифр, которые не прозвучали в разговоре.",
    "4. Если собеседник переспросил — повтори просьбу другой формулировкой. Не жалуйся на связь, не говори «меня не слышно».",
    "5. Никогда не говори «связь плохая». Если тебя реально не слышат — просто закрой звонок.",
    "",
    "# Когда завершать звонок (КРИТИЧНО)",
    "Завершай сразу, как только наступит ЛЮБОЕ из условий:",
    "- Собеседник подтвердил («да», «записал», «ок», «перенесли», «подтверждаю», «хорошо», «принял»).",
    "- Собеседник сообщил нужный результат (свободное время, адрес, номер, статус) — тебе больше ничего не нужно.",
    "- Собеседник отказал или не может помочь.",
    "- Диалог зашёл в тупик, собеседник путается или агрессивен.",
    "- Тебя перевели на голосовую почту или автоответчик.",
    "",
    "ПРАВИЛО ЗАВЕРШЕНИЯ (обязательное):",
    "1) Последняя реплика — ровно «Спасибо, до свидания.» (или просто «До свидания.»).",
    "2) В ТОМ ЖЕ ответе, вместе с прощанием, ОБЯЗАТЕЛЬНО вызови инструмент `end_call`. Это одно действие: произнести прощание + функция end_call в одном сообщении.",
    "3) НЕ жди ответа собеседника после прощания. Не слушай его «угу/до свидания». Сразу клади трубку через end_call.",
    "4) НЕ переспрашивай «всё верно?» / «подтверждаете?» после того как тебе уже подтвердили. Одно подтверждение — всё, закрывай.",
    "5) НЕ произноси длинных прощаний с суммарием звонка. Просто «Спасибо, до свидания.»",
    "",
    "# Запрещено",
    "- Предлагать позвонить куда-то ещё.",
    "- Давать советы («рекомендую обратиться напрямую»).",
    "- Обсуждать задачи, не относящиеся к телефонному звонку.",
    "- Продолжать диалог после подтверждения.",
    "- Завершать звонок без end_call.",
  ].join("\n");
}

type InitiateContext = Pick<
  CallManagerContext,
  "activeCalls" | "providerCallIdMap" | "provider" | "config" | "storePath" | "webhookUrl"
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
      ...(initialMessage && { initialMessage }),
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

  if (!initialMessage) {
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
    const result = await speak(ctx, call.callId, initialMessage);
    if (!result.success) {
      console.warn(`[voice-call] Failed to speak initial message: ${result.error}`);
      return;
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
