import { observationReadBudget, observationWholeDeliveryBatches, type WholeDeliveryShare } from "../toolObservations/sourceAdapters";
import type { ToolCallReadBatch } from "../tools/readToolCall";
import type { ProviderToolBridge, ToolExecutionResult } from "../tools/types";
import { providerResultCallId } from "./contextCompactionPlanner";
import { READ_TOOL_CALL_NAME } from "./toolHistoryContract";
import { parsePersistedToolExecutionResult } from "./toolExecutionPersistence";
import type { PersistedToolLoopCall } from "./toolLoopPersistence";

/**
 * What a persisted tool-loop continuation keeps of a `read_tool_call` output:
 * nothing of the read call's saved arguments or results. Its call row keeps
 * only a content-free receipt; a recovery reads the call again, with the
 * run's current authority, before the transcript reaches a provider again.
 */
const NOT_KEPT = Object.freeze({
  code: "tool_call_read_not_kept",
  message: "This earlier read is not kept. Read the call again with read_tool_call if it is still needed."
});

export function callReadStub(callId: string): ToolExecutionResult {
  return { callId, name: READ_TOOL_CALL_NAME, status: "complete", content: [{ type: "json", value: NOT_KEPT }] };
}

/** Provider call ids of a run's persisted call reads. */
export function callReadIds(calls: Iterable<Readonly<{ providerCallId: string; toolName: string }>>): ReadonlySet<string> {
  return new Set([...calls].filter(call => call.toolName === READ_TOOL_CALL_NAME).map(call => call.providerCallId));
}

/** The continuation as it is persisted: every call read's output becomes a
 * content-free stub; any other item stays exactly as the provider saw it. */
export function withoutCallReadOutputs<T extends Readonly<{ providerToolMessages: readonly unknown[] }>>(
  continuation: T,
  readCallIds: ReadonlySet<string>,
  bridge: ProviderToolBridge | undefined
): T {
  if (readCallIds.size === 0 || !bridge) return continuation;
  let changed = false;
  const providerToolMessages = continuation.providerToolMessages.map((message) => {
    const callId = providerResultCallId(message);
    if (callId === null || !readCallIds.has(callId)) return message;
    changed = true;
    return bridge.appendToolResult(undefined, callReadStub(callId));
  });
  return changed ? { ...continuation, providerToolMessages } : continuation;
}

/** A saved transcript with every call read read again (`read` reauthorizes
 * and returns the call's current output or refusal). */
export async function withRereadCallReads(
  messages: readonly unknown[],
  readCallIds: ReadonlySet<string>,
  bridge: ProviderToolBridge | undefined,
  read: (callId: string) => Promise<ToolExecutionResult>
): Promise<unknown[]> {
  if (readCallIds.size === 0 || !bridge) return [...messages];
  const reread: unknown[] = [];
  for (const message of messages) {
    const callId = providerResultCallId(message);
    reread.push(callId !== null && readCallIds.has(callId) ? bridge.appendToolResult(undefined, await read(callId)) : message);
  }
  return reread;
}

/**
 * The batch share in which each saved call read is read again on recovery,
 * by its round: the reads of one round draw on one delivery allowance, as
 * live reads did, after what that round's settled results drew from it. A
 * read beyond it is shortened, then deferred, exactly as in a live batch.
 */
export function callReadReplayBudgets(calls: readonly PersistedToolLoopCall[],
  share: WholeDeliveryShare): (round: number) => ToolCallReadBatch {
  const batches = observationWholeDeliveryBatches();
  const reads = callReadIds(calls);
  let begun: number | null = null;
  return (round) => {
    if (begun !== round) {
      begun = round;
      batches.begin(round, share);
      for (const call of calls) {
        if (call.roundIndex !== round || reads.has(call.providerCallId)) continue;
        const settled = parsePersistedToolExecutionResult({ id: call.providerCallId, name: call.toolName }, call.result);
        if (settled) batches.replay(round, share, settled);
      }
    }
    return observationReadBudget(batches.allowance(round, share));
  };
}
