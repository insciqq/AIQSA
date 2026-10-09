import { Prisma, type PrismaClient } from "@prisma/client";
import type { AnswerProblemReason } from "../../contracts/answerProblemReports";
import { retainDatabaseFailure } from "../observability/databaseFailure";
import { resolveChatAccess } from "../projects/access";

/**
 * Answer problem reports: one per user and persisted answer, holding a reason
 * and an optional comment, never the question or the answer. Visibility is
 * the chat's: the owner of a personal chat, or a current member of the
 * Project a Project chat belongs to (any role). Administrators read reports
 * only through `listAnswerProblemReports`, which never returns the chat.
 */

export const ANSWER_PROBLEM_REPORT_RETENTION_MS = 90 * 24 * 3_600_000;
const PRUNE_BATCH_ROWS = 500;
const PRUNE_MAX_BATCHES = 20;
const LIST_MAX_ROWS = 500;
const NAME_MAX = 300;

export type AnswerProblemReportDatabase = Pick<
  PrismaClient,
  "answerProblemReport" | "chat" | "message" | "modelRun" | "project" | "providerConnection" | "user"
>;

/** A persisted, settled answer the user may report, and its run when it has one. */
export type AnswerProblemReportTarget = Readonly<{ chatId: string; messageId: string; runId: string | null }>;

export type AnswerProblemReportRecord = Readonly<{ comment: string | null; reason: AnswerProblemReason; updatedAt: Date }>;

export type AnswerProblemReportRepository = Readonly<{
  /** Null for an answer that does not exist, that the user cannot see, or that is not settled. */
  resolveAnswer(input: Readonly<{ chatId: string; messageId: string; now: Date; userId: string }>): Promise<AnswerProblemReportTarget | null>;
  readOwn(target: AnswerProblemReportTarget, userId: string): Promise<AnswerProblemReportRecord | null>;
  /** Creates the user's report on the answer or updates it; null when the answer vanished meanwhile. */
  save(input: Readonly<{
    comment: string | null;
    reason: AnswerProblemReason;
    target: AnswerProblemReportTarget;
    userId: string;
  }>): Promise<Readonly<{ outcome: "created" | "updated"; report: AnswerProblemReportRecord }> | null>;
}>;

const SETTLED_ANSWER = ["complete", "error", "cancelled"] as const;
const recordSelect = { comment: true, reason: true, updatedAt: true } satisfies Prisma.AnswerProblemReportSelect;

function knownCode(error: unknown): string | null {
  return error instanceof Prisma.PrismaClientKnownRequestError ? error.code : null;
}

export function createPrismaAnswerProblemReportRepository(db: AnswerProblemReportDatabase): AnswerProblemReportRepository {
  return Object.freeze({
    async resolveAnswer({ chatId, messageId, now, userId }) {
      try {
        // Personal: the owner only. Project: a current member of any role;
        // a deleting Project, a former member and an administrator who is
        // not a member get nothing.
        const access = await resolveChatAccess(db, { chatId, userId });
        if (!access) return null;
        const chat = await db.chat.findUnique({ select: { memoryMode: true, temporaryRetentionDeadline: true }, where: { id: chatId } });
        if (!chat || (chat.memoryMode === "TEMPORARY" && chat.temporaryRetentionDeadline !== null &&
          chat.temporaryRetentionDeadline <= now)) return null;
        const answer = await db.message.findFirst({
          select: { id: true },
          where: { chatId, id: messageId, role: "assistant", status: { in: [...SETTLED_ANSWER] } }
        });
        if (!answer) return null;
        const run = await db.modelRun.findFirst({
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: { id: true },
          where: { assistantMessageId: answer.id, chatId }
        });
        return { chatId, messageId: answer.id, runId: run?.id ?? null };
      } catch (error) {
        return retainDatabaseFailure(error);
      }
    },

    async readOwn(target, userId) {
      try {
        return await db.answerProblemReport.findFirst({
          select: recordSelect, where: { chatId: target.chatId, messageId: target.messageId, userId }
        });
      } catch (error) {
        return retainDatabaseFailure(error);
      }
    },

    async save({ comment, reason, target, userId }) {
      try {
        const report = await db.answerProblemReport.create({
          data: { chatId: target.chatId, comment, messageId: target.messageId, reason, runId: target.runId, userId },
          select: recordSelect
        });
        return { outcome: "created", report };
      } catch (error) {
        // The answer, its chat or its run was deleted after it was resolved.
        if (knownCode(error) === "P2003") return null;
        if (knownCode(error) !== "P2002") return retainDatabaseFailure(error);
      }
      try {
        const report = await db.answerProblemReport.update({
          data: { comment, reason, runId: target.runId },
          select: recordSelect,
          where: { messageId_userId: { messageId: target.messageId, userId } }
        });
        return { outcome: "updated", report };
      } catch (error) {
        if (knownCode(error) === "P2003" || knownCode(error) === "P2025") return null;
        return retainDatabaseFailure(error);
      }
    }
  });
}

