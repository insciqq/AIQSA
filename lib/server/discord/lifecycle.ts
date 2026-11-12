import type { PrismaClient } from "@prisma/client";
import { normalizeAnswerProblemReportComment } from "../../contracts/answerProblemReports";
import { logEvent } from "../observability";
import { retainDatabaseFailure } from "../observability/databaseFailure";
import { onDiscordRunEvent, type DiscordRunEvent, type DiscordRunEventContext } from "./bridge/events";
import { discordEventIds, logDiscordBridgeFailure, logDiscordRequestStage } from "./bridge/journal";
import type { DiscordDeleteContext, DiscordHandlerRegistry, DiscordReactionContext } from "./intake";
import type { DiscordRest } from "./rest";
import type { DiscordConversationStore } from "./store/conversations";
import type { DiscordReplyRecord, DiscordReplyState, DiscordReplyStore } from "./store/replies";

/**
 * What happens to a Discord question after it was asked (PRD D-27, D-29,
 * O-19, O-31):
 *
 * - The author deletes the question: a run still answering it is stopped (a
 *   follow-up joined to another question's run leaves that run alone), the
 *   question is journaled `interrupted` with `discord_question_deleted`, and
 *   the messages AIQSA posted for it (status, answer or refusal notice) are
 *   deleted. When AIQSA opened a thread from the question and no person wrote
 *   in it, the thread is archived (never deleted), so no empty thread stays
 *   behind. Nothing in AIQSA is purged: the turn stays in the service
 *   account's chat (O-31). An answer that still reached Discord in the race
 *   with the delete is removed once its delivery is published.
 * - 👍/👎 on an AIQSA answer by a person (or an allowed test author) is one
 *   `DiscordAnswerRating` per person and answer; removing the reaction
 *   removes it. The first 👎 on an answer also files one `AnswerProblemReport`
 *   of the service account on that answer (reason `other`), which
 *   administrators read in Health → Problem reports.
 *
 * Records are content-free (`discord_request`, `discord_rating`): Discord ids
 * and AIQSA run and chat ids, never names or text.
 */

export const DISCORD_QUESTION_DELETED_CODE = "discord_question_deleted";
const UNSETTLED: readonly DiscordReplyState[] = ["claimed", "admitted"];
/** `MESSAGE_DELETE_BULK` carries at most 100 ids. */
const DELETE_IDS_MAX = 100;
/** Discord's THREAD_STARTER_MESSAGE: the system line a thread opened from a message starts with. */
const THREAD_STARTER_MESSAGE_TYPE = 21;
const THREAD_HISTORY_PAGE = 100;

export type DiscordRatingStore = Readonly<{
  /** Records the person's rating of the answer, replacing an earlier one of theirs. */
  set(input: Readonly<{ replyId: string; discordUserId: string; value: 1 | -1; at: Date }>): Promise<void>;
  /** Removes the person's rating when it still has this value; false when there was none. */
  remove(input: Readonly<{ replyId: string; discordUserId: string; value: 1 | -1 }>): Promise<boolean>;
}>;

/** The service account's persisted answer of a run. */
export type DiscordRunAnswerRef = Readonly<{ chatId: string; assistantMessageId: string | null }>;

export type DiscordProblemReports = Readonly<{
  /** The run's chat and answer message, only for a run of this user. */
  answerOfRun(input: Readonly<{ runId: string; userId: string }>): Promise<DiscordRunAnswerRef | null>;
  /**
   * Files the user's report on a settled answer unless one exists already
   * (`exists`); `skipped` when the answer is not a settled assistant message.
   */
  fileOnce(input: Readonly<{ chatId: string; messageId: string; runId: string; userId: string; comment: string }>): Promise<"created" | "exists" | "skipped">;
}>;

export type DiscordLifecycleDeps = Readonly<{
  replies: Pick<DiscordReplyStore, "find" | "findByAnswerMessage" | "update">;
  conversations: Pick<DiscordConversationStore, "findByChannel">;
  ratings: DiscordRatingStore;
  reports: DiscordProblemReports;
  rest(): DiscordRest;
  /** The shared connector gateway's Stop, as the service account. */
  stopRun(input: Readonly<{ userId: string; runId: string }>): Promise<"stopped" | "not_cancelable" | "not_found">;
  now?: () => number;
}>;

export type DiscordLifecycle = Readonly<{
  handleDelete(context: DiscordDeleteContext): Promise<void>;
  handleReaction(context: DiscordReactionContext): Promise<void>;
  /** Follows deliveries: an answer that reached Discord after its question was deleted is deleted too. */
  onRunEvent(event: DiscordRunEvent, context: DiscordRunEventContext): Promise<void>;
  /** Registers the delete and reaction handlers and the delivery listener; returns the function that removes them. */
  register(registry: DiscordHandlerRegistry): () => void;
}>;

