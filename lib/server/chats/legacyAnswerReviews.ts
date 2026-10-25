import { Prisma } from "@prisma/client";
import {
  collapseAnswerReviews,
  collapseAnswerReviewTree,
  type AnswerReviewCollapse,
  type AnswerReviewTranscriptMessage,
  type AnswerReviewTranscriptSession
} from "../../domain/answerReviewTranscript";
import { isRetiredAnswerReviewStep } from "../runs/retiredAnswerReview";

/**
 * Answer Review is removed (operator decision 2026-10-25) and nothing writes
 * its storage. A session recorded before then reads as its source question
 * followed only by its latest version (`lib/domain/answerReviewTranscript.ts`)
 * wherever a chat is read: the browser's transcript and branch graph, message
 * search, exports, shares, branch copies and run context. The browser
 * therefore only ever names a message it was shown; the reads below say which
 * stored message stands behind it.
 */

type SessionClient = Pick<Prisma.TransactionClient, "answerReviewSession">;
type PathClient = Pick<Prisma.TransactionClient, "$queryRaw" | "answerReviewSession" | "message">;

/** The one session read the collapse needs: each session's id and source answer, within the chat. */
export async function loadAnswerReviewSessions(
  db: SessionClient,
  chatId: string,
  sessionIds?: readonly string[]
): Promise<AnswerReviewTranscriptSession[]> {
  if (sessionIds && sessionIds.length === 0) return [];
  return db.answerReviewSession.findMany({
    select: { id: true, sourceAssistantMessageId: true },
    where: { chatId, ...(sessionIds ? { id: { in: [...new Set(sessionIds)] } } : {}) }
  });
}

/** The collapse of messages of one chat; sessions are read only when one of them is a step. */
export async function collapseChatAnswerReviews(
  db: SessionClient,
  chatId: string,
  messages: readonly AnswerReviewTranscriptMessage[]
): Promise<AnswerReviewCollapse> {
  const sessionIds = messages.flatMap((message) => message.answerReviewSessionId ?? []);
  return collapseAnswerReviews(messages, sessionIds.length > 0 ? await loadAnswerReviewSessions(db, chatId, sessionIds) : []);
}

