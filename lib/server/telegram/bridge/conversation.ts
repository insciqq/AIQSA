import { RUN_FOLLOWUP_MAX_CHARS } from "../../../contracts/runFollowups";
import type { ContentBlock } from "../../../domain/content";
import { logEvent, runInBackground, runWithContext } from "../../observability";
import { databaseFailureCode } from "../../observability/databaseFailure";
import type { TelegramMessage } from "../botApi";
import { TELEGRAM_BRIDGE_COPY, TELEGRAM_COPY, telegramReasonText } from "../copy";
import type { TelegramBotSession } from "../dispatcher";
import type { TelegramKeyboard } from "../outbound";
import type { TelegramLinkPreferences, TelegramLinkRecord, TelegramLinkStore } from "../store/links";
import type { TelegramMessageRefStore } from "../store/messageRefs";
import type { TelegramRunLinkStore } from "../store/runLinks";
import type { TelegramAdmitted, TelegramChatTarget, TelegramSendMessage } from "./admission";
import type { TelegramSystemTurn } from "./body";
import type { TelegramRunGateway } from "./gateway";
import { telegramRefusalReply, type TelegramSendRefusal } from "./refusals";
import type { TelegramRunObservation } from "./runObserver";

/**
 * One controller per linked Telegram chat, so the chat's lane in the
 * dispatcher is never held by a model run:
 * - consecutive messages within 1.5 s merge into one request (D-14);
 * - requests, `/new` and chat or assistant choices run strictly in order, one
 *   at a time per link, each reading the link afresh;
 * - routing (D-11): a reply goes to the chat of the message it answers, else
 *   to the link's current chat, else a new chat (with the chosen assistant);
 * - while a Telegram run is active, text for its chat becomes a follow-up
 *   (nonce `tg-<updateId>`); what the run no longer accepts, and anything for
 *   another chat, waits until the run settled (bounded) and then runs;
 * - Stop (`/stop`, the draft's own Stop, a Stop button) stops the active run.
 */

export const TELEGRAM_MERGE_WINDOW_MS = 1_500;
export const TELEGRAM_MERGE_MAX_MESSAGES = 20;
/** A merge never holds a request longer than this, however fast messages keep coming. */
export const TELEGRAM_MERGE_MAX_SPAN_MS = 15_000;
/** Requests and routing changes waiting per link; more are answered as busy. */
export const TELEGRAM_LINK_QUEUE_LIMIT = 20;
/** A request waits for the active run at most this long, then runs anyway. */
export const TELEGRAM_RUN_WAIT_MS = 2 * 3_600_000;
/** A message older than this (Telegram's `date`) arrived after downtime and is not run. */
export const TELEGRAM_STALE_MESSAGE_MS = 10 * 60_000;

export type TelegramMessageSource = Readonly<{
  bot: TelegramBotSession;
  link: TelegramLinkRecord;
  message: TelegramMessage;
  updateId: number;
}>;

/**
 * One message's content in the merge window: its blocks, or blocks a media
 * handler is still preparing (a download, upload or transcription). A part
 * that was refused resolves to nothing; its handler already said why.
 */
export type TelegramQueuedContent = readonly ContentBlock[] | Promise<readonly ContentBlock[]>;

type Batch = {
  bot: TelegramBotSession;
  telegramChatId: number;
  parts: TelegramQueuedContent[];
  firstMessageId: number;
  firstUpdateId: number;
  replyTo: number | null;
  startedAt: number;
};

/** What one admission sends: merged message content, or a request the server prepared. */
type Request = Readonly<{
  bot: TelegramBotSession;
  blocks: readonly ContentBlock[];
  /** The Telegram message a refusal answers; null for a request no message asked for. */
  replyTo: number | null;
  systemTurn?: TelegramSystemTurn;
  updateId: number;
}>;

