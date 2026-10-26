import { logEvent } from "../../observability";
import { databaseFailureCode } from "../../observability/databaseFailure";
import type { TelegramAccessRefusal, TelegramAccessResolver } from "../control/access";
import { reachTelegramChat } from "../control/reach";
import type { TelegramSessionProvider } from "../control/session";
import { TELEGRAM_BRIDGE_COPY, TELEGRAM_COPY, telegramAnswerFailedText, telegramReasonText } from "../copy";
import type { TelegramBotSession } from "../dispatcher";
import type { TelegramDelivery } from "../outbound";
import { renderTelegramAnswer } from "../render";
import type { TelegramRunLinkStore } from "../store/runLinks";
import type { TelegramFailure } from "../transport";
import type { TelegramRunAnswer, TelegramRunGateway } from "./gateway";

/**
 * The one final message of a run started from Telegram, live or after a
 * restart: access is checked again (D-04), the persisted answer is read with
 * its citations, delivery is claimed before anything is sent so a
 * restart never sends it twice, and the claim settles `delivered`, `failed`,
 * or `unknown` when Telegram may have received it (never resent). A run that
 * was stopped or failed sends what it wrote, then why it ended. Every message
 * asks right before it leaves whether the run's exact link still reaches its
 * chat; once it does not, nothing more goes and the claim settles `failed`
 * with the access reason.
 */

export type TelegramDeliveryDeps = Readonly<{
  access: Pick<TelegramAccessResolver, "resolveTelegramAccess">;
  gateway: Pick<TelegramRunGateway, "answer">;
  runLinks: Pick<TelegramRunLinkStore, "claimDelivery" | "settle">;
  sessions: TelegramSessionProvider;
  now?: () => number;
}>;

export type TelegramDeliveryInput = Readonly<{
  runId: string;
  userId: string;
  linkId: string;
  telegramChatId: number;
  /** The run has a `TelegramRunLink` row to claim; without one the live observer delivers unclaimed. */
  runLinked: boolean;
}>;

export type TelegramDeliveryResult =
  /** Nothing to do now: the bot is off, or another delivery claimed the run. */
  | Readonly<{ state: "skipped" }>
  | Readonly<{
    state: "delivered" | "failed" | "unknown";
    answer: TelegramRunAnswer | null;
    bot: TelegramBotSession;
    messageIds: readonly number[];
  }>;

/** Content-free: run identity, stable codes and HTTP status only. */
function log(fields: Readonly<{
  code: string; error?: unknown; httpStatus?: number; outcome: "completed" | "failed" | "skipped"; runId: string;
}>): void {
  logEvent("service_operation", {
    code: fields.code, ...(fields.error ? { error: fields.error, prisma_code: databaseFailureCode(fields.error) } : {}),
    ...(fields.httpStatus ? { httpStatus: fields.httpStatus } : {}), outcome: fields.outcome, run_id: fields.runId,
    stage: "settle", subsystem: "telegram"
  });
}

/** Telegram may have received it: a timeout or a connection lost after sending. */
function ambiguous(failure: TelegramFailure): boolean {
  return failure.kind === "timeout" || failure.kind === "network_after_send";
}