/** The administrator's note on a problem report a 👎 filed; the name is a display snapshot, never logged. */
export function discordRatedDownComment(input: Readonly<{ displayName: string | null; discordUserId: string; test: boolean }>): string {
  const name = input.displayName?.trim() || `discord:${input.discordUserId}`;
  const comment = `Discord${input.test ? " (test)" : ""}: rated 👎 by ${name}`;
  return normalizeAnswerProblemReportComment(comment) ?? `Discord: rated 👎 by discord:${input.discordUserId}`;
}

export function createDiscordLifecycle(deps: DiscordLifecycleDeps): DiscordLifecycle {
  const now = deps.now ?? Date.now;

  /** Deletes one of AIQSA's messages, in the question's channel or the thread AIQSA opened from it; a gone message is fine. */
  async function deleteOwn(messageId: string, channelIds: readonly string[]): Promise<void> {
    const rest = deps.rest();
    for (const channelId of new Set(channelIds)) {
      const outcome = await rest.deleteMessage(channelId, messageId);
      if (outcome.ok) return;
      if (outcome.delivery === "refused" && outcome.status === 404) continue;
      logDiscordBridgeFailure({ code: outcome.code, outcome: "skipped" });
      return;
    }
  }

  /**
   * Archives the thread AIQSA opened from a deleted question once it holds no
   * message of a person: a thread opened from a message has that message's
   * id, so a question asked inside an existing thread never names one. A
   * failure only skips the archive.
   */
  async function archiveUnusedThread(questionMessageId: string, botUserId: () => Promise<string | null>): Promise<void> {
    try {
      const conversation = await deps.conversations.findByChannel(questionMessageId);
      if (!conversation?.botOpened || conversation.kind !== "thread" || conversation.discordChannelId !== questionMessageId) return;
      const botId = await botUserId();
      if (!botId) return;
      const rest = deps.rest();
      const history = await rest.listChannelMessages(questionMessageId, { limit: THREAD_HISTORY_PAGE });
      if (!history.ok) {
        if (history.status !== 404) logDiscordBridgeFailure({ code: history.code, outcome: "skipped" });
        return;
      }
      // A full page may hide older messages of people: such a thread is left alone.
      if (history.value.length >= THREAD_HISTORY_PAGE) return;
      if (history.value.some((message) => message.type !== THREAD_STARTER_MESSAGE_TYPE && message.author?.id !== botId)) return;
      const archived = await rest.archiveThread(questionMessageId);
      if (!archived.ok) logDiscordBridgeFailure({ code: archived.code, outcome: "skipped" });
    } catch (error) {
      logDiscordBridgeFailure({ code: "discord_handler_failed", error, outcome: "skipped" });
    }
  }

  async function questionDeleted(row: DiscordReplyRecord, context: DiscordDeleteContext): Promise<void> {
    if (UNSETTLED.includes(row.state)) {
      const marked = await deps.replies.update(row.questionMessageId, { code: DISCORD_QUESTION_DELETED_CODE, state: "interrupted" }, UNSETTLED);
      if (marked) {
        logDiscordRequestStage(discordEventIds(row, { runId: row.runId }), "interrupted", {
          at: now(), code: DISCORD_QUESTION_DELETED_CODE, kind: row.kind, receivedAt: row.receivedAt
        });
        // A follow-up rides on another question's run, which still owes that question its answer.
        const userId = context.control.serviceUserId;
        if (row.runId && row.kind === "answer" && userId) {
          await deps.stopRun({ runId: row.runId, userId }).catch((error: unknown) => {
            logDiscordBridgeFailure({ code: "discord_handler_failed", error, runId: row.runId ?? undefined });
          });
        }
      }
    }
    const own = [...new Set([row.statusMessageId, row.answerMessageId].filter((id): id is string => id !== null))];
    for (const messageId of own) await deleteOwn(messageId, [row.channelId, row.questionMessageId]);
    await archiveUnusedThread(row.questionMessageId, async () => context.control.bot.userId);
  }

  async function handleDelete(context: DiscordDeleteContext): Promise<void> {
    for (const messageId of context.messageIds.slice(0, DELETE_IDS_MAX)) {
      const row = await deps.replies.find(messageId);
      // Not a question (people's talk, or AIQSA's own message): nothing to do.
      if (!row) continue;
      await questionDeleted(row, context);
    }
  }

  async function handleReaction(context: DiscordReactionContext): Promise<void> {
    const row = await deps.replies.findByAnswerMessage(context.messageId);
    // Only an answer of a run is rated; a refusal notice is not an answer.
    if (!row?.runId) return;
    const runId = row.runId;
    const userId = context.control.serviceUserId;
    const answer = userId ? await deps.reports.answerOfRun({ runId, userId }).catch(() => null) : null;
    const ids = discordEventIds({
      channelId: context.channelId, discordUserId: context.userId, guildId: context.guildId, questionMessageId: context.messageId,
      test: context.test || row.test
    }, { chatId: answer?.chatId ?? null, runId });
    const value = context.value === 1 ? "up" : "down";
    if (context.action === "add") {
      await deps.ratings.set({ at: new Date(now()), discordUserId: context.userId, replyId: row.questionMessageId, value: context.value });
      logEvent("discord_rating", { ...ids, outcome: "added", value });
      if (context.value === -1 && userId && answer?.assistantMessageId) {
        await deps.reports.fileOnce({
          chatId: answer.chatId,
          comment: discordRatedDownComment({ discordUserId: context.userId, displayName: context.displayName, test: context.test || row.test }),
          messageId: answer.assistantMessageId,
          runId,
          userId
        }).catch((error: unknown) => logDiscordBridgeFailure({ code: "discord_journal_failed", error, runId, stage: "write" }));
      }
      return;
    }
    if (await deps.ratings.remove({ discordUserId: context.userId, replyId: row.questionMessageId, value: context.value })) {
      logEvent("discord_rating", { ...ids, outcome: "removed", value });
    }
  }

  async function onRunEvent(event: DiscordRunEvent, context: DiscordRunEventContext): Promise<void> {
    if (event.type !== "delivered" || !event.sent || !event.answerMessageId) return;
    const row = await deps.replies.find(context.questionMessageId);
    if (row?.state !== "interrupted" || row.code !== DISCORD_QUESTION_DELETED_CODE) return;
    await deleteOwn(event.answerMessageId, [context.answerChannelId, context.questionChannelId]);
    // Posting the late answer unarchived a thread archived on the delete.
    if (context.answerChannelId === context.questionMessageId) {
      await archiveUnusedThread(context.questionMessageId, async () => {
        const me = await deps.rest().getCurrentUser();
        return me.ok ? me.value.id : null;
      });
    }
  }

  return Object.freeze({
    handleDelete,
    handleReaction,
    onRunEvent,
    register(registry: DiscordHandlerRegistry) {
      const removers = [registry.registerDelete(handleDelete), registry.registerReaction(handleReaction), onDiscordRunEvent(onRunEvent)];
      return () => { for (const remove of removers) remove(); };
    }
  });
}

