import { Prisma } from "@prisma/client";
import { omitQuietScheduledChecks, type QuietCheckOmission } from "../../domain/quietScheduledChecks";
import { answerReviewStandIn } from "./legacyAnswerReviews";

/**
 * Which scheduled turns are quiet checks, from durable facts only: the
 * message is a scheduled task's prompt (`Message.scheduledTaskPrompt`) and
 * the first scheduled run it started settled `no_update`
 * (`ModelRun.scheduledOutcome`). Both outlive the pruned occurrence history
 * and the task itself. A branch copy's turn has no run of its own, so its
 * answer's source run says how the check settled. What a reader is then
 * shown is `lib/domain/quietScheduledChecks.ts`.
 */
export type QuietCheckMessage = Readonly<{
  branchSourceModelRunId: string | null;
  id: string;
  parentMessageId: string | null;
  role: string;
  scheduledTaskPrompt: boolean;
}>;

type RunClient = Pick<Prisma.TransactionClient, "modelRun">;

const QUIET_OUTCOME = "no_update";

/** The quiet turns among `messages`, all of one chat; no read for messages without a scheduled turn, at most two otherwise. */
export async function loadQuietCheckTurnIds(db: RunClient, chatId: string, messages: readonly QuietCheckMessage[]): Promise<Set<string>> {
  const turns = messages.filter((message) => message.role === "user" && message.scheduledTaskPrompt);
  if (turns.length === 0) return new Set();
  const runs = await db.modelRun.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { scheduledOutcome: true, userMessageId: true },
    where: { chatId, scheduledOccurrenceId: { not: null }, userMessageId: { in: turns.map((turn) => turn.id) } }
  });
  const outcomes = new Map<string, string | null>();
  for (const run of runs) if (!outcomes.has(run.userMessageId)) outcomes.set(run.userMessageId, run.scheduledOutcome);
  const quiet = new Set(turns.filter((turn) => outcomes.get(turn.id) === QUIET_OUTCOME).map((turn) => turn.id));
  const copied = new Set(turns.filter((turn) => !outcomes.has(turn.id)).map((turn) => turn.id));
  const answers = copied.size === 0 ? [] : messages.filter((message) => message.role === "assistant" &&
    message.parentMessageId !== null && copied.has(message.parentMessageId) && message.branchSourceModelRunId !== null);
  if (answers.length === 0) return quiet;
  const sources = await db.modelRun.findMany({
    select: { id: true },
    where: { id: { in: [...new Set(answers.map((answer) => answer.branchSourceModelRunId!))] }, scheduledOccurrenceId: { not: null },
      scheduledOutcome: QUIET_OUTCOME }
  });
  const quietSources = new Set(sources.map((source) => source.id));
  for (const answer of answers) if (quietSources.has(answer.branchSourceModelRunId!)) quiet.add(answer.parentMessageId!);
  return quiet;
}

/** How `messages` (all of one chat, any shape: a path or a whole tree) read with their quiet checks left out. */
export async function quietCheckOmission(db: RunClient, chatId: string, messages: readonly QuietCheckMessage[]):
  Promise<QuietCheckOmission> {
  return omitQuietScheduledChecks(messages.map((message) => ({ id: message.id, parentId: message.parentMessageId, role: message.role })),
    await loadQuietCheckTurnIds(db, chatId, messages));
}

/** A message of a stored path (root first) is in a scheduled turn: the turn itself, or an answer right after it. */
function inScheduledTurn(path: readonly QuietCheckMessage[], index: number): boolean {
  const message = path[index]!;
  const previous = index > 0 ? path[index - 1]! : null;
  return message.role === "user" ? message.scheduledTaskPrompt
    : message.role === "assistant" && previous?.role === "user" && previous.scheduledTaskPrompt;
}

/**
 * What the last message of a stored path (root first, as stored) reads as
 * (`quietCheckStandIn`); null for an empty path. Only the scheduled turns
 * that end the path can stand between that message and what a reader sees,
 * so a path that ends outside one costs no read.
 */
export async function quietPathStandIn(db: RunClient, chatId: string, path: readonly QuietCheckMessage[]): Promise<string | null> {
  const last = path.at(-1);
  if (!last) return null;
  let start = path.length;
  while (start > 0 && inScheduledTurn(path, start - 1)) start -= 1;
  if (start === path.length) return last.id;
  return (await quietCheckOmission(db, chatId, path.slice(start))).resolve(last.id);
}

type StandInClient = RunClient & Pick<Prisma.TransactionClient, "$queryRaw" | "message">;

/**
 * The message a reader sees standing for the stored `messageId`: itself, or,
 * when it lies in a quiet check, its nearest stored ancestor outside every
 * quiet check, null when only quiet checks lead to the root. A message
 * outside any scheduled turn costs one read; only one inside a scheduled turn
 * reads its stored path, in one statement bounded by the chat's message count.
 */