/** A request the server prepared for a chat, such as the continuation after an MCP approval. */
export type TelegramSubmission = Readonly<{
  chatId: string;
  contentBlocks: readonly ContentBlock[];
  systemTurn?: TelegramSystemTurn;
  /** The update that asked for it (the approval's press); it names the admission. */
  updateId: number;
}>;

type ActiveRun = Readonly<{
  runId: string;
  chatId: string;
  assistantMessageId: string | null;
  draftId: number;
  /** Resolves once the run's final message was handled, or the wait bound passed. */
  settled: Promise<void>;
}>;

type Slot = {
  linkId: string;
  userId: string;
  buffer: Batch | null;
  timer: ReturnType<typeof setTimeout> | null;
  chain: Promise<void>;
  queued: number;
  active: ActiveRun | null;
  admitting: { stopRequested: boolean } | null;
};

export type TelegramConversation = Readonly<{
  /**
   * Adds a message's content (its text, or blocks a media handler prepares) to the merge window. The
   * window closes as usual; the request waits until every pending part settled, in the link's order.
   */
  queue(source: TelegramMessageSource, content: TelegramQueuedContent): void;
  /** Runs a routing change after everything queued before it (`/new`, a chat or assistant choice). */
  enqueue(link: TelegramLinkRecord, bot: TelegramBotSession, job: (link: TelegramLinkRecord) => Promise<void>): void;
  /**
   * Runs a request the server prepared in order with the link's messages: once the active run
   * settled, it is admitted in its chat, streamed and delivered like a message.
   */
  submit(link: TelegramLinkRecord, bot: TelegramBotSession, submission: TelegramSubmission): void;
  /** `/stop`: the link's active run, or the one being admitted. */
  stop(link: TelegramLinkRecord, bot: TelegramBotSession): Promise<void>;
  /** The draft's own Stop (`stopped_message_generation`). */
  stopDraft(link: TelegramLinkRecord, draftId: number): void;
  /** A Stop button naming a run, honoured only for this link's runs. */
  stopRun(link: TelegramLinkRecord, runId: string): Promise<boolean>;
  /** Whether this process follows the run. */
  isLive(runId: string): boolean;
  /** Sends what waits in merge windows now (shutdown and tests). */
  flush(): void;
  /** Resolves when nothing waits or runs (tests). */
  idle(): Promise<void>;
}>;

export type TelegramConversationDeps = Readonly<{
  admit: TelegramSendMessage;
  observe(observation: TelegramRunObservation): Promise<void>;
  gateway: Pick<TelegramRunGateway, "activeRun" | "findChat" | "followup" | "stop">;
  links: Pick<TelegramLinkStore, "findByUserId" | "updatePreferences">;
  messageRefs: Pick<TelegramMessageRefStore, "find">;
  runLinks: Pick<TelegramRunLinkStore, "find">;
  now?: () => number;
  mergeWindowMs?: number;
  runWaitMs?: number;
}>;

/** Content-free: stable codes, statuses and run identity only. */
function log(fields: Readonly<{
  code: string; error?: unknown; httpStatus?: number; outcome: "completed" | "failed" | "skipped"; runId?: string;
}>): void {
  logEvent("service_operation", {
    code: fields.code, ...(fields.error ? { error: fields.error, prisma_code: databaseFailureCode(fields.error) } : {}),
    ...(fields.httpStatus ? { httpStatus: fields.httpStatus } : {}), outcome: fields.outcome,
    ...(fields.runId ? { run_id: fields.runId } : {}), stage: "dispatch", subsystem: "telegram"
  });
}

/** Text parts of consecutive messages join with a line break; attachments keep their place. */
export function mergeTelegramContent(parts: readonly (readonly ContentBlock[])[]): ContentBlock[] {
  const merged: ContentBlock[] = [];
  for (const block of parts.flat()) {
    const previous = merged.at(-1);
    if (block.type === "text" && previous?.type === "text") merged[merged.length - 1] = { text: `${previous.text}\n${block.text}`, type: "text" };
    else merged.push({ ...block });
  }
  return merged;
}

