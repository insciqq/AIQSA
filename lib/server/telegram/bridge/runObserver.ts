import { logEvent } from "../../observability";
import type { TelegramBotSession } from "../dispatcher";
import type { TelegramLinkRecord } from "../store/links";
import type { TelegramAdmitted } from "./admission";
import { deliverTelegramRun, type TelegramDeliveryDeps, type TelegramDeliveryResult } from "./delivery";
import { createTelegramDraftStreamer } from "./drafts";
import { publishTelegramRunEvent, type TelegramRunEvent, type TelegramRunEventContext } from "./events";

/**
 * Follows one admitted run in this process: the typed events go to the
 * subscribers in order, the answer streams into its draft (D-09), and once the
 * run settled the final message is delivered and `delivered` published. A run
 * this process stops following before it settled stays pending for recovery.
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
  await publish({ messageIds: result.messageIds, sent: result.state === "delivered", status, type: "delivered" }, {
    ...context, bot: result.bot, chatId: result.answer.chatId
  });
}

export async function observeTelegramRun(deps: TelegramRunObserverDeps, input: TelegramRunObservation): Promise<void> {
  const publish = deps.publish ?? publishTelegramRunEvent;
  const { admission, bot, link } = input;
  const context: TelegramRunEventContext = {
    bot, chatId: admission.chatId, linkId: link.id, runId: admission.runId, source: "live", telegramChatId: link.telegramChatId,
    userId: link.userId
  };
  const drafts = createTelegramDraftStreamer({
    api: bot.api, chatId: link.telegramChatId, draftId: admission.draftId,
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