/** A branch graph as its paths read; `activeLeafId` is the message standing for the chat's leaf. */
export async function collapseChatAnswerReviewTree(
  db: SessionClient,
  chatId: string,
  messages: readonly AnswerReviewTranscriptMessage[],
  activeLeafMessageId: string | null
): Promise<Omit<AnswerReviewCollapse, "replacements"> & Readonly<{ activeLeafId: string | null }>> {
  const sessionIds = messages.flatMap((message) => message.answerReviewSessionId ?? []);
  const sessions = sessionIds.length > 0 ? await loadAnswerReviewSessions(db, chatId, sessionIds) : [];
  const tree = collapseAnswerReviewTree(messages, sessions, activeLeafMessageId ? [activeLeafMessageId] : []);
  if (!activeLeafMessageId || sessions.length === 0) return { ...tree, activeLeafId: activeLeafMessageId };
  const byId = new Map(messages.map((message) => [message.id, message]));
  const path: AnswerReviewTranscriptMessage[] = [];
  const seen = new Set<string>();
  for (let current = byId.get(activeLeafMessageId); current && !seen.has(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined) {
    seen.add(current.id);
    path.push(current);
  }
  const collapse = collapseAnswerReviews(path.reverse(), sessions);
  return { ...tree, activeLeafId: collapse.replacements.get(activeLeafMessageId) ?? activeLeafMessageId };
}

/**
 * Every message of the user's recorded sessions that no path shows (steps
 * and superseded versions), for message search, which reads every branch of
 * every chat. A session's rows (its source answer and its steps) decide what
 * its paths keep, so nothing else of the chat is read.
 */
export async function hiddenAnswerReviewMessageIds(
  db: Pick<Prisma.TransactionClient, "answerReviewSession" | "message">,
  userId: string
): Promise<string[]> {
  const sessions = await db.answerReviewSession.findMany({
    select: { id: true, sourceAssistantMessageId: true },
    where: { chat: { userId } }
  });
  if (sessions.length === 0) return [];
  const rows = await db.message.findMany({
    select: { answerReviewSessionId: true, id: true, parentMessageId: true, role: true, status: true, systemTurnKind: true },
    where: { OR: [
      { answerReviewSessionId: { in: sessions.map((session) => session.id) } },
      { id: { in: sessions.map((session) => session.sourceAssistantMessageId) } }
    ] }
  });
  return [...collapseAnswerReviewTree(rows.map((row) => ({ answerReviewSessionId: row.answerReviewSessionId, id: row.id,
    parentId: row.parentMessageId, role: row.role, status: row.status, systemTurnKind: row.systemTurnKind })), sessions).removed];
}

/** How a reader sees the path ending at a stored step. */
export type AnswerReviewPathView = Readonly<{
  /** The kept message standing for the path's end: the end itself, or the version that replaces it. */
  standInId: string;
  /** The parent a kept message of the path reads as; undefined for a message off the path or removed. */
  parentOf(messageId: string): string | null | undefined;
}>;

/**
 * The path from `messageId` to its root as a reader sees it, or null when
 * the message is no step of a session, so it stands for itself with its own
 * parents (the common case costs one primary-key read).
 */
export async function loadAnswerReviewPathView(
  db: PathClient,
  chatId: string,
  messageId: string
): Promise<AnswerReviewPathView | null> {
  const message = await db.message.findFirst({ select: { answerReviewSessionId: true }, where: { chatId, id: messageId } });
  if (!message?.answerReviewSessionId) return null;
  const rows = await db.$queryRaw<Array<{
    answerReviewSessionId: string | null;
    id: string;
    parentMessageId: string | null;
    role: string;
    status: string;
    systemTurnKind: string | null;
  }>>(Prisma.sql`
    WITH RECURSIVE "bound" AS MATERIALIZED (
      SELECT count(*)::int AS "messages" FROM "Message" WHERE "chatId" = ${chatId}
    ), "path" AS (
      SELECT message."id", message."parentMessageId", message."role", message."status"::text AS "status",
        message."answerReviewSessionId", message."systemTurnKind"::text AS "systemTurnKind", 0 AS "depth"
      FROM "Message" AS message
      WHERE message."chatId" = ${chatId} AND message."id" = ${messageId}
      UNION ALL
      SELECT parent."id", parent."parentMessageId", parent."role", parent."status", parent."answerReviewSessionId",
        parent."systemTurnKind", path."depth" + 1
      FROM "path" AS path
      CROSS JOIN "bound"
      CROSS JOIN LATERAL (
        SELECT message."id", message."parentMessageId", message."role", message."status"::text AS "status",
          message."answerReviewSessionId", message."systemTurnKind"::text AS "systemTurnKind"
        FROM "Message" AS message
        WHERE message."id" = path."parentMessageId" AND message."chatId" = ${chatId}
        LIMIT 1
      ) AS parent
      WHERE path."depth" < "bound"."messages"
    )
    SELECT "id", "parentMessageId", "role", "status", "answerReviewSessionId", "systemTurnKind" FROM "path" ORDER BY "depth" DESC
  `);
  const path = rows.map((row) => ({ answerReviewSessionId: row.answerReviewSessionId, id: row.id, parentId: row.parentMessageId,
    role: row.role, status: row.status, systemTurnKind: row.systemTurnKind }));
  const collapse = await collapseChatAnswerReviews(db, chatId, path);
  const parents = new Map(path.map((entry) => [entry.id, entry.parentId]));
  return {
    parentOf: (id) => collapse.removed.has(id) || !parents.has(id) ? undefined
      : collapse.parents.has(id) ? collapse.parents.get(id) ?? null : parents.get(id) ?? null,
    standInId: collapse.replacements.get(messageId) ?? messageId
  };
}

/** The message standing for `messageId` as a reader sees it: itself unless it is a step a version replaces. */
export async function answerReviewStandIn(db: PathClient, chatId: string, messageId: string): Promise<string> {
  return (await loadAnswerReviewPathView(db, chatId, messageId))?.standInId ?? messageId;
}

/**
 * The question a session's version answers as a reader sees it: the source
 * answer's question. Null for any other step (a review, a revision request
 * or a revision that never completed), which no reader can act on.
 */
export async function answerReviewVersionQuestion(db: PathClient, chatId: string, answerId: string): Promise<string | null> {
  const view = await loadAnswerReviewPathView(db, chatId, answerId);
  return view && view.standInId === answerId ? view.parentOf(answerId) ?? null : null;
}

/** Deleting a step deletes the answer it reads as: its session from the source answer down. */
export async function answerReviewDeletionRoot(
  db: Pick<Prisma.TransactionClient, "answerReviewSession" | "message">,
  chatId: string,
  messageId: string
): Promise<string> {
  const message = await db.message.findFirst({ select: { answerReviewSessionId: true }, where: { chatId, id: messageId } });
  if (!message?.answerReviewSessionId) return messageId;
  const [session] = await loadAnswerReviewSessions(db, chatId, [message.answerReviewSessionId]);
  return session?.sourceAssistantMessageId ?? messageId;
}

const STEP_TOOL_NAMES: ReadonlySet<string> = new Set(["submit_answer_review", "record_review_decisions"]);

/**
 * A step's own report call (its review or its decisions), which only a step's
 * run made: never shown in the answer's activity, since the step is no
 * answer any more. A revised version keeps its other calls.
 */
export function isAnswerReviewStepToolCall(normalizedRequest: unknown, toolName: string): boolean {
  return STEP_TOOL_NAMES.has(toolName) && isRetiredAnswerReviewStep(normalizedRequest);
}
