import type { Prisma } from "@prisma/client";
import { json, lockRunSettlementScope } from "../runs/prismaRepositoryShared";
import { appendRunOutputEvents } from "../runs/prismaRepositoryToolLoop";
import { runOutputArtifactEvents } from "../runs/runOutputEvents";
import { parsePersistedToolExecutionResult, snapshotToolExecutionResult } from "../runs/toolExecutionPersistence";
import { toolLoopPersistenceLimits } from "../runs/toolLoopPersistence";
import { selfServiceRunAllowedInTransaction, type SelfServiceCallStore } from "./selfServiceCall";
import type { ToolExecutionResult } from "./types";

type StoredResult = Parameters<typeof parsePersistedToolExecutionResult>[1];

/**
 * The call store of a self-service call recorded as a `ModelRunToolCall` row:
 * the native engine records every call running before it sends it and leaves
 * a row its executor settled alone (`lib/server/engine/toolCallStore.ts`),
 * as a scheduled task or a Skill save settles its own. Inside the change's
 * transaction the claim takes the run's settlement locks (owner, chat, then
 * the run), fences the run and finds the running call; the
 * settlement stores the result and appends its cards to the answer, so the
 * change, its record and its card commit together or not at all.
 */
export function createToolCallSelfServiceStore(input: Readonly<{ callId: string; runId: string; toolName: string; userId: string }>): SelfServiceCallStore {
  return {
    async claim(tx) {
      await lockRunSettlementScope(tx, input.runId);
      if (!await selfServiceRunAllowedInTransaction(tx, input)) return { kind: "unavailable" };
      const call = await tx.modelRunToolCall.findFirst({
        select: { providerCallId: true, result: true, state: true, toolName: true },
        where: { id: input.callId, modelRunId: input.runId }
      });
      if (!call || call.toolName !== input.toolName) return { kind: "unavailable" };
      if (call.state === "complete" || call.state === "error") {
        return { kind: "settled", result: parsePersistedToolExecutionResult({ id: call.providerCallId, name: call.toolName },
          call.result as StoredResult) };
      }
      return call.state === "running" ? { kind: "open" } : { kind: "unavailable" };
    },

    async settle(tx: Prisma.TransactionClient, result: ToolExecutionResult) {
      const snapshot = snapshotToolExecutionResult(result, toolLoopPersistenceLimits.resultBytes);
      if (!snapshot || result.status !== "complete") throw new Error("self_service_call_result_invalid");
      const settled = await tx.modelRunToolCall.updateMany({
        data: { completedAt: new Date(), result: json(snapshot), state: "complete" },
        where: { id: input.callId, modelRunId: input.runId, state: "running" }
      });
      if (settled.count !== 1) throw new Error("self_service_call_settle_conflict");
      // The card is part of the answer whatever happens to the run next.
      await appendRunOutputEvents(tx, input.runId, runOutputArtifactEvents(result.artifacts ?? []), { settlement: true });
    }
  };
}
