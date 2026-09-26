import { decodeSearchObservationReceipt, SEARCH_OBSERVATION_RECEIPT_BYTES, type SearchObservationReceipt } from "./searchReceipt";
import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient, type ToolObservation } from "@prisma/client";
import { McpToolAccessDeniedError } from "../mcp/toolAccess";
import { resolveChatAccess } from "../projects/access";
import { activeToolLoopRun, activeToolLoopRunSql, lockRunSettlementScope } from "../runs/prismaRepositoryShared";
import { admitsToolObservationReservation, decodeToolObservationSourceBinding, ObservationStoreError, TOOL_OBSERVATION_LIMITS,
  type ToolObservationBudgetUsage, type ToolObservationSource, type ToolObservationSourceBinding } from "./contract";
import { OBSERVATION_READ_LIMITS } from "./byteReader";
import { measureObservationJson } from "./codec";

export type ObservationActor = Readonly<{ runId: string; userId: string }>;
export type ObservationProducer = ObservationActor & Readonly<{ toolCallId: string }>;
export { ObservationStoreError } from "./contract";
const unavailable = () => new ObservationStoreError("tool_observation_unavailable");
const conflict = () => new ObservationStoreError("tool_observation_conflict");
/** A reservation refused by run/call authority precedes every dispatch. */
const notStarted = () => new ObservationStoreError("tool_observation_not_started");
const identifier = () => randomUUID().replaceAll("-", "");

/** Handles one availability check may cover: a summary source references at
 * most its carried refs (fewer than the 512 summary refs) plus the masked
 * handles of one run (at most the 512-observation run cap). */
export const OBSERVATION_AVAILABILITY_HANDLES = 1024;

/** An authorization or row-state refusal of recall, as opposed to a database
 * or infrastructure failure, which propagates. */
function refusal(error: unknown): boolean {
  return error instanceof ObservationStoreError && error.code === "tool_observation_unavailable" ||
    error instanceof McpToolAccessDeniedError;
}

/** One accepted producer, with the same owner -> chat -> run locking order as
 * settlement for every write. Read-only recall and restore take no row locks:
 * they recheck the same authority, and the service rechecks after its I/O.
 * No transaction below contains storage or provider I/O. */