export async function quietCheckStandIn(db: StandInClient, chatId: string, messageId: string): Promise<string | null> {
  const message = await db.message.findFirst({
    select: { parent: { select: { role: true, scheduledTaskPrompt: true } }, role: true, scheduledTaskPrompt: true },
    where: { chatId, id: messageId }
  });
  const scheduledTurn = message?.role === "user" ? message.scheduledTaskPrompt
    : message?.role === "assistant" && message.parent?.role === "user" && message.parent.scheduledTaskPrompt;
  if (!scheduledTurn) return messageId;
  const path = await loadStoredPath(db, chatId, messageId);
  return path.at(-1)?.id === messageId ? quietPathStandIn(db, chatId, path) : messageId;
}

/**
 * The native runs of the quiet checks on the stored branch up to `userMessageId` that hold a call whose outcome is
 * unknown, each with the first message after it that the branch shows. The conversation leaves quiet checks out, so this
 * is how the unknown-effect guard still counts their calls while the model never reads them; a chat without such a run
 * costs one read and no transcript.
 */
export async function loadQuietCheckEffectRuns(db: StandInClient, input: Readonly<{ chatId: string; userId: string;
  userMessageId: string }>): Promise<Array<Readonly<{ nextMessageId: string; runId: string }>>> {
  const candidates = await db.modelRun.findMany({
    select: { assistantMessageId: true, id: true },
    where: { chatId: input.chatId, engine: "native", scheduledOccurrenceId: { not: null }, scheduledOutcome: QUIET_OUTCOME,
      subagentTurnId: null, toolCalls: { some: { OR: [{ state: "running" },
        { result: { equals: "unknown", path: ["outcome"] }, state: "error" }] } }, userId: input.userId }
  });
  if (candidates.length === 0) return [];
  const path = await loadStoredPath(db, input.chatId, input.userMessageId);
  const omission = await quietCheckOmission(db, input.chatId, path);
  const index = new Map(path.map((message, position) => [message.id, position]));
  return candidates.flatMap((run) => {
    const at = run.assistantMessageId ? index.get(run.assistantMessageId) : undefined;
    if (at === undefined || !omission.removed.has(run.assistantMessageId!)) return [];
    const next = path.slice(at + 1).find((message) => !omission.removed.has(message.id));
    return next ? [{ nextMessageId: next.id, runId: run.id }] : [];
  });
}

/** The stored path from the root to `messageId`, root first, in one statement bounded by the chat's message count. */
async function loadStoredPath(db: Pick<Prisma.TransactionClient, "$queryRaw">, chatId: string, messageId: string):
  Promise<QuietCheckMessage[]> {
  return db.$queryRaw<QuietCheckMessage[]>(Prisma.sql`
    WITH RECURSIVE "bound" AS MATERIALIZED (
      SELECT count(*)::int AS "messages" FROM "Message" WHERE "chatId" = ${chatId}
    ), "path" AS (
      SELECT message."id", message."parentMessageId", message."role", message."scheduledTaskPrompt",
        message."branchSourceModelRunId", 0 AS "depth"
      FROM "Message" AS message
      WHERE message."chatId" = ${chatId} AND message."id" = ${messageId}
      UNION ALL
      SELECT parent."id", parent."parentMessageId", parent."role", parent."scheduledTaskPrompt", parent."branchSourceModelRunId",
        path."depth" + 1
      FROM "path" AS path
      CROSS JOIN "bound"
      CROSS JOIN LATERAL (
        SELECT message."id", message."parentMessageId", message."role", message."scheduledTaskPrompt", message."branchSourceModelRunId"
        FROM "Message" AS message
        WHERE message."id" = path."parentMessageId" AND message."chatId" = ${chatId}
        LIMIT 1
      ) AS parent
      WHERE path."depth" < "bound"."messages"
    )
    SELECT "id", "parentMessageId", "role", "scheduledTaskPrompt", "branchSourceModelRunId" FROM "path" ORDER BY "depth" DESC
  `);
}

/**
 * What a stored message reads as wherever the browser names a message it was
 * shown: the version standing for a step of an answer review recorded before
 * that feature's removal, then past any quiet check.
 */
export async function visibleStandIn(db: StandInClient & Pick<Prisma.TransactionClient, "answerReviewSession">, chatId: string,
  messageId: string): Promise<string | null> {
  return quietCheckStandIn(db, chatId, await answerReviewStandIn(db, chatId, messageId));
}

/**
 * The summary line of a chat's quiet checks: how many of its scheduled runs
 * settled with no update and when the latest of them started. Counts and a
 * time only, never an identifier; null without any.
 */
export async function loadQuietCheckSummary(db: RunClient, chatId: string): Promise<Readonly<{ count: number; lastAt: Date }> | null> {
  const summary = await db.modelRun.aggregate({
    _count: { _all: true },
    _max: { createdAt: true },
    where: { chatId, scheduledOccurrenceId: { not: null }, scheduledOutcome: QUIET_OUTCOME, subagentTurnId: null }
  });
  return summary._count._all > 0 && summary._max.createdAt ? { count: summary._count._all, lastAt: summary._max.createdAt } : null;
}
