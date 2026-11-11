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
 * The native runs of the chat's quiet checks whose main agent left a call unfinished (pending, running, failed or
 * cancelled), for the unknown-effect guard: the conversation leaves quiet checks out, so this is how their calls still
 * count while the model never reads them. Which of those calls are still unknown is the guard's own call
 * (`unknownEffectsOf` over the runs' transcripts, `lib/server/engine/unknownEffects.ts`), so every shape a call's
 * uncertainty takes counts: a result the call recorded as unknown, the run's ending closing it, or no result at all.
 * Every such run of the chat and owner counts, on any branch: a reply hangs from the latest shown turn, so the quiet
 * checks after it leave its path, and a run from elsewhere only makes the guard stricter. Each comes with the first user
 * message shown on the reply's branch that was written after it, the reply itself at the latest: what the user wrote
 * since. A chat without such a run costs one read and no transcript.
 */
export async function loadQuietCheckEffectRuns(db: StandInClient, input: Readonly<{ chatId: string; userId: string;
  userMessageId: string }>): Promise<Array<Readonly<{ nextMessageId: string; runId: string }>>> {
  const candidates = await db.modelRun.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { createdAt: true, id: true },
    where: { chatId: input.chatId, engine: "native", scheduledOccurrenceId: { not: null }, scheduledOutcome: QUIET_OUTCOME,
      subagentTurnId: null, toolCalls: { some: { state: { not: "complete" }, subagentThreadId: null } }, userId: input.userId }
  });
  if (candidates.length === 0) return [];
  const path = await loadStoredPath(db, input.chatId, input.userMessageId);
  const omission = await quietCheckOmission(db, input.chatId, path);
  const shownTurns = path.filter((message) => message.role === "user" && !omission.removed.has(message.id));
  return candidates.map((run) => ({
    nextMessageId: shownTurns.find((message) => message.createdAt.getTime() > run.createdAt.getTime())?.id ?? input.userMessageId,
    runId: run.id
  }));
}

/** The stored path from the root to `messageId`, root first, in one statement bounded by the chat's message count. */
async function loadStoredPath(db: Pick<Prisma.TransactionClient, "$queryRaw">, chatId: string, messageId: string):
  Promise<Array<QuietCheckMessage & Readonly<{ createdAt: Date }>>> {
  return db.$queryRaw<Array<QuietCheckMessage & Readonly<{ createdAt: Date }>>>(Prisma.sql`
    WITH RECURSIVE "bound" AS MATERIALIZED (
      SELECT count(*)::int AS "messages" FROM "Message" WHERE "chatId" = ${chatId}
    ), "path" AS (
      SELECT message."id", message."parentMessageId", message."role", message."scheduledTaskPrompt",
        message."branchSourceModelRunId", message."createdAt", 0 AS "depth"
      FROM "Message" AS message
      WHERE message."chatId" = ${chatId} AND message."id" = ${messageId}
      UNION ALL
      SELECT parent."id", parent."parentMessageId", parent."role", parent."scheduledTaskPrompt", parent."branchSourceModelRunId",
        parent."createdAt", path."depth" + 1
      FROM "path" AS path
      CROSS JOIN "bound"
      CROSS JOIN LATERAL (
        SELECT message."id", message."parentMessageId", message."role", message."scheduledTaskPrompt", message."branchSourceModelRunId",
          message."createdAt"
        FROM "Message" AS message
        WHERE message."id" = path."parentMessageId" AND message."chatId" = ${chatId}
        LIMIT 1
      ) AS parent
      WHERE path."depth" < "bound"."messages"
    )
    SELECT "id", "parentMessageId", "role", "scheduledTaskPrompt", "branchSourceModelRunId", "createdAt" FROM "path"
    ORDER BY "depth" DESC
  `);
}

/**
 * The quiet-turn rule of `loadQuietCheckTurnIds` as SQL over the message row named `alias` (an identifier of the calling
 * query, never input), for a query that cannot load its rows first, such as message search over every chat: a scheduled
 * prompt whose first scheduled run settled `no_update`, or, for a branch copy without a run of its own, one with an answer
 * whose source run did. It is never null.
 */
export function quietTurnSql(alias: "message" | "parent"): Prisma.Sql {
  const row = Prisma.raw(`"${alias}"`);
  return Prisma.sql`(${row}."role" = 'user' AND ${row}."scheduledTaskPrompt" AND COALESCE((
      SELECT COALESCE(run."scheduledOutcome", '') = ${QUIET_OUTCOME}
      FROM "ModelRun" AS run
      WHERE run."userMessageId" = ${row}."id" AND run."chatId" = ${row}."chatId" AND run."scheduledOccurrenceId" IS NOT NULL
      ORDER BY run."createdAt" ASC, run."id" ASC
      LIMIT 1
    ), EXISTS (
      SELECT 1
      FROM "Message" AS copy
      INNER JOIN "ModelRun" AS source ON source."id" = copy."branchSourceModelRunId"
      WHERE copy."chatId" = ${row}."chatId" AND copy."parentMessageId" = ${row}."id" AND copy."role" = 'assistant'
        AND source."scheduledOccurrenceId" IS NOT NULL AND source."scheduledOutcome" = ${QUIET_OUTCOME}
    )))`;
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
