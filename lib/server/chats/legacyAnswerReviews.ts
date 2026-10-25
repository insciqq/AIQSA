import { Prisma } from "@prisma/client";
import {
  answerReviewDeletionPlan,
  collapseAnswerReviews,
  collapseAnswerReviewTree,
  type AnswerReviewCollapse,
  type AnswerReviewDeletionPlan,
  type AnswerReviewTranscriptMessage,
  type AnswerReviewTranscriptSession
} from "../../domain/answerReviewTranscript";
import { isRetiredAnswerReviewStep } from "../runs/retiredAnswerReview";

/**
 * Answer Review is removed (operator decision 2026-10-25) and nothing writes
 * its storage. A session recorded before then reads as its source question
 * followed only by its latest version (`lib/domain/answerReviewTranscript.ts`)
 * wherever a chat is read: the browser's transcript and branch graph, message
 * search, the Files library, Workspace export history, exports, shares,
 * branch copies, continuation into a new chat and run context. The browser
 * therefore only ever names a message it was shown; the reads below say which
 * stored message stands behind it.
 */

type SessionClient = Pick<Prisma.TransactionClient, "answerReviewSession">;
type PathClient = Pick<Prisma.TransactionClient, "$queryRaw" | "answerReviewSession" | "message">;
type ChatsClient = Pick<Prisma.TransactionClient, "answerReviewSession" | "chat" | "message">;

const transcriptSelect = {
  answerReviewSessionId: true, id: true, parentMessageId: true, role: true, status: true, systemTurnKind: true
} satisfies Prisma.MessageSelect;

type TranscriptRow = Readonly<{
  answerReviewSessionId: string | null;
  id: string;
  parentMessageId: string | null;
  role: string;
  status: string;
  systemTurnKind: string | null;
}>;

function transcriptMessage(row: TranscriptRow): AnswerReviewTranscriptMessage {
  return { answerReviewSessionId: row.answerReviewSessionId, id: row.id, parentId: row.parentMessageId, role: row.role,
    status: row.status, systemTurnKind: row.systemTurnKind };
}

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

