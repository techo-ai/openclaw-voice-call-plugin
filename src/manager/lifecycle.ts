import type { CallRecord, EndReason } from "../types.js";
import type { CallManagerContext } from "./context.js";
import { transitionState } from "./state.js";
import { persistCallRecord } from "./store.js";
import { clearMaxDurationTimer, rejectTranscriptWaiter } from "./timers.js";

type CallLifecycleContext = Pick<
  CallManagerContext,
  "activeCalls" | "providerCallIdMap" | "storePath"
> &
  Partial<
    Pick<CallManagerContext, "transcriptWaiters" | "maxDurationTimers" | "onCallFinalized">
  >;

function removeProviderCallMapping(
  providerCallIdMap: Map<string, string>,
  call: Pick<CallRecord, "callId" | "providerCallId">,
): void {
  if (!call.providerCallId) {
    return;
  }
  const mappedCallId = providerCallIdMap.get(call.providerCallId);
  if (mappedCallId === call.callId) {
    providerCallIdMap.delete(call.providerCallId);
  }
}

export function finalizeCall(params: {
  ctx: CallLifecycleContext;
  call: CallRecord;
  endReason: EndReason;
  endedAt?: number;
  transcriptRejectReason?: string;
}): void {
  const { ctx, call, endReason } = params;

  call.endedAt = params.endedAt ?? Date.now();
  call.endReason = endReason;
  transitionState(call, endReason);
  persistCallRecord(ctx.storePath, call);

  if (ctx.maxDurationTimers) {
    clearMaxDurationTimer({ maxDurationTimers: ctx.maxDurationTimers }, call.callId);
  }
  if (ctx.transcriptWaiters) {
    rejectTranscriptWaiter(
      { transcriptWaiters: ctx.transcriptWaiters },
      call.callId,
      params.transcriptRejectReason ?? `Call ended: ${endReason}`,
    );
  }

  ctx.activeCalls.delete(call.callId);
  removeProviderCallMapping(ctx.providerCallIdMap, call);

  console.log(
    `[voice-call] finalizeCall: ${call.callId} direction=${call.direction} reason=${endReason} hasHook=${Boolean(ctx.onCallFinalized)}`,
  );

  // Defer runtime-side hooks so a slow consumer cannot block lifecycle cleanup.
  if (ctx.onCallFinalized) {
    const hook = ctx.onCallFinalized;
    queueMicrotask(() => {
      try {
        hook(call);
      } catch (err) {
        console.warn(
          `[voice-call] onCallFinalized hook threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }
}
