import { logEvent } from "../../observability";
import { databaseFailureCode } from "../../observability/databaseFailure";
import { reachTelegramChat, type TelegramChatBinding } from "../control/reach";
import type { TelegramBotSession } from "../dispatcher";
import type { TelegramLinkRecord } from "../store/links";
import type { TelegramAdmitted } from "./admission";
import { deliverTelegramRun, type TelegramDeliveryDeps, type TelegramDeliveryResult } from "./delivery";
import { createTelegramDraftStreamer, type TelegramDraftApi } from "./drafts";
import { publishTelegramRunEvent, type TelegramRunEvent, type TelegramRunEventContext } from "./events";

/**
 * Follows one admitted run in this process: the typed events go to the
 * subscribers in order, the answer streams into its draft (D-09), and once the
 * run settled the final message is delivered and `delivered` published. A run
 * this process stops following before it settled stays pending for recovery.
 * Every draft first checks that the run's link still reaches its chat (D-04);
 * once it does not, the drafts end while the run goes on in AIQSA.
 */

export type TelegramRunObserverDeps = TelegramDeliveryDeps & Readonly<{
  publish?: (event: TelegramRunEvent, context: TelegramRunEventContext) => Promise<void>;
  /** Draft pacing, for tests. */
  draftThrottleMs?: number;
  draftRefreshMs?: number;
}>;

export type TelegramRunObservation = Readonly<{
  admission: TelegramAdmitted;
  bot: TelegramBotSession;
  link: TelegramLinkRecord;
}>;

/** Publishes `delivered` for a run whose final message was handled (live or recovery). */
export async function publishTelegramDelivery(
  publish: NonNullable<TelegramRunObserverDeps["publish"]>,
  result: TelegramDeliveryResult,
  context: Omit<TelegramRunEventContext, "bot" | "chatId">
): Promise<void> {
  if (result.state === "skipped" || !result.answer) return;
  const status = result.answer.status === "streaming" ? "complete" : result.answer.status;
  const summary = result.answer.artifactSummary;
  await publish({
    messageIds: result.messageIds, sent: result.state === "delivered", status, type: "delivered", ...(summary ? { artifactSummary: summary } : {})
  }, { ...context, bot: result.bot, chatId: result.answer.chatId });
}

/** The draft's Bot API while the run's link still reaches its chat; null (logged once) when it no longer does. */
function draftReach(deps: TelegramRunObserverDeps, binding: TelegramChatBinding, runId: string): () => Promise<TelegramDraftApi | null> {
  return async () => {
    try {
      const reached = await reachTelegramChat(deps, binding);
      if (reached.ok) return reached.bot.api;
      logEvent("service_operation", {
        code: reached.reasonCode, outcome: "skipped", run_id: runId, stage: "dispatch", subsystem: "telegram"
      });
      return null;
    } catch (error) {
      logEvent("service_operation", {
        code: "telegram_run_delivery_failed", error, outcome: "failed", prisma_code: databaseFailureCode(error), run_id: runId,
        stage: "dispatch", subsystem: "telegram"
      });
      throw error;
    }
  };
}

export async function observeTelegramRun(deps: TelegramRunObserverDeps, input: TelegramRunObservation): Promise<void> {
  const publish = deps.publish ?? publishTelegramRunEvent;
  const { admission, bot, link } = input;
  const context: TelegramRunEventContext = {
    bot, chatId: admission.chatId, linkId: link.id, runId: admission.runId, source: "live", telegramChatId: link.telegramChatId,
    userId: link.userId
  };
  const drafts = createTelegramDraftStreamer({
    chatId: link.telegramChatId, draftId: admission.draftId,
    reach: draftReach(deps, { botId: bot.botId, linkId: link.id, telegramChatId: link.telegramChatId, userId: link.userId }, admission.runId),
    ...(deps.draftThrottleMs === undefined ? {} : { throttleMs: deps.draftThrottleMs }),
    ...(deps.draftRefreshMs === undefined ? {} : { refreshMs: deps.draftRefreshMs })
  });
  drafts.start();
  let text = "";
  let settled = false;
  try {
    for await (const event of admission.events) {
      await publish(event, context);
      if (event.type === "answerDelta") {
        text += event.delta;
        drafts.update(text);
      } else if (event.type === "answerReset") {
        text = "";
        drafts.reset();
      } else if (event.type === "done" || event.type === "failed") {
        settled = true;
        break;
      }
    }
  } finally {
    await drafts.stop();
  }
  if (!settled) {
    // Followed past its bound without settling: a restart's recovery delivers it.
    logEvent("service_operation", {
      action: "wait", code: "telegram_run_delivery_failed", outcome: "waiting", run_id: admission.runId, stage: "settle", subsystem: "telegram"
    });
    return;
  }
  const result = await deliverTelegramRun(deps, {
    linkId: link.id, runId: admission.runId, runLinked: admission.runLinked, telegramChatId: link.telegramChatId, userId: link.userId
  });
  await publishTelegramDelivery(publish, result, {
    linkId: link.id, runId: admission.runId, source: "live", telegramChatId: link.telegramChatId, userId: link.userId
  });
}
