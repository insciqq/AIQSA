import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { DecisionAnswer, DecisionReceipt } from "../providers/decisions";
import type { ProviderExecutionSnapshot } from "../providers/runtimeFactory";

export type OptionalDecisionOwner = Readonly<{
  userId: string;
  runId?: string;
  purpose: "mcp_discovery" | "skill_suggestions";
  operationKey: string;
}>;
export type OptionalDecisionSettlement = Readonly<{
  receipt: DecisionReceipt | null;
  answers: Readonly<Record<string, DecisionAnswer>> | null;
  failureCode: string | null;
  dispatched: boolean;
}>;
export type OptionalDecisionRepository = Readonly<{
  start(owner: OptionalDecisionOwner, inputHash: string, snapshot: ProviderExecutionSnapshot): Promise<
    | { kind: "new"; id: string }
    | { kind: "replay"; answers: Readonly<Record<string, DecisionAnswer>> | null }
  >;
  settle(owner: OptionalDecisionOwner, id: string, result: OptionalDecisionSettlement): Promise<void>;
}>;

export function optionalDecisionInputHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** The unique owner/key is the dispatch fence, including after a process crash.
 * Only normalized alias/score answers survive; no query or catalog is stored. */
export function createOptionalDecisionRepository(db: PrismaClient): OptionalDecisionRepository {
  return {
    async start(owner, inputHash, snapshot) {
      return db.$transaction(async tx => {
        const id = randomUUID();
        const created = await tx.optionalDecisionAttempt.createMany({ skipDuplicates: true, data: {
          id, userId: owner.userId, modelRunId: owner.runId ?? null, purpose: owner.purpose,
          operationKey: owner.operationKey, inputHash,
          executionSnapshot: JSON.parse(JSON.stringify(snapshot)) as Prisma.InputJsonObject
        } });
        if (created.count === 1) {
          const run = owner.runId ? await tx.modelRun.findFirstOrThrow({ where: { id: owner.runId, userId: owner.userId },
            select: { chatId: true, chat: { select: { projectId: true } } } }) : null;
          // A crash after this commit must retain unknown accounting, even if
          // there is no process left to execute a finally block.
          await tx.usageEvent.create({ data: {
            optionalDecision: true, optionalDecisionAttemptId: id, userId: owner.userId, modelRunId: owner.runId ?? null,
            chatId: run?.chatId ?? null, projectId: run?.chat.projectId ?? null, provider: snapshot.providerFamily,
            providerModelId: snapshot.providerModelId, modelId: snapshot.model.upstreamModelId,
            usageCompleteness: "UNAVAILABLE", operationCount: 1
          } });
          return { kind: "new", id };
        }
        const old = await tx.optionalDecisionAttempt.findUniqueOrThrow({ where: {
          userId_purpose_operationKey: { userId: owner.userId, purpose: owner.purpose, operationKey: owner.operationKey }
        } });
        return { kind: "replay", answers: old.inputHash === inputHash && old.modelRunId === (owner.runId ?? null) &&
          old.state === "settled" && !old.failureCode
          ? old.answers as Readonly<Record<string, DecisionAnswer>> | null : null };
      });
    },
    async settle(owner, id, result) {
      await db.$transaction(async tx => {
        const attempt = await tx.optionalDecisionAttempt.findFirst({ where: {
          id, userId: owner.userId, modelRunId: owner.runId ?? null, purpose: owner.purpose, operationKey: owner.operationKey
        }, include: { modelRun: { select: { chatId: true, chat: { select: { projectId: true } } } } } });
        // Deleting the owning user/chat can retire an in-flight optional result.
        if (!attempt) return;
        const changed = await tx.optionalDecisionAttempt.updateMany({ where: { id,
          state: { in: result.receipt ? ["dispatched", "ambiguous"] : ["dispatched"] } }, data: {
          state: result.receipt || !result.dispatched ? "settled" : "ambiguous",
          answers: result.answers ? JSON.parse(JSON.stringify(result.answers)) as Prisma.InputJsonObject : Prisma.DbNull,
          failureCode: result.failureCode, settledAt: new Date()
        } });
        if (changed.count !== 1) return;
        if (!result.dispatched) {
          await tx.usageEvent.deleteMany({ where: { optionalDecisionAttemptId: id, usageCompleteness: "UNAVAILABLE" } });
          return;
        }
        const snapshot = attempt.executionSnapshot as unknown as ProviderExecutionSnapshot;
        const receipt = result.receipt;
        const usage = { inputTokens: receipt?.usage.inputTokens ?? null, outputTokens: receipt?.usage.outputTokens ?? null,
          totalTokens: receipt ? receipt.usage.inputTokens + receipt.usage.outputTokens : null,
          estimatedCostMicros: receipt?.usage.costUsd == null ? null : Math.round(receipt.usage.costUsd * 1_000_000),
          usageCompleteness: receipt ? "COMPLETE" as const : "UNAVAILABLE" as const };
        await tx.usageEvent.upsert({ where: { optionalDecisionAttemptId: id }, update: usage,
          create: { ...usage, optionalDecision: true, optionalDecisionAttemptId: id, userId: owner.userId,
            modelRunId: owner.runId ?? null, chatId: attempt.modelRun?.chatId ?? null,
            projectId: attempt.modelRun?.chat.projectId ?? null,
            provider: snapshot.providerFamily, providerModelId: snapshot.providerModelId,
            modelId: snapshot.model.upstreamModelId, operationCount: 1 } });
      });
    }
  };
}