export async function deliverTelegramRun(deps: TelegramDeliveryDeps, input: TelegramDeliveryInput): Promise<TelegramDeliveryResult> {
  const now = deps.now ?? Date.now;
  const bot = await deps.sessions.current();
  // The bot is off or its token unreadable: nothing can be sent, and the run stays to deliver later.
  if (!bot) return { state: "skipped" };
  const claim = () => input.runLinked ? deps.runLinks.claimDelivery(input.runId) : Promise.resolve(true);
  const settle = async (state: "delivered" | "failed" | "unknown") => {
    if (input.runLinked) await deps.runLinks.settle({ at: new Date(now()), runId: input.runId, state });
  };

  const access = await deps.access.resolveTelegramAccess(input.userId);
  if (!access.allowed || access.link.id !== input.linkId || access.link.botId !== bot.botId) {
    if (!(await claim())) return { state: "skipped" };
    // Nothing of the chat leaves; the user learns why when the link can still reach them.
    const reason = access.allowed ? null : telegramReasonText(access.reasonCode);
    if (reason && access.link?.id === input.linkId && access.link.botId === bot.botId) {
      await bot.outbound.sendText({ chatId: input.telegramChatId, text: reason });
    }
    await settle("failed");
    log({ code: access.allowed ? "telegram_bot_changed" : access.reasonCode, outcome: "skipped", runId: input.runId });
    return { answer: null, bot, messageIds: [], state: "failed" };
  }

  const answer = await deps.gateway.answer({ runId: input.runId, userId: input.userId });
  if (!(await claim())) return { state: "skipped" };
  const owner = answer
    ? { chatId: answer.chatId, linkId: input.linkId, messageId: answer.assistantMessageId, userId: input.userId }
    : null;
  // Asked by the Bot API right before every message leaves, after its pacing or a 429's wait.
  const recheck: { reasonCode: TelegramAccessRefusal } = { reasonCode: "telegram_access_off" };
  const binding = { botId: bot.botId, linkId: input.linkId, telegramChatId: input.telegramChatId, userId: input.userId };
  const authorize = async (): Promise<boolean> => {
    const reached = await reachTelegramChat(deps, binding);
    if (!reached.ok) recheck.reasonCode = reached.reasonCode;
    return reached.ok;
  };
  const sent: { failure: TelegramFailure | null; messageIds: number[] } = { failure: null, messageIds: [] };
  const take = (delivery: TelegramDelivery): boolean => {
    sent.messageIds.push(...delivery.messageIds);
    if (!delivery.ok) sent.failure = delivery.failure;
    return delivery.ok;
  };
  try {
    if (!answer || !owner) {
      // The chat can no longer be read here (archived, deleted): nothing to quote.
      take(await bot.outbound.sendText({ authorize, chatId: input.telegramChatId, text: TELEGRAM_BRIDGE_COPY.answerInAiqsa }));
    } else {
      const text = answer.text.trim();
      // A turn that stopped for an approval is answered by its card (`../approvals.ts`), not by a pointer to AIQSA.
      const awaitsDecision = (answer.artifactSummary?.mcpApprovals?.length ?? 0) > 0;
      const ending = answer.status === "cancelled" ? TELEGRAM_COPY.stopped
        : answer.status === "error" ? telegramAnswerFailedText(answer.errorMessage)
          : text || awaitsDecision ? null : TELEGRAM_BRIDGE_COPY.answerInAiqsa;
      let continued = true;
      if (text) {
        const rendered = renderTelegramAnswer(answer.text, { citations: answer.artifactSummary?.citations ?? [] });
        continued = take(await bot.outbound.sendContent({ authorize, chatId: input.telegramChatId, messages: rendered.messages, owner }));
      }
      if (ending && continued) {
        take(await bot.outbound.sendText({ authorize, chatId: input.telegramChatId, owner, text: ending }));
      }
    }
  } catch (error) {
    // Thrown mid-send: whether Telegram got it is unknown.
    log({ code: "telegram_delivery_unknown", error, outcome: "failed", runId: input.runId });
    await settle("unknown");
    return { answer, bot, messageIds: sent.messageIds, state: "unknown" };
  }
  if (!sent.failure) {
    await settle("delivered");
    return { answer, bot, messageIds: sent.messageIds, state: "delivered" };
  }
  if (sent.failure.kind === "unreachable") {
    // The link stopped reaching the chat mid-answer: the rest stays in AIQSA.
    await settle("failed");
    log({ code: recheck.reasonCode, outcome: "failed", runId: input.runId });
    return { answer, bot, messageIds: sent.messageIds, state: "failed" };
  }
  const state = ambiguous(sent.failure) ? "unknown" : "failed";
  log({
    code: state === "unknown" ? "telegram_delivery_unknown" : "telegram_run_delivery_failed", httpStatus: sent.failure.status,
    outcome: "failed", runId: input.runId
  });
  await settle(state);
  return { answer, bot, messageIds: sent.messageIds, state };
}