// ---------------------------------------------------------------------------
// Persistence

type LifecycleClient = Pick<PrismaClient, "answerProblemReport" | "discordAnswerRating" | "message" | "modelRun">;

export function createPrismaDiscordRatingStore(prisma: Pick<PrismaClient, "discordAnswerRating">): DiscordRatingStore {
  return Object.freeze({
    async set({ at, discordUserId, replyId, value }) {
      const key = { discordUserId: BigInt(discordUserId), replyId: BigInt(replyId) };
      await prisma.discordAnswerRating.upsert({
        create: { ...key, createdAt: at, value },
        update: { createdAt: at, value },
        where: { replyId_discordUserId: key }
      }).catch(retainDatabaseFailure);
    },

    async remove({ discordUserId, replyId, value }) {
      const removed = await prisma.discordAnswerRating.deleteMany({
        where: { discordUserId: BigInt(discordUserId), replyId: BigInt(replyId), value }
      }).catch(retainDatabaseFailure);
      return removed.count > 0;
    }
  });
}

const SETTLED_ANSWER = ["complete", "error", "cancelled"] as const;

export function createPrismaDiscordProblemReports(prisma: LifecycleClient): DiscordProblemReports {
  return Object.freeze({
    async answerOfRun({ runId, userId }) {
      const run = await prisma.modelRun.findFirst({ select: { assistantMessageId: true, chatId: true }, where: { id: runId, userId } })
        .catch(retainDatabaseFailure);
      return run ? { assistantMessageId: run.assistantMessageId, chatId: run.chatId } : null;
    },

    async fileOnce({ chatId, comment, messageId, runId, userId }) {
      const answer = await prisma.message.findFirst({
        select: { id: true }, where: { chatId, id: messageId, role: "assistant", status: { in: [...SETTLED_ANSWER] } }
      }).catch(retainDatabaseFailure);
      if (!answer) return "skipped";
      // One report per user and answer: a later 👎 on the same answer finds it and changes nothing.
      const created = await prisma.answerProblemReport.createMany({
        data: [{ chatId, comment, messageId, reason: "other", runId, userId }],
        skipDuplicates: true
      }).catch(retainDatabaseFailure);
      return created.count === 1 ? "created" : "exists";
    }
  });
}
