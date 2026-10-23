import type { Prisma, PrismaClient } from "@prisma/client";
import { logEvent } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import { dispatchableModelRunStatuses } from "../runs/prismaRepositoryShared";
import type { ToolExecutionResult } from "./types";

/**
 * How a self-service tool (`manage_secret`, `manage_skill`,
 * `manage_assistant`) commits a change with its tool call: the change, the
 * call's settlement and the answer's card commit in one transaction, so a
 * repeated or recovered delivery returns the settled result and never applies
 * twice (`agent_docs/RUN_CONTRACTS.md`, "Agent-initiated changes"). The
 * engine provides the call's half (`SelfServiceCallStore`); the owners
 * provide the change through the same service path as the UI.
 */

/** The run and persisted tool call a change belongs to. */
export type SelfServiceScope = Readonly<{
  userId: string;
  runId: string;
  chatId: string;
  /** The persisted tool call (`ModelRunToolCall.id`): the change's operation key, which Skill store receipts reference. */
  callId: string;
}>;

/** What a change transaction learns about its call before writing anything. */
export type SelfServiceClaim =
  | Readonly<{ kind: "open" }>
  /** The call already settled: its result; nothing is applied now. */
  | Readonly<{ kind: "settled"; result: ToolExecutionResult | null }>
  /** The run or call can no longer change anything (finished, stopped, not the caller's). */
  | Readonly<{ kind: "unavailable" }>;

/**
 * The engine's half, implemented by the registry wiring over the run's
 * transcript and `ModelRunToolCall` rows.
 */
export type SelfServiceCallStore = Readonly<{
  /**
   * Before any write, inside the change's transaction: fences the run (see
   * `selfServiceRunAllowedInTransaction`) and its running call, and returns
   * the settled result of a call that settled already.
   */
  claim(tx: Prisma.TransactionClient): Promise<SelfServiceClaim>;
  /** Settles the call with its result and appends the result's cards to the answer, in the same transaction. */
  settle(tx: Prisma.TransactionClient, result: ToolExecutionResult): Promise<void>;
}>;

/** What a change did inside its transaction. A refusal must not have written anything. */
export type SelfServiceChange<Done, Refusal> =
  | Readonly<{ kind: "changed"; value: Done; result: ToolExecutionResult }>
  | Readonly<{ kind: "refused"; value: Refusal }>;

export type SelfServiceCommitOutcome<Done, Refusal> =
  | SelfServiceChange<Done, Refusal>
  | Exclude<SelfServiceClaim, Readonly<{ kind: "open" }>>;

export type SelfServiceDatabase = Pick<PrismaClient, "$transaction">;

/** Claims the call, runs the change and settles the call with the change's result, all in one transaction. */
export async function commitSelfServiceChange<Done, Refusal>(
  db: SelfServiceDatabase,
  store: SelfServiceCallStore,
  change: (tx: Prisma.TransactionClient) => Promise<SelfServiceChange<Done, Refusal>>
): Promise<SelfServiceCommitOutcome<Done, Refusal>> {
  return db.$transaction(async (tx) => {
    const claim = await store.claim(tx);
    if (claim.kind !== "open") return claim;
    const outcome = await change(tx);
    if (outcome.kind === "changed") await store.settle(tx, outcome.result);
    return outcome;
  });
}

/**
 * The run-level fence a claim applies: the caller is active and owns the
 * run and its chat, and the run is still running; the run is neither a
 * scheduled occurrence nor an answer to a scheduled task's prompt, which the
 * model may have written. Locks the run row.
 */
export async function selfServiceRunAllowedInTransaction(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  scope: Pick<SelfServiceScope, "runId" | "userId">
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ status: string; scheduledTaskId: string | null;
    scheduledTaskPrompt: boolean | null; userStatus: string }>>`
    SELECT r."status", r."scheduledTaskId", m."scheduledTaskPrompt", u."status" AS "userStatus"
    FROM "ModelRun" r
    JOIN "Chat" c ON c."id" = r."chatId"
    JOIN "User" u ON u."id" = r."userId"
    LEFT JOIN "Message" m ON m."id" = r."userMessageId"
    WHERE r."id" = ${scope.runId} AND r."userId" = ${scope.userId} AND c."userId" = ${scope.userId}
    FOR UPDATE OF r`;
  const run = rows[0];
  return Boolean(run && (dispatchableModelRunStatuses as readonly string[]).includes(run.status) && run.userStatus === "active" &&
    run.scheduledTaskId === null && run.scheduledTaskPrompt === false);
}

/** Content-free record of an unexpected failure; the tool answers with its own stable code. */
export function logSelfServiceFailure(error: unknown): void {
  logEvent("service_operation", {
    error, subsystem: "configuration", stage: "write", outcome: "failed", code: "self_service_change_failed",
    prisma_code: databaseFailureCode(error)
  });
}
