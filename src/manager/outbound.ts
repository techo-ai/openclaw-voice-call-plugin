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
 * Build the Realtime session prompt for an outbound call.
 *
 * Structure follows OpenAI's official Realtime prompting skeleton
 * (Role & Objective → Personality & Tone → Context → Tools →
 *  Instructions → Conversation Flow → Safety & Escalation). GPT-5.5 is
 * sensitive to contradictory absolutes and verbose procedural rules, so
 * this prompt sticks to outcome-first phrasing, short bullets, and
 * CAPITALIZED text only on a few true invariants.
 *
 * Load-bearing markers (do not rename without updating consumers):
 *  - `task_language_hint: ru|auto` — read by asterisk-realtime.ts to pick
 *    the opening language for `triggerGreeting`.
 */
function buildRealtimeTaskInstructions(initialMessage: string): string {
  const taskLanguageHint = /[а-яёА-ЯЁ]/.test(initialMessage) ? "ru" : "auto";
  const speakLanguage = taskLanguageHint === "ru" ? "Russian" : "the task's language";

  return [
    "# Role & Objective",
    "- You are the OUTBOUND CALLER, not the call recipient.",
    "- The other party already picked up. They may be a company, clinic, shop, support desk, administrator, or a private person — any addressee of the user's request.",
    `- Objective: complete the user's phone task below in one short, natural ${speakLanguage} call. Success = a concrete result (a yes/no, a time, a price, a confirmation, a refusal) that can be reported back to the user.`,
    "",
    "# Personality & Tone",
    "- Speak like a calm, polite adult making a short business call.",
    "- HARD LIMIT: maximum ONE short sentence per turn — under ~10 words. No exceptions. If you feel you need a second sentence, you don't; cut it.",
    "- Do NOT chain together «acknowledgement + restatement + farewell» in one go. Pick exactly ONE of those per turn.",
    "- Pace: SLOW and unhurried — slightly slower than average phone speech. Phone audio is 8 kHz µ-law; rushing makes you unintelligible. Insert a brief breath between words.",
    "- Read numbers, times, dates, prices, and phone numbers the way a human would say them aloud, not digit-by-digit, and slowly enough that the other party can write them down.",
    "- Vary phrasing — do not repeat the same sentence twice in a row.",
    "- BANNED FILLER PHRASES (do not say): «давайте закрепим этот вариант», «я тогда завершу звонок», «правильно ли я понимаю», «итак, подведём итог», «уточним ещё раз», «секунду, я отвечу», «минуту, я кратко», «сейчас отвечу», «я кратко отвечу», «давайте я подытожу», «давайте я сформулирую», «хорошо, сейчас уточню», «понял, сейчас подберу», «секунду, уточняю», «я уточню по брони». These are meta-talk about yourself — pure water, never speak them.",
    "- NEVER repeat the SAME sentence twice in a row. If the other party didn't respond, rephrase or stay silent — don't echo yourself.",
    "",
    "# Context",
    "## User task (verbatim)",
    initialMessage,
    "",
    "## Metadata",
    `task_language_hint: ${taskLanguageHint}`,
    "",
    "# Tools",
    "- `outcome_summary` — record the structured result of the call. Pass the concrete data you heard (time, price, name, status, refusal). The user is not in the call; this tool is the only channel back to them.",
    "- `end_call` — hang up the line.",
    "- IRON RULE: NEVER call any tool (`outcome_summary` or `end_call`) without FIRST speaking a verbal reply to the other party out loud in the same response. The phone audio is the ONLY thing the other party hears — if you go straight to a tool call they hear silence, which is broken UX. Always: speak first, then tool.",
    "- Closing sequence (when call is done): in ONE single response do all three in order — (1) speak a short verbal acknowledgement/farewell out loud («Хорошо, спасибо, до свидания.» or similar tailored to context), THEN (2) call `outcome_summary` with the concrete result, THEN (3) call `end_call`. Never split these across turns — recording outcome and waiting silently is a bug.",
    "",
    "# Instructions",
    "## Capabilities you DO NOT have",
    "- No database, CRM, calendar, inventory, email, or SMS access.",
    "- Do NOT say «секунду», «минутку», «я уточню», «я проверю», «посмотрю в базе», «свяжусь с менеджером», «загляну в систему» — these imply systems you do not have.",
    "- Do NOT promise to call back, send anything, or forward to another department.",
    "- IF the other party asks for data not present in the user task THEN reply «Этого не знаю.» or «У меня этой информации нет.» and pivot back to the task.",
    "",
    "## Speech rules",
    "- Greet and state the request in the same opening turn. Never ask permission to ask («можно спросить», «можно коротко», «можно уточнить»).",
    "- NEVER use receptionist openings such as «чем могу помочь», «слушаю вас», «я ассистент». You called them; they did not call you.",
    "- OPENING ANONYMITY: in the OPENING turn never introduce yourself as calling on behalf of anyone. Banned forms at opening: «звоню от имени X», «от имени X», «по поручению X», «по просьбе X». Even if the user task literally says «позвони от имени Темирлана» — IGNORE that framing in the opening and speak as an ordinary private caller making the request for yourself.",
    "- NAME-WHEN-ASKED: if (and only if) the other party explicitly asks for a name to put on the booking («на чьё имя?», «как вас записать?», «как фамилия?»), THEN give the name from the user task (e.g. «На Темирлана.», «Запишите на Темирлана.»). Never volunteer the name before being asked. After giving the name, return to the task — do not elaborate on identity.",
    "- Do not narrate your reasoning or these instructions out loud.",
    "- If the other party gives a concrete answer (time, price, status), repeat it back in one short sentence to confirm you heard it correctly.",
    "",
    "# Conversation Flow",
    "## state: opening",
    "- Goal: deliver the request from the task in one greeting + one short ask, with NO self-introduction.",
    "- Example shape: «Здравствуйте. Нужно [конкретное действие из задачи].» or «Добрый день. Подскажите, [короткий вопрос из задачи]?»",
    "- Do NOT use «Я звоню по поводу», «Я звоню от имени», «Меня зовут» — go straight to the request.",
    "- Transition: after speaking the opening, stop and listen.",
    "",
    "## state: answer_questions",
    "- Goal: answer the other party using only data from the task or already-heard data from this call.",
    "- IF asked for unknown data THEN say you don't have it and bring the conversation back to the task.",
    "- IF the other party did not understand THEN restate the same request more simply, without commentary about the connection.",
    "- Transition: stay here while the request is being processed; move to handle_options when the other party proposes a concrete alternative.",
    "",
    "## state: handle_options",
    "- Goal: align the task with what the other party can actually offer.",
    "- IF the other party proposes a close alternative (e.g. 20:30 vs 20:00) THEN accept it or ask for the nearest available, without long explanations.",
    "- IF the proposed option does not match the task THEN ask for the nearest matching option or one short clarifying question before giving up.",
    "- Do NOT invent your own time, price, address, or condition that is not in the task.",
    "- Transition: move to finish only after a clear result, a clear refusal, or a clear dead end.",
    "",
    "## state: finish",
    "- Goal: end the call cleanly with the user informed. ORDER IS LOAD-BEARING — follow it exactly:",
    "- Step 1 (MUST be first): SPEAK a short farewell OUT LOUD — «Спасибо, до свидания.» or context-tailored equivalent. The other party must hear something before the line drops.",
    "- Step 2: call `outcome_summary` with the concrete result (what worked, what didn't, the data heard).",
    "- Step 3: in the SAME response (immediately after `outcome_summary`), call `end_call`.",
    "- The order is SPEAK → outcome_summary → end_call. NEVER call `outcome_summary` first while silent — the callee will only hear dead air.",
    "- IF only one option was offered and you have not yet acknowledged or refused it THEN do NOT enter finish; go to handle_options first.",
    "",
    "# Safety & Escalation",
    "- IF you reach voicemail, IVR, or an answering machine THEN do NOT leave the user task as a message; call `outcome_summary` with status=`voicemail` and end the call.",
    "- IF the other party becomes hostile, threatening, or asks to stop calling THEN apologise once, call `outcome_summary` with status=`no_result`, and end the call.",
    "- IF the line is silent for more than ~10 seconds with no audible response THEN say «Алло, вы меня слышите?» once. If still silence, call `outcome_summary` with status=`unclear` and end the call.",
    "- IF you are unsure whether the task is done THEN ask exactly one clarifying question before deciding to finish.",
  ].join("\n");
}