export function createToolObservationRepository(input: Readonly<{
  prisma: PrismaClient;
  authorizeSource(tx: Prisma.TransactionClient, source: ToolObservation, consumer: ObservationActor): Promise<void>;
  loadSource(tx: Prisma.TransactionClient, source: ToolObservation, consumer: ObservationActor): Promise<unknown>;
}>) {
  const { prisma } = input;

  async function authority(tx: Prisma.TransactionClient, actor: ObservationActor, lock: boolean) {
    if (lock) {
      await lockRunSettlementScope(tx, actor.runId);
      await tx.$queryRaw`SELECT "id" FROM "ModelRun" WHERE "id" = ${actor.runId} FOR UPDATE`;
    }
    const run = await tx.modelRun.findFirst({ where: { id: actor.runId, userId: actor.userId }, select: {
      id: true, chatId: true, assistantMessageId: true, status: true, errorPayload: true,
      chat: { select: { archived: true, permanentDeletionAt: true, projectId: true } }
    } });
    if (!run || !run.assistantMessageId || !activeToolLoopRun(run) ||
      run.chat.archived || run.chat.permanentDeletionAt ||
      !await tx.user.findFirst({ where: { id: actor.userId, status: "active" }, select: { id: true } }) ||
      !await resolveChatAccess(tx, { chatId: run.chatId, userId: actor.userId, requireMutable: true, minimumProjectRole: "CONTRIBUTOR" })) throw unavailable();
    const agent = await tx.agentRunBinding.findUnique({ where: { modelRunId: run.id }, select: {
      revokedAt: true, completedAt: true, failureCode: true, followupInterruptAt: true, expiresAt: true, leaseExpiresAt: true
    } });
    const now = new Date();
    if (agent && (agent.revokedAt || agent.completedAt || agent.failureCode || agent.followupInterruptAt ||
      !agent.leaseExpiresAt || agent.leaseExpiresAt <= now || agent.expiresAt && agent.expiresAt <= now)) throw unavailable();
    return run;
  }

  async function producer(tx: Prisma.TransactionClient, context: ObservationProducer, lock: boolean) {
    const run = await authority(tx, context, lock);
    const row = await tx.toolObservation.findUnique({ where: { toolCallId: context.toolCallId } });
    if (!row || row.modelRunId !== run.id) throw unavailable();
    return row;
  }

  async function forRead(tx: Prisma.TransactionClient, actor: ObservationActor, id: string) {
    const run = await authority(tx, actor, false);
    const source = await tx.toolObservation.findUnique({ where: { id }, include: {
      modelRun: { select: { chatId: true, assistantMessageId: true } }, toolCall: { select: { state: true } }
    } });
    if (!source || source.state !== "READY" || source.modelRun.chatId !== run.chatId ||
      !["complete", "error"].includes(source.toolCall.state)) throw unavailable();
    if (source.modelRunId !== run.id) {
      const ancestor = await tx.$queryRaw<Array<{ id: string }>>`WITH RECURSIVE path AS (
        SELECT "id", "parentMessageId" FROM "Message" WHERE "chatId" = ${run.chatId} AND "id" = ${run.assistantMessageId}
        UNION SELECT p."id", p."parentMessageId" FROM "Message" p JOIN path c ON p."id" = c."parentMessageId"
          WHERE p."chatId" = ${run.chatId}
      ) SELECT "id" FROM path WHERE "id" = ${source.modelRun.assistantMessageId}`;
      if (!ancestor.length) throw unavailable();
    }
    await input.authorizeSource(tx, source, actor);
    return source;
  }

  return {
    /** A repeated reservation is recovery evidence, not dispatch permission. */
    async reserve(context: ObservationProducer, sourceKind: ToolObservationSource, maximumBytes: number,
      sourceBinding?: ToolObservationSourceBinding) {
      if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > OBSERVATION_READ_LIMITS.documentBytes) throw conflict();
      if (sourceBinding && (!decodeToolObservationSourceBinding(sourceBinding, sourceKind) ||
        Buffer.byteLength(JSON.stringify(sourceBinding)) > 4096)) throw conflict();
      return prisma.$transaction(async tx => {
        const run = await authority(tx, context, true).catch((error: unknown) => {
          throw error instanceof ObservationStoreError && error.code === "tool_observation_unavailable" ? notStarted() : error;
        });
        const existing = await tx.toolObservation.findUnique({ where: { toolCallId: context.toolCallId } });
        if (existing) {
          if (existing.modelRunId !== run.id || existing.sourceKind !== sourceKind) throw conflict();
          // A Skill load is re-executable by the tool-loop claim and publishes
          // only from its settled call row, so an unpublished reservation left
          // by a crash is claimed again rather than becoming a lasting error.
          if (existing.sourceKind === "skill" && existing.state === "RESERVED") return { claimed: true, observation: existing };
          return { claimed: false, observation: existing };
        }
        const call = await tx.modelRunToolCall.findFirst({ where: { id: context.toolCallId, modelRunId: run.id,
          state: { in: ["pending", "running"] } }, select: { id: true } });
        if (!call) throw notStarted();
        // A dead producer cannot consume every future branch reservation.
        // Retain its identity/outcome as no-replay evidence, and let the
        // already-created deletion job retire any abandoned object. A run is
        // dead by the tool loop's own predicate: a recoverable error run still
        // executes (and reserves) tools, so its reservations stay live.
        await tx.$executeRaw`UPDATE "ToolObservation" o SET "state" = 'UNAVAILABLE',
          "reservedBytes" = 0, "failureCode" = 'tool_observation_unavailable',
          "executionOutcome" = COALESCE(o."executionOutcome", 'unknown'),
          "leaseToken" = NULL, "leaseExpiresAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
          FROM "ModelRun" producer WHERE producer."id" = o."modelRunId" AND producer."chatId" = ${run.chatId}
            AND ((o."state" = 'RESERVED' AND NOT ${activeToolLoopRunSql("producer")})
              OR (o."state" = 'STORING' AND o."leaseExpiresAt" <= CURRENT_TIMESTAMP))`;
        // Source-owned producers (Skill/Knowledge) keep their bytes in their
        // owner: they neither consume nor are refused by the store budget.
        if (sourceKind !== "skill" && sourceKind !== "knowledge") {
          // Only externalized bytes and in-flight ceilings count: a ceiling
          // becomes the exact size of an object at publication, and nothing
          // once the original is inline or UNAVAILABLE. Rows are not counted.
          const [budget] = await tx.$queryRaw<ToolObservationBudgetUsage[]>`
            WITH RECURSIVE path AS (
              SELECT "id", "parentMessageId" FROM "Message" WHERE "chatId" = ${run.chatId} AND "id" = ${run.assistantMessageId}
              UNION SELECT p."id", p."parentMessageId" FROM "Message" p JOIN path c ON p."id" = c."parentMessageId"
                WHERE p."chatId" = ${run.chatId}
            ) SELECT COALESCE(SUM(o."reservedBytes") FILTER (WHERE o."modelRunId" = ${run.id}), 0)::bigint AS "runBytes",
              COALESCE(SUM(o."reservedBytes"), 0)::bigint AS "branchBytes"
            FROM "ToolObservation" o JOIN "ModelRun" r ON r."id" = o."modelRunId"
            WHERE r."chatId" = ${run.chatId} AND (r."id" = ${run.id} OR r."assistantMessageId" IN (SELECT "id" FROM path))
              AND o."sourceKind" IN ('mcp', 'workspace', 'search')
              AND (o."state" = 'RESERVED' OR o."state" IN ('STORING', 'READY') AND o."storageMode" = 'OBJECT')`;
          if (!budget || !admitsToolObservationReservation(budget, maximumBytes)) {
            throw new ObservationStoreError("tool_observation_limit_exceeded");
          }
        }
        return { claimed: true, observation: await tx.toolObservation.create({ data: {
          id: identifier(), modelRunId: run.id, toolCallId: call.id, sourceKind, reservedBytes: maximumBytes,
          sourceBinding: sourceBinding ? sourceBinding as Prisma.InputJsonValue : Prisma.DbNull
        } }) };
      });
    },

    /** Content-free execution evidence may settle after Stop. Revocation still
     * prevents starting an upload or publishing a result. */
    async recordOutcome(context: ObservationProducer, outcome: "complete" | "error" | "unknown") {
      await prisma.toolObservation.updateMany({ where: { modelRunId: context.runId, toolCallId: context.toolCallId,
        modelRun: { userId: context.userId }, state: { in: ["RESERVED", "UNAVAILABLE"] },
        OR: [{ executionOutcome: null }, ...(outcome !== "unknown" ? [{ executionOutcome: "unknown" }] : [])] },
        data: { executionOutcome: outcome } });
    },

    async recordSearchReceipt(context: ObservationProducer, receipt: SearchObservationReceipt) {
      if (!decodeSearchObservationReceipt(receipt) || Buffer.byteLength(JSON.stringify(receipt)) > SEARCH_OBSERVATION_RECEIPT_BYTES) throw conflict();
      await prisma.$transaction(async tx => {
        await lockRunSettlementScope(tx, context.runId);
        await tx.$queryRaw`SELECT "id" FROM "ModelRun" WHERE "id" = ${context.runId} FOR UPDATE`;
        const row = await tx.toolObservation.findFirst({ where: { modelRunId: context.runId, toolCallId: context.toolCallId,
          sourceKind: "search", modelRun: { userId: context.userId } } });
        const binding = row && decodeToolObservationSourceBinding(row.sourceBinding, "search");
        if (!row || binding?.source !== "search" || receipt.executions.some(execution => !binding.sources.some(source =>
          source.optionId === execution.optionId && source.revisionId === execution.revisionId))) throw conflict();
        if (row.executionReceipt !== null) {
          if (JSON.stringify(decodeSearchObservationReceipt(row.executionReceipt)) !== JSON.stringify(receipt)) throw conflict();
          return;
        }
        await tx.toolObservation.update({ where: { id: row.id }, data: { executionReceipt: receipt as Prisma.InputJsonValue } });
      });
    },

    async readProducer(context: ObservationProducer) {
      return prisma.$transaction(async tx => {
        const row = await producer(tx, context, false);
        if (row.state === "READY") await input.authorizeSource(tx, row, context);
        return row;
      });
    },

    async beginWrite(context: ObservationProducer, value: Readonly<{
      byteSize: number; checksum: string; inlineText: string | null; projection: Prisma.InputJsonValue | null;
      sourceTruncated: boolean; maskable: boolean; storageMode: "INLINE" | "OBJECT" | "SOURCE";
    }>) {
      return prisma.$transaction(async tx => {
        const row = await producer(tx, context, true);
        if (row.state !== "RESERVED" || !["complete", "error"].includes(row.executionOutcome ?? "") ||
          value.byteSize > row.reservedBytes) throw conflict();
        await input.authorizeSource(tx, row, context);
        if (value.storageMode === "SOURCE") {
          const original = measureObservationJson(await input.loadSource(tx, row, context), row.reservedBytes, 0);
          if (original.byteSize !== value.byteSize || original.checksum !== value.checksum) throw conflict();
        }
        const token = value.storageMode === "OBJECT" ? identifier() : null;
        const storageKey = token ? `tool-observations/v1/${row.id}/${token}` : null;
        if (storageKey) await tx.attachmentDeletionJob.create({ data: { storageKey, claimToken: token, claimedAt: new Date() } });
        return tx.toolObservation.update({ where: { id: row.id }, data: {
          ...value, projection: value.projection ?? Prisma.DbNull, storageKey,
          state: token ? "STORING" : "READY", reservedBytes: value.byteSize,
          leaseToken: token, leaseExpiresAt: token ? new Date(Date.now() + TOOL_OBSERVATION_LIMITS.storageLeaseMs) : null
        } });
      });
    },

    async finishWrite(context: ObservationProducer, token: string) {
      return prisma.$transaction(async tx => {
        const row = await producer(tx, context, true);
        if (row.state !== "STORING" || row.leaseToken !== token || !row.leaseExpiresAt || row.leaseExpiresAt <= new Date() || !row.storageKey) throw conflict();
        await input.authorizeSource(tx, row, context);
        const [job] = await tx.$queryRaw<Array<{ claimToken: string | null }>>`
          SELECT "claimToken" FROM "AttachmentDeletionJob" WHERE "storageKey" = ${row.storageKey} FOR UPDATE`;
        if (job?.claimToken !== token) throw conflict();
        const ready = await tx.toolObservation.update({ where: { id: row.id }, data: {
          state: "READY", leaseToken: null, leaseExpiresAt: null
        } });
        await tx.attachmentDeletionJob.update({ where: { storageKey: row.storageKey }, data: { claimedAt: null, claimToken: null } });
        return ready;
      });
    },

    async unavailable(context: ObservationProducer, code: string, token?: string) {
      await prisma.$transaction(async tx => {
        // Failure cleanup follows the same lock order as publication, including
        // after Stop. It must not acquire an observation before the run/job.
        await lockRunSettlementScope(tx, context.runId);
        await tx.$queryRaw`SELECT "id" FROM "ModelRun" WHERE "id" = ${context.runId} FOR UPDATE`;
        const row = await tx.toolObservation.findFirst({ where: { modelRunId: context.runId, toolCallId: context.toolCallId,
          modelRun: { userId: context.userId }, ...(token ? { state: "STORING", leaseToken: token } : { state: "RESERVED" }) } });
        if (!row) return;
        const changed = await tx.toolObservation.updateMany({ where: { id: row.id, state: row.state, leaseToken: row.leaseToken },
          data: { state: "UNAVAILABLE", failureCode: /^[a-z][a-z0-9_]{0,63}$/u.test(code) ? code : "tool_observation_unavailable",
            reservedBytes: 0, leaseToken: null, leaseExpiresAt: null } });
        if (changed.count === 1 && row.storageKey && token) await tx.attachmentDeletionJob.updateMany({ where: { storageKey: row.storageKey, claimToken: token },
          data: { claimedAt: null, claimToken: null } });
      });
    },

    async read(actor: ObservationActor, id: string) {
      return prisma.$transaction(tx => forRead(tx, actor, id));
    },

    /** Whether every observation in the set is still recallable by this run,
     * with forRead's authority and without any source or object I/O: in one
     * read-only transaction, the run authority once, one lookup of all rows,
     * one ancestry query and each source's live authorization grouped by
     * kind. Only a refusal returns false; any other failure propagates. */
    async available(actor: ObservationActor, ids: readonly string[]): Promise<boolean> {
      const unique = [...new Set(ids)];
      if (unique.length > OBSERVATION_AVAILABILITY_HANDLES) throw conflict();
      if (unique.length === 0) return true;
      return prisma.$transaction(async tx => {
        try {
          const run = await authority(tx, actor, false);
          const sources = await tx.toolObservation.findMany({ where: { id: { in: unique } }, include: {
            modelRun: { select: { chatId: true, assistantMessageId: true } }, toolCall: { select: { state: true } }
          } });
          if (sources.length !== unique.length || sources.some(source => source.state !== "READY" ||
            source.modelRun.chatId !== run.chatId || !["complete", "error"].includes(source.toolCall.state))) return false;
          const foreign = [...new Set(sources.filter(source => source.modelRunId !== run.id)
            .map(source => source.modelRun.assistantMessageId))];
          if (foreign.some(id => id === null)) return false;
          if (foreign.length > 0) {
            const ancestors = await tx.$queryRaw<Array<{ id: string }>>`WITH RECURSIVE path AS (
              SELECT "id", "parentMessageId" FROM "Message" WHERE "chatId" = ${run.chatId} AND "id" = ${run.assistantMessageId}
              UNION SELECT p."id", p."parentMessageId" FROM "Message" p JOIN path c ON p."id" = c."parentMessageId"
                WHERE p."chatId" = ${run.chatId}
            ) SELECT "id" FROM path WHERE "id" IN (${Prisma.join(foreign as string[])})`;
            if (new Set(ancestors.map(row => row.id)).size !== foreign.length) return false;
          }
          const ordered = [...sources].sort((left, right) => left.sourceKind.localeCompare(right.sourceKind) ||
            left.id.localeCompare(right.id));
          for (const source of ordered) await input.authorizeSource(tx, source, actor);
          return true;
        } catch (error) {
          if (refusal(error)) return false;
          throw error;
        }
      });
    },

    async loadProducerSource(context: ObservationProducer) {
      return prisma.$transaction(async tx => {
        const source = await producer(tx, context, false);
        if (source.state !== "RESERVED" || !["skill", "knowledge"].includes(source.sourceKind)) throw unavailable();
        await input.authorizeSource(tx, source, context);
        return input.loadSource(tx, source, context);
      });
    },

    /** Private recovery/accounting consumer only. This is deliberately not a
     * model read: Stop/revocation cannot erase a reported provider charge. */
    async readSearchAccounting(context: ObservationProducer) {
      const source = await prisma.toolObservation.findFirst({ where: {
        toolCallId: context.toolCallId, modelRunId: context.runId, sourceKind: "search",
        modelRun: { userId: context.userId }
      } });
      return source;
    },

    async readSource(actor: ObservationActor, id: string) {
      return prisma.$transaction(async tx => {
        const source = await forRead(tx, actor, id);
        if (source.storageMode !== "SOURCE") throw conflict();
        return { source, original: await input.loadSource(tx, source, actor) };
      });
    }
  };
}