/** One report as administrators and the agent report read it. */
export type AnswerProblemReportListRow = Readonly<{
  id: string;
  reason: AnswerProblemReason;
  comment: string | null;
  createdAt: Date;
  updatedAt: Date;
  runId: string | null;
  user: Readonly<{ id: string; displayName: string; email: string | null }>;
  /** Null when the answer had no recorded run or its run named no connection or model. */
  connectionName: string | null;
  modelName: string | null;
}>;

function displayName(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? Array.from(trimmed).slice(0, NAME_MAX).join("") : null;
}

/**
 * Reports last sent at or after `from` (and before `to`, when given; of one
 * user, when `userId` is given), newest first, at most `limit` (1–500), with
 * the total in that window. Connection
 * and model names are the current ones of the run's answer binding; a deleted
 * connection reads as such. Health and the agent report both read this.
 */
export async function listAnswerProblemReports(
  db: Pick<PrismaClient, "answerProblemReport" | "providerConnection">,
  input: Readonly<{ from: Date; limit: number; to?: Date; userId?: string }>
): Promise<Readonly<{ rows: AnswerProblemReportListRow[]; total: number }>> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > LIST_MAX_ROWS ||
    Number.isNaN(input.from.getTime()) || (input.to !== undefined && Number.isNaN(input.to.getTime()))) {
    throw new RangeError("answer_problem_report_list_invalid");
  }
  const where = {
    updatedAt: { gte: input.from, ...(input.to ? { lt: input.to } : {}) },
    ...(input.userId !== undefined ? { userId: input.userId } : {})
  } satisfies Prisma.AnswerProblemReportWhereInput;
  try {
    const [total, rows] = await Promise.all([
      db.answerProblemReport.count({ where }),
      db.answerProblemReport.findMany({
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        select: {
          comment: true, createdAt: true, id: true, reason: true, runId: true, updatedAt: true,
          run: { select: { providerRunBindings: {
            select: { connectionId: true, model: { select: { displayName: true, modelId: true } }, providerModelId: true },
            take: 1, where: { bindingKey: "answer" }
          } } },
          user: { select: { displayName: true, email: true, id: true } }
        },
        take: input.limit,
        where
      })
    ]);
    const connectionIds = [...new Set(rows.flatMap((row) => row.run?.providerRunBindings[0]?.connectionId ?? []))];
    const connections = connectionIds.length === 0 ? [] : await db.providerConnection.findMany({
      select: { displayName: true, id: true }, where: { id: { in: connectionIds } }
    });
    const connectionNames = new Map(connections.map((connection) => [connection.id, connection.displayName]));
    return {
      rows: rows.map((row) => {
        const binding = row.run?.providerRunBindings[0] ?? null;
        const connectionId = binding?.connectionId ?? null;
        return {
          comment: row.comment,
          connectionName: connectionId === null ? null
            : connectionNames.has(connectionId) ? displayName(connectionNames.get(connectionId)) ?? "Unnamed connection" : "Deleted connection",
          createdAt: row.createdAt,
          id: row.id,
          modelName: binding?.providerModelId ? displayName(binding.model?.displayName) ?? displayName(binding.model?.modelId) ?? "Deleted model"
            : null,
          reason: row.reason,
          runId: row.runId,
          updatedAt: row.updatedAt,
          user: { displayName: row.user.displayName, email: row.user.email, id: row.user.id }
        };
      }),
      total
    };
  } catch (error) {
    return retainDatabaseFailure(error);
  }
}

/**
 * Deletes reports last changed more than 90 days before `now`, oldest first,
 * in bounded batches; a long backlog continues on the next pass.
 */
export async function deleteExpiredAnswerProblemReports(
  db: Pick<PrismaClient, "answerProblemReport">,
  now: Date
): Promise<number> {
  const cutoff = new Date(now.getTime() - ANSWER_PROBLEM_REPORT_RETENTION_MS);
  let deleted = 0;
  try {
    for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch += 1) {
      const expired = await db.answerProblemReport.findMany({
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }], select: { id: true }, take: PRUNE_BATCH_ROWS,
        where: { updatedAt: { lt: cutoff } }
      });
      if (expired.length === 0) break;
      // The cutoff is rechecked so a report updated meanwhile stays.
      const result = await db.answerProblemReport.deleteMany({
        where: { id: { in: expired.map((row) => row.id) }, updatedAt: { lt: cutoff } }
      });
      deleted += result.count;
      if (expired.length < PRUNE_BATCH_ROWS) break;
    }
    return deleted;
  } catch (error) {
    return retainDatabaseFailure(error);
  }
}