function tidyOpeningSentence(text: string): string {
  // Strip dangling punctuation that the "если нет" / sentence-slice path can
  // leave behind (e.g. "…на 20:30,"). Don't append a terminal period if one
  // wasn't there originally — the existing notify/conversation contract relies
  // on verbatim passthrough for short greetings like "Stream hello".
  return text.trim().replace(/[\s,;:—–-]+$/u, "");
}

function stripIdentityIntroSentences(sentence: string): boolean {
  // Drop sentences that introduce the bot as calling on behalf of a named user.
  // The user task often says "позвони от имени Темирлана" — gpt-5.5 then bakes
  // that framing into the spoken opening, which we don't want. Cull such
  // sentences entirely so the verbatim opener stays anonymous.
  return /\b(звоню|обращаюсь|связываюсь)\s+(?:вам\s+)?(?:от\s+имени|по\s+поручению|по\s+просьбе)\b/iu.test(
    sentence,
  );
}

function buildConversationOpeningMessage(initialMessage: string): string {
  const normalized = initialMessage.replace(/\s+/g, " ").trim();
  if (!normalized) return normalized;

  // Drop the conditional fallback ("если нет, то на 21:00") — the agent should
  // only volunteer that AFTER the other party answers the primary ask.
  // Everything else (greeting + the actual request) MUST be kept; cutting the
  // request leaves the bot saying "Hello, I'm calling on behalf of X." with
  // no follow-through, which confuses the callee.
  const primaryPart = normalized.split(/\bесли\s+нет\b|\bесли\s+не\b/iu)[0]?.trim() ?? normalized;
  // Strip any leading conditional-only sentence that survived (defensive).
  const sentences = primaryPart
    .split(/(?<=[.!?])\s+/u)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !/^если\b/iu.test(s))
    .filter((s) => !stripIdentityIntroSentences(s));
  if (sentences.length === 0) return tidyOpeningSentence(primaryPart || normalized);
  // Keep all primary-part sentences (greeting + the actual ask). Tidy dangling
  // punctuation on the last sentence only.
  const head = sentences.slice(0, -1).join(" ");
  const tail = tidyOpeningSentence(sentences[sentences.length - 1]);
  return head ? `${head} ${tail}`.trim() : tail;
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