/** A message Telegram kept while the bot was off: older than the cutoff by its own `date`. */
export function isStaleTelegramMessage(message: Pick<TelegramMessage, "date">, now: number): boolean {
  return now - message.date * 1_000 > TELEGRAM_STALE_MESSAGE_MS;
}

export function createTelegramConversation(deps: TelegramConversationDeps): TelegramConversation {
  const now = deps.now ?? Date.now;
  const mergeWindowMs = deps.mergeWindowMs ?? TELEGRAM_MERGE_WINDOW_MS;
  const runWaitMs = deps.runWaitMs ?? TELEGRAM_RUN_WAIT_MS;
  const slots = new Map<string, Slot>();
  /** Runs whose observer in this process has not finished, whether or not their link still waits for them. */
  const observing = new Set<string>();

  function slotFor(link: TelegramLinkRecord): Slot {
    let slot = slots.get(link.id);
    if (!slot) {
      slot = { active: null, admitting: null, buffer: null, chain: Promise.resolve(), linkId: link.id, queued: 0, timer: null, userId: link.userId };
      slots.set(link.id, slot);
    }
    return slot;
  }

  function evictIfIdle(slot: Slot): void {
    if (!slot.buffer && !slot.timer && slot.queued === 0 && !slot.active && !slot.admitting && slots.get(slot.linkId) === slot) {
      slots.delete(slot.linkId);
    }
  }

  async function say(bot: TelegramBotSession, chatId: number, text: string, extra: Readonly<{
    chatId?: string; keyboard?: TelegramKeyboard; linkId?: string; openInAiqsa?: boolean; replyTo?: number; userId?: string;
  }> = {}): Promise<void> {
    try {
      await bot.outbound.sendText({
        chatId, text,
        ...(extra.keyboard ? { keyboard: extra.keyboard, linkId: extra.linkId } : {}),
        ...(extra.replyTo ? { replyTo: extra.replyTo } : {}),
        ...(extra.chatId && extra.linkId && extra.userId
          ? { openInAiqsa: extra.openInAiqsa === true, owner: { chatId: extra.chatId, linkId: extra.linkId, userId: extra.userId } }
          : {})
      });
    } catch (error) {
      log({ code: "telegram_notice_failed", error, outcome: "failed" });
    }
  }

  function enqueueJob(slot: Slot, bot: TelegramBotSession, telegramChatId: number, job: () => Promise<void>): void {
    if (slot.queued >= TELEGRAM_LINK_QUEUE_LIMIT) {
      log({ code: "telegram_busy", outcome: "skipped" });
      void say(bot, telegramChatId, telegramReasonText("telegram_busy")!);
      return;
    }
    slot.queued += 1;
    slot.chain = slot.chain
      .then(() => runInBackground(() => runWithContext({ user_id: slot.userId }, job)))
      .catch((error: unknown) => log({ code: "telegram_update_failed", error, outcome: "failed" }))
      .finally(() => {
        slot.queued -= 1;
        evictIfIdle(slot);
      });
  }

  function flushSlot(slot: Slot): void {
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
    const batch = slot.buffer;
    slot.buffer = null;
    if (batch) enqueueJob(slot, batch.bot, batch.telegramChatId, () => runBatch(slot, batch));
  }

  async function currentLink(slot: Slot): Promise<TelegramLinkRecord | null> {
    const link = await deps.links.findByUserId(slot.userId);
    return link && link.id === slot.linkId ? link : null;
  }

  async function updateLink(link: TelegramLinkRecord, preferences: TelegramLinkPreferences): Promise<void> {
    try {
      await deps.links.updatePreferences(link.id, preferences);
    } catch (error) {
      log({ code: "telegram_update_failed", error, outcome: "failed" });
    }
  }

  type Route = Readonly<{ target: TelegramChatTarget; notice: string | null }>;

  async function route(link: TelegramLinkRecord, batch: Batch): Promise<Route> {
    let replyGone = false;
    if (batch.replyTo !== null) {
      const ref = await deps.messageRefs.find({ botId: link.botId, telegramChatId: link.telegramChatId, telegramMessageId: batch.replyTo });
      if (ref && ref.userId === link.userId && ref.linkId === link.id) {
        const chat = await deps.gateway.findChat(link.userId, ref.chatId);
        if (chat) return { notice: null, target: { chatId: chat.id, kind: "existing" } };
        replyGone = true;
      }
    }
    if (link.currentChatId) {
      const chat = await deps.gateway.findChat(link.userId, link.currentChatId);
      if (chat) return { notice: replyGone ? TELEGRAM_BRIDGE_COPY.replyChatUnavailable : null, target: { chatId: chat.id, kind: "existing" } };
      return { notice: TELEGRAM_BRIDGE_COPY.currentChatUnavailable, target: { assistantId: link.pendingAssistantId, kind: "new" } };
    }
    return {
      notice: replyGone ? TELEGRAM_BRIDGE_COPY.chatUnavailable : null, target: { assistantId: link.pendingAssistantId, kind: "new" }
    };
  }

  /** The batch's merged content once every pending part settled; refused parts add nothing. */
  async function batchContent(batch: Batch): Promise<ContentBlock[]> {
    const parts = await Promise.all(batch.parts.map((part) => Promise.resolve(part).catch((error: unknown) => {
      log({ code: "telegram_update_failed", error, outcome: "failed" });
      return [];
    })));
    return mergeTelegramContent(parts);
  }

  function batchText(blocks: readonly ContentBlock[]): string | null {
    return blocks.length === 1 && blocks[0]!.type === "text" ? blocks[0]!.text.trim() : null;
  }

  /** Adds text to the active run; false when the run no longer takes it and it must run on its own. */
  async function followUp(link: TelegramLinkRecord, batch: Batch, blocks: readonly ContentBlock[], active: ActiveRun): Promise<boolean> {
    const text = batchText(blocks);
    if (!text || text.length > RUN_FOLLOWUP_MAX_CHARS || !active.assistantMessageId) return false;
    const input = {
      assistantMessageId: active.assistantMessageId, chatId: active.chatId, nonce: `tg-${batch.firstUpdateId}`, runId: active.runId, text,
      userId: link.userId
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await deps.gateway.followup(input);
      if (response.ok) {
        await say(batch.bot, link.telegramChatId, TELEGRAM_COPY.followupAdded, {
          chatId: active.chatId, linkId: link.id, replyTo: batch.firstMessageId, userId: link.userId
        });
        return true;
      }
      // An unconfirmed acceptance is asked about once more under the same nonce; a refusal is final.
      if (response.status !== 503) {
        log({ code: "telegram_followup_failed", httpStatus: response.status, outcome: "skipped", runId: active.runId });
        return false;
      }
    }
    log({ code: "telegram_followup_failed", httpStatus: 503, outcome: "failed", runId: active.runId });
    return false;
  }

  async function waitFor(slot: Slot, active: ActiveRun): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      active.settled,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, runWaitMs);
        timer.unref?.();
      })
    ]);
    clearTimeout(timer);
    // Past the bound the link stops waiting; the run's own delivery still follows it.
    if (slot.active === active) slot.active = null;
  }

  async function refuse(link: TelegramLinkRecord, request: Request, target: TelegramChatTarget, refusal: TelegramSendRefusal): Promise<void> {
    log({ code: "telegram_run_refused", httpStatus: refusal.status, outcome: "skipped" });
    const reply = telegramRefusalReply(refusal);
    const chatId = target.kind === "existing" ? target.chatId : null;
    if (reply.chatGone && chatId && link.currentChatId === chatId) await updateLink(link, { currentChatId: null });
    const keyboard: TelegramKeyboard | undefined = reply.action === "model"
      ? [[{ callback: { kind: "model_page", payload: { page: 0 } }, text: TELEGRAM_BRIDGE_COPY.chooseModel }]]
      : reply.action === "settings" ? [[{ callback: { kind: "open_settings" }, text: TELEGRAM_COPY.openSettings }]] : undefined;
    await say(request.bot, link.telegramChatId, reply.text, {
      ...(keyboard ? { keyboard } : {}), linkId: link.id, ...(request.replyTo === null ? {} : { replyTo: request.replyTo }),
      ...(reply.action === "open" && chatId && !reply.chatGone ? { chatId, openInAiqsa: true, userId: link.userId } : {})
    });
  }

  async function admit(slot: Slot, link: TelegramLinkRecord, request: Request, target: TelegramChatTarget): Promise<void> {
    const admitting = { stopRequested: false };
    slot.admitting = admitting;
    let admission;
    try {
      admission = await deps.admit({
        chatTarget: target, contentBlocks: request.blocks, link, ...(request.systemTurn ? { systemTurn: request.systemTurn } : {}),
        updateId: request.updateId
      });
    } catch (error) {
      log({ code: "telegram_run_admission_failed", error, outcome: "failed" });
      await refuse(link, request, target, { code: "internal_error", status: 500 });
      return;
    } finally {
      slot.admitting = null;
    }
    if (admission.kind === "refused") {
      await refuse(link, request, target, admission.refusal);
      return;
    }
    const preferences: TelegramLinkPreferences = {
      ...(link.currentChatId === admission.chatId ? {} : { currentChatId: admission.chatId }),
      ...(target.kind === "new" && target.assistantId ? { pendingAssistantId: null } : {})
    };
    if (Object.keys(preferences).length > 0) await updateLink(link, preferences);
    start(slot, link, request.bot, admission);
    if (admitting.stopRequested) await stopActive(slot, link);
  }

  function start(slot: Slot, link: TelegramLinkRecord, bot: TelegramBotSession, admission: TelegramAdmitted): void {
    let settle: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    const active: ActiveRun = {
      assistantMessageId: admission.assistantMessageId, chatId: admission.chatId, draftId: admission.draftId, runId: admission.runId, settled
    };
    slot.active = active;
    observing.add(admission.runId);
    void runInBackground(() => runWithContext({ run_id: admission.runId, user_id: link.userId }, () => deps.observe({ admission, bot, link })))
      .catch((error: unknown) => log({ code: "telegram_run_delivery_failed", error, outcome: "failed", runId: admission.runId }))
      .finally(() => {
        observing.delete(admission.runId);
        if (slot.active === active) slot.active = null;
        settle();
        evictIfIdle(slot);
      });
  }

  async function runBatch(slot: Slot, batch: Batch): Promise<void> {
    const blocks = await batchContent(batch);
    if (blocks.length === 0) return;
    for (let round = 0; round < 3; round += 1) {
      const link = await currentLink(slot);
      if (!link) return;
      const { notice, target } = await route(link, batch);
      const active = slot.active;
      if (active) {
        if (target.kind === "existing" && target.chatId === active.chatId && await followUp(link, batch, blocks, active)) return;
        await waitFor(slot, active);
        continue;
      }
      if (notice) await say(batch.bot, link.telegramChatId, notice);
      await admit(slot, link, { blocks, bot: batch.bot, replyTo: batch.firstMessageId, updateId: batch.firstUpdateId }, target);
      return;
    }
  }

  function stopInBackground(userId: string, runId: string): void {
    void runInBackground(() => deps.gateway.stop({ runId, userId }))
      .then((outcome) => {
        // Already settled or gone: nothing was left to stop.
        if (outcome !== "stopped") log({ code: "telegram_run_stop_failed", outcome: "skipped", runId });
      })
      .catch((error: unknown) => log({ code: "telegram_run_stop_failed", error, outcome: "failed", runId }));
  }

  async function stopActive(slot: Slot, link: TelegramLinkRecord): Promise<boolean> {
    if (slot.active) {
      stopInBackground(link.userId, slot.active.runId);
      return true;
    }
    if (slot.admitting) {
      slot.admitting.stopRequested = true;
      return true;
    }
    // A run of this link this process no longer follows (started before a restart) in its current chat.
    if (!link.currentChatId) return false;
    const active = await deps.gateway.activeRun({ chatId: link.currentChatId, userId: link.userId });
    if (!active || (await deps.runLinks.find(active.runId))?.linkId !== link.id) return false;
    stopInBackground(link.userId, active.runId);
    return true;
  }

  const conversation: TelegramConversation = Object.freeze({
    queue(source: TelegramMessageSource, content: TelegramQueuedContent) {
      const slot = slotFor(source.link);
      const replyTo = source.message.reply_to_message?.message_id ?? null;
      const buffered = slot.buffer;
      if (buffered && ((replyTo !== null && replyTo !== buffered.replyTo) || buffered.parts.length >= TELEGRAM_MERGE_MAX_MESSAGES ||
        now() - buffered.startedAt >= TELEGRAM_MERGE_MAX_SPAN_MS)) flushSlot(slot);
      slot.buffer ??= {
        bot: source.bot, firstMessageId: source.message.message_id, firstUpdateId: source.updateId, parts: [], replyTo, startedAt: now(),
        telegramChatId: source.link.telegramChatId
      };
      if ("then" in content) {
        // Settled (and a failure logged) when the request runs; never an unhandled rejection meanwhile.
        void content.catch(() => undefined);
        slot.buffer.parts.push(content);
      } else {
        slot.buffer.parts.push([...content]);
      }
      if (slot.timer) clearTimeout(slot.timer);
      slot.timer = setTimeout(() => flushSlot(slot), mergeWindowMs);
      slot.timer.unref?.();
    },

    enqueue(link, bot, job) {
      const slot = slotFor(link);
      // Whatever was sent before the change goes first, in its old routing.
      flushSlot(slot);
      enqueueJob(slot, bot, link.telegramChatId, async () => {
        const current = await currentLink(slot);
        if (current) await job(current);
      });
    },

    submit(link, bot, submission) {
      const slot = slotFor(link);
      flushSlot(slot);
      enqueueJob(slot, bot, link.telegramChatId, async () => {
        for (let round = 0; round < 2; round += 1) {
          const current = await currentLink(slot);
          if (!current) return;
          const active = slot.active;
          if (active) {
            await waitFor(slot, active);
            continue;
          }
          await admit(slot, current, {
            blocks: submission.contentBlocks, bot, replyTo: null, ...(submission.systemTurn ? { systemTurn: submission.systemTurn } : {}),
            updateId: submission.updateId
          }, { chatId: submission.chatId, kind: "existing" });
          return;
        }
      });
    },

    async stop(link, bot) {
      const slot = slotFor(link);
      const stopped = await stopActive(slot, link);
      if (!stopped) await say(bot, link.telegramChatId, TELEGRAM_BRIDGE_COPY.nothingRunning);
      evictIfIdle(slot);
    },

    stopDraft(link, draftId) {
      const slot = slots.get(link.id);
      if (slot?.active?.draftId === draftId) stopInBackground(link.userId, slot.active.runId);
    },

    async stopRun(link, runId) {
      const owned = (await deps.runLinks.find(runId))?.linkId === link.id;
      if (owned) stopInBackground(link.userId, runId);
      return owned;
    },

    isLive(runId) {
      return observing.has(runId);
    },

    flush() {
      for (const slot of [...slots.values()]) flushSlot(slot);
    },

    async idle() {
      for (;;) {
        const busy = [...slots.values()].filter((slot) => slot.queued > 0 || slot.active);
        if (busy.length === 0) return;
        await Promise.allSettled(busy.flatMap((slot) => [slot.chain, ...(slot.active ? [slot.active.settled] : [])]));
      }
    }
  });
  return conversation;
}