/** The path collapse of the stored path to the chat's active leaf. */
function activePathCollapse(messages: readonly AnswerReviewTranscriptMessage[], sessions: readonly AnswerReviewTranscriptSession[],
  activeLeafMessageId: string | null): AnswerReviewCollapse {
  if (!activeLeafMessageId) return { parents: new Map(), removed: new Set(), replacements: new Map() };
  const byId = new Map(messages.map((message) => [message.id, message]));
  const path: AnswerReviewTranscriptMessage[] = [];
  const seen = new Set<string>();
  for (let current = byId.get(activeLeafMessageId); current && !seen.has(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined) {
    seen.add(current.id);
    path.push(current);
  }
  return collapseAnswerReviews(path.reverse(), sessions);
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
  const collapse = activePathCollapse(messages, sessions, activeLeafMessageId);
  return { ...tree, activeLeafId: collapse.replacements.get(activeLeafMessageId) ?? activeLeafMessageId };
}

/** Each of the user's chats that holds a recorded session, read whole: its active leaf, messages and sessions. */
async function loadReviewedChats(db: ChatsClient, userId: string) {
  const sessions = await db.answerReviewSession.findMany({
    select: { chatId: true, id: true, sourceAssistantMessageId: true },
    where: { chat: { userId } }
  });
  if (sessions.length === 0) return [];
  const chatIds = [...new Set(sessions.map((session) => session.chatId))];
  const chats = await db.chat.findMany({ select: { activeLeafMessageId: true, id: true }, where: { id: { in: chatIds }, userId } });
  const rows = await db.message.findMany({ select: { ...transcriptSelect, chatId: true }, where: { chatId: { in: chatIds } } });
  return chats.map((chat) => ({
    activeLeafMessageId: chat.activeLeafMessageId,
    messages: rows.filter((row) => row.chatId === chat.id).map(transcriptMessage),
    sessions: sessions.filter((session) => session.chatId === chat.id)
  }));
}

/**
 * Every message of the user's chats that no path shows (the recorded
 * sessions' steps and superseded versions), for message search, which reads
 * every branch of every chat: each chat with a session reads as its branch
 * graph does.
 */
export async function hiddenAnswerReviewMessageIds(db: ChatsClient, userId: string): Promise<string[]> {
  return (await loadReviewedChats(db, userId)).flatMap((chat) => [...collapseAnswerReviewTree(chat.messages, chat.sessions,
    chat.activeLeafMessageId ? [chat.activeLeafMessageId] : []).removed]);
}

/** The messages of the user's active paths that those paths do not show, for readers of the active paths only. */
export async function hiddenActivePathMessageIds(db: ChatsClient, userId: string): Promise<string[]> {
  return (await loadReviewedChats(db, userId)).flatMap((chat) =>
    [...activePathCollapse(chat.messages, chat.sessions, chat.activeLeafMessageId).removed]);
}

/** How a reader sees the path ending at a stored step. */
export type AnswerReviewPathView = Readonly<{
  /** The kept message standing for the path's end: the end itself, or the version that replaces it. */
  standInId: string;
  /** The parent a kept message of the path reads as; undefined for a message off the path or removed. */
  parentOf(messageId: string): string | null | undefined;
}>;

/** The stored path from the root to `messageId`, root first, bounded by the chat's message count. */
async function loadStoredPath(db: Pick<Prisma.TransactionClient, "$queryRaw">, chatId: string, messageId: string):
  Promise<AnswerReviewTranscriptMessage[]> {
  const rows = await db.$queryRaw<TranscriptRow[]>(Prisma.sql`
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
  return rows.map(transcriptMessage);
}

/**
 * The path from `messageId` to its root as a reader sees it, or null when
 * the message is no step of a session, so it stands for itself with its own
 * parents (the common case costs a primary-key read of it and its parent). A
 * message whose parent carries a session counts as a step: the previous
 * release regenerated a version as a copy without its session.
 */
export async function loadAnswerReviewPathView(
  db: PathClient,
  chatId: string,
  messageId: string
): Promise<AnswerReviewPathView | null> {
  const message = await db.message.findFirst({ select: { answerReviewSessionId: true, parentMessageId: true },
    where: { chatId, id: messageId } });
  if (!message) return null;
  if (!message.answerReviewSessionId) {
    const parent = message.parentMessageId ? await db.message.findFirst({ select: { answerReviewSessionId: true },
      where: { chatId, id: message.parentMessageId } }) : null;
    if (!parent?.answerReviewSessionId) return null;
  }
  const path = await loadStoredPath(db, chatId, messageId);
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

/** The stored messages of the active path to `leafMessageId` that the path does not show; none in a chat without a session. */
export async function hiddenOnActivePath(db: PathClient, chatId: string, leafMessageId: string | null): Promise<string[]> {
  if (!leafMessageId || !await db.answerReviewSession.findFirst({ select: { id: true }, where: { chatId } })) return [];
  return [...(await collapseChatAnswerReviews(db, chatId, await loadStoredPath(db, chatId, leafMessageId))).removed];
}

/**
 * What deleting `messageId` removes in a chat with a recorded session, as
 * the chat reads (`answerReviewDeletionPlan`); undefined in a chat without
 * one, where a deletion is its stored subtree, and null when no deletion
 * reads as deleting that message.
 */
export async function loadAnswerReviewDeletionPlan(
  db: Pick<Prisma.TransactionClient, "answerReviewSession" | "message">,
  chat: Readonly<{ activeLeafMessageId: string | null; id: string }>,
  messageId: string
): Promise<AnswerReviewDeletionPlan | null | undefined> {
  const sessions = await loadAnswerReviewSessions(db, chat.id);
  if (sessions.length === 0) return undefined;
  const rows = await db.message.findMany({ select: transcriptSelect, where: { chatId: chat.id } });
  return answerReviewDeletionPlan(rows.map(transcriptMessage), sessions, chat.activeLeafMessageId, messageId);
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
