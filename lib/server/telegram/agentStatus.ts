import { decodeThreadWorkspaceActivityEntry, type ThreadWorkspaceActivityEntry } from "../../contracts/workspace";
import { isWorkspaceActivityActive, mergeWorkspaceActivityEntry } from "../../domain/workspaceActivity";
import { logEvent, runInBackground } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import type { TelegramInlineKeyboardMarkup, TelegramSentMessage } from "./botApi";
import {
  onTelegramRunEvent, type TelegramRunDeliveredEvent, type TelegramRunEventContext, type TelegramRunListener
} from "./bridge/events";
import { telegramFailureCode } from "./codes";
import type { TelegramAccessResolver } from "./control/access";
import { reachTelegramChat } from "./control/reach";
import type { TelegramSessionProvider } from "./control/session";
import {
  TELEGRAM_COPY, telegramAgentFinishedText, telegramAgentWorkingText, telegramWorkActivityText, telegramWorkFailedText,
  telegramWorkspaceWorkingText
} from "./copy";
import type { TelegramBotSession } from "./dispatcher";
import type { TelegramMessageRefStore } from "./store/messageRefs";
import type { TelegramRunLinkStore } from "./store/runLinks";
import type { TelegramFailure, TelegramOutcome } from "./transport";

/**
 * The status of a Telegram run that works in Workspace, with or without
 * Agent (D-16): one message per run from its first Workspace activity, "Agent
 * is working · 3 min — <activity>" (or "Working in Workspace · …") with a
 * Stop button, edited at most every 5 s and only when its text changed (a
 * newer activity, another minute), and finally "Finished in N min", "Stopped"
 * or the failure, without the button. The answer itself is the bridge's
 * separate message. The message is recorded on the run's link, so a restart's
 * recovery still ends it. Activity comes already redacted and bounded by the
 * run's own projection; logs carry ids and codes only. Every send and edit
 * first checks that the run's link still reaches its chat (D-04); once it does
 * not, the status stops for good while the run goes on in AIQSA.
 */

export const TELEGRAM_STATUS_EDIT_INTERVAL_MS = 5_000;
/** How often a status looks again without new activity, so its minutes go on. */
export const TELEGRAM_STATUS_TICK_MS = 15_000;
/** A run followed this long stops its status, as the bridge stops following it. */
export const TELEGRAM_STATUS_MAX_AGE_MS = 6 * 3_600_000;
const ENTRIES_KEPT = 64;
const RUNS_KEPT = 500;

/** Every code this module logs besides Telegram's transport codes. */
export const TELEGRAM_STATUS_LOG_CODES = ["telegram_status_failed"] as const;

export type TelegramWorkMode = "agent" | "workspace";
export type TelegramWorkEnding = TelegramRunDeliveredEvent["status"];

export type TelegramAgentStatusDeps = Readonly<{
  access: Pick<TelegramAccessResolver, "resolveTelegramAccess">;
  sessions: TelegramSessionProvider;
  runLinks: Pick<TelegramRunLinkStore, "find" | "setStatusMessage">;
  messageRefs: Pick<TelegramMessageRefStore, "record">;
  /** Whether the run was admitted with Agent or with Workspace alone. */
  runMode(input: Readonly<{ runId: string; userId: string }>): Promise<TelegramWorkMode>;
  now?: () => number;
}>;

export type TelegramAgentStatus = Readonly<{
  listener: TelegramRunListener;
  /** Resolves when no status message is being sent or edited (tests). */
  idle(): Promise<void>;
  /** Stops every status's timers (the services are rebuilt). */
  dispose(): void;
}>;

type RunStatus = {
  readonly context: TelegramRunEventContext;
  readonly entries: Map<string, ThreadWorkspaceActivityEntry>;
  mode: TelegramWorkMode;
  startedAt: number;
  activity: string | null;
  messageId: number | null;
  markup: TelegramInlineKeyboardMarkup | undefined;
  shown: string | null;
  lastEditAt: number;
  /** The message can no longer be edited (deleted, or never sent). */
  broken: boolean;
  ending: TelegramWorkEnding | null;
  timer: ReturnType<typeof setTimeout> | null;
  ticker: ReturnType<typeof setInterval> | null;
  chain: Promise<void>;
};

/** Content-free: run identity, codes and HTTP status. */
function log(fields: Readonly<{
  code: string; error?: unknown; httpStatus?: number; outcome: "degraded" | "failed" | "skipped"; runId: string;
}>): void {
  logEvent("service_operation", {
    code: fields.code, ...(fields.error ? { error: fields.error, prisma_code: databaseFailureCode(fields.error) } : {}),
    ...(fields.httpStatus ? { httpStatus: fields.httpStatus } : {}), outcome: fields.outcome, run_id: fields.runId, stage: "dispatch",
    subsystem: "telegram"
  });
}

function logFailure(failure: TelegramFailure, runId: string): void {
  log({ code: telegramFailureCode(failure.kind, failure.errorCode), httpStatus: failure.status, outcome: "failed", runId });
}

function unchanged(failure: TelegramFailure): boolean {
  return failure.kind === "telegram" && failure.errorCode === 400 && /not modified/iu.test(failure.description ?? "");
}

async function once<T>(send: () => Promise<TelegramOutcome<T>>): Promise<TelegramOutcome<T>> {
  const first = await send();
  // Only a send whose bytes never reached Telegram is safe to repeat.
  return first.ok || first.kind !== "network_before_send" ? first : send();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What a status names: the newest step still running, else the newest step worth naming. */
export function telegramWorkActivity(entries: readonly ThreadWorkspaceActivityEntry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.kind !== "plan" && isWorkspaceActivityActive(entry)) {
      const text = telegramWorkActivityText(entry);
      if (text) return text;
    }
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const text = telegramWorkActivityText(entries[index]!);
    if (text) return text;
  }
  return null;
}

export function telegramWorkStatusText(input: Readonly<{ mode: TelegramWorkMode; elapsedMs: number; activity: string | null }>): string {
  const activity = input.activity ?? undefined;
  return input.mode === "agent" ? telegramAgentWorkingText(input.elapsedMs, activity) : telegramWorkspaceWorkingText(input.elapsedMs, activity);
}

export function telegramWorkEndingText(ending: TelegramWorkEnding, elapsedMs: number): string {
  return ending === "complete" ? telegramAgentFinishedText(elapsedMs) : ending === "cancelled" ? TELEGRAM_COPY.stopped
    : telegramWorkFailedText(elapsedMs);
}

/** Whether the run was admitted with Agent, from its frozen request. */
export async function telegramRunWorkMode(input: Readonly<{ runId: string; userId: string }>): Promise<TelegramWorkMode> {
  const { prisma } = await import("../prisma");
  const run = await prisma.modelRun.findFirst({ select: { normalizedRequest: true }, where: { id: input.runId, userId: input.userId } });
  const request = run?.normalizedRequest;
  return isRecord(request) && isRecord(request.agent) ? "agent" : "workspace";
}

export function createTelegramAgentStatus(deps: TelegramAgentStatusDeps): TelegramAgentStatus {
  const now = deps.now ?? Date.now;
  const runs = new Map<string, RunStatus>();
  /** Runs whose status ended: one status message per run, however late an event comes. */
  const ended = new Set<string>();
  const pending = new Set<Promise<void>>();

  function track(work: Promise<void>): void {
    pending.add(work);
    void work.finally(() => pending.delete(work));
  }

  function queue(status: RunStatus, job: () => Promise<void>): void {
    status.chain = status.chain.then(() => runInBackground(job)).catch((error: unknown) => {
      log({ code: "telegram_status_failed", error, outcome: "failed", runId: status.context.runId });
    });
    track(status.chain);
  }

  function stopTimers(status: RunStatus): void {
    if (status.timer) clearTimeout(status.timer);
    if (status.ticker) clearInterval(status.ticker);
    status.timer = null;
    status.ticker = null;
  }

  function forget(status: RunStatus): void {
    stopTimers(status);
    if (runs.get(status.context.runId) === status) runs.delete(status.context.runId);
  }

  function endedRun(runId: string): void {
    ended.add(runId);
    while (ended.size > RUNS_KEPT) ended.delete(ended.values().next().value as string);
  }

  /** The bot the run's chat is reached through now, or null when its link no longer reaches it. */
  async function reachRun(context: TelegramRunEventContext): Promise<TelegramBotSession | null> {
    const reached = await reachTelegramChat(deps, {
      botId: context.bot.botId, linkId: context.linkId, telegramChatId: context.telegramChatId, userId: context.userId
    });
    if (reached.ok) return reached.bot;
    log({ code: reached.reasonCode, outcome: "skipped", runId: context.runId });
    return null;
  }

  /** Checked right before every send and edit: once the chat may no longer receive the run, the status stops for good. */
  async function reach(status: RunStatus): Promise<TelegramBotSession | null> {
    const bot = await reachRun(status.context);
    if (bot) return bot;
    status.broken = true;
    endedRun(status.context.runId);
    forget(status);
    return null;
  }

  function working(status: RunStatus): string {
    return telegramWorkStatusText({ activity: status.activity, elapsedMs: now() - status.startedAt, mode: status.mode });
  }

  async function edit(
    status: RunStatus, bot: TelegramBotSession, text: string, markup: TelegramInlineKeyboardMarkup | undefined
  ): Promise<boolean> {
    const { context } = status;
    const edited = await bot.api.editMessageText({
      chat_id: context.telegramChatId, link_preview_options: { is_disabled: true }, message_id: status.messageId!, text,
      ...(markup ? { reply_markup: markup } : {})
    });
    if (edited.ok || unchanged(edited)) return true;
    logFailure(edited, context.runId);
    // Telegram refuses to edit it at all (deleted, too old): the status stops here.
    if (edited.kind === "telegram" && edited.errorCode === 400) status.broken = true;
    return false;
  }

  async function remember(status: RunStatus, sent: TelegramSentMessage): Promise<void> {
    const { context } = status;
    try {
      // A reply to the status continues the run's chat, like a reply to its answer.
      await deps.messageRefs.record([{
        botId: context.bot.botId, chatId: context.chatId, linkId: context.linkId, telegramChatId: context.telegramChatId,
        telegramMessageId: sent.message_id, userId: context.userId
      }], new Date(now()));
      await deps.runLinks.setStatusMessage({ runId: context.runId, statusMessageId: sent.message_id });
    } catch (error) {
      log({ code: "telegram_status_failed", error, outcome: "degraded", runId: context.runId });
    }
  }

  /** Sends the run's one status message: working with Stop, or already how the run ended. */
  async function open(status: RunStatus): Promise<void> {
    const { context } = status;
    const [mode, link] = await Promise.all([
      deps.runMode({ runId: context.runId, userId: context.userId }).catch((error: unknown) => {
        log({ code: "telegram_status_failed", error, outcome: "degraded", runId: context.runId });
        return "workspace" as const;
      }),
      deps.runLinks.find(context.runId).catch(() => null)
    ]);
    status.mode = mode;
    // The run started when its link was recorded, before its first activity.
    if (link) status.startedAt = Math.min(status.startedAt, link.createdAt.getTime());
    const bot = await reach(status);
    if (!bot) return;
    const ending = status.ending;
    const text = ending ? telegramWorkEndingText(ending, now() - status.startedAt) : working(status);
    const markup = ending ? undefined : await bot.outbound.replyMarkup({
      keyboard: [[{ callback: { kind: "stop_run", payload: { runId: context.runId } }, text: TELEGRAM_COPY.stop }]], linkId: context.linkId
    });
    const sent = await once(() => bot.api.sendMessage({
      chat_id: context.telegramChatId, link_preview_options: { is_disabled: true }, text, ...(markup ? { reply_markup: markup } : {})
    }));
    if (!sent.ok) {
      logFailure(sent, context.runId);
      status.broken = true;
      return;
    }
    status.messageId = sent.result.message_id;
    status.markup = markup;
    status.shown = text;
    status.lastEditAt = now();
    await remember(status, sent.result);
    if (status.ending) return;
    status.ticker = setInterval(() => {
      if (now() - status.startedAt > TELEGRAM_STATUS_MAX_AGE_MS) forget(status);
      else schedule(status);
    }, TELEGRAM_STATUS_TICK_MS);
    status.ticker.unref?.();
    schedule(status);
  }

  /** Plans the next edit: not before 5 s after the last one, and only for a changed text. */
  function schedule(status: RunStatus): void {
    if (status.ending || status.broken || status.messageId === null || status.timer) return;
    if (working(status) === status.shown) return;
    status.timer = setTimeout(() => {
      status.timer = null;
      queue(status, () => update(status));
    }, Math.max(0, status.lastEditAt + TELEGRAM_STATUS_EDIT_INTERVAL_MS - now()));
    status.timer.unref?.();
  }

  async function update(status: RunStatus): Promise<void> {
    if (status.ending || status.broken || status.messageId === null) return;
    const text = working(status);
    if (text === status.shown) return;
    const bot = await reach(status);
    // Ended while its chat was checked: the closing edit follows instead.
    if (!bot || status.ending) return;
    status.lastEditAt = now();
    if (await edit(status, bot, text, status.markup)) status.shown = text;
  }

  /** The last edit: how the run ended, without Stop. */
  async function close(status: RunStatus): Promise<void> {
    if (status.messageId === null || status.broken || !status.ending) return;
    const text = telegramWorkEndingText(status.ending, now() - status.startedAt);
    if (text === status.shown) return;
    const bot = await reach(status);
    if (bot && await edit(status, bot, text, undefined)) status.shown = text;
  }

  function activity(raw: unknown, context: TelegramRunEventContext): void {
    const entry = decodeThreadWorkspaceActivityEntry(raw);
    if (!entry || ended.has(context.runId)) return;
    let status = runs.get(context.runId);
    if (!status) {
      status = {
        activity: null, broken: false, chain: Promise.resolve(), context, ending: null, entries: new Map(), lastEditAt: 0,
        markup: undefined, messageId: null, mode: "workspace", shown: null, startedAt: now(), ticker: null, timer: null
      };
      runs.set(context.runId, status);
      while (runs.size > RUNS_KEPT) forget(runs.values().next().value as RunStatus);
      const opened = status;
      queue(opened, () => open(opened));
    }
    if (status.ending) return;
    const merged = mergeWorkspaceActivityEntry(status.entries.get(entry.id), entry);
    // Newest change last: a step that just finished is newer than one started before it.
    status.entries.delete(entry.id);
    status.entries.set(entry.id, merged);
    while (status.entries.size > ENTRIES_KEPT) status.entries.delete(status.entries.keys().next().value as string);
    status.activity = telegramWorkActivity([...status.entries.values()]);
    schedule(status);
  }

  function finish(runId: string, ending: TelegramWorkEnding): void {
    const status = runs.get(runId);
    if (!status || status.ending) return;
    endedRun(runId);
    status.ending = ending;
    stopTimers(status);
    queue(status, () => close(status));
    void status.chain.finally(() => forget(status));
  }

  /** After a restart: the status a previous process left working ends as the delivered run did. */
  function recover(event: TelegramRunDeliveredEvent, context: TelegramRunEventContext): void {
    if (context.source !== "recovery" || runs.has(context.runId)) return;
    track(runInBackground(async () => {
      const link = await deps.runLinks.find(context.runId);
      if (!link?.statusMessageId) return;
      const bot = await reachRun(context);
      if (!bot) return;
      const edited = await bot.api.editMessageText({
        chat_id: context.telegramChatId, link_preview_options: { is_disabled: true }, message_id: link.statusMessageId,
        text: telegramWorkEndingText(event.status, now() - link.createdAt.getTime())
      });
      if (!edited.ok && !unchanged(edited)) logFailure(edited, context.runId);
    }).catch((error: unknown) => log({ code: "telegram_status_failed", error, outcome: "failed", runId: context.runId })));
  }

  const listener: TelegramRunListener = (event, context) => {
    switch (event.type) {
      case "workspaceActivity":
        return activity(event.entry, context);
      case "done":
        return finish(context.runId, event.status);
      case "failed":
        return finish(context.runId, "error");
      case "delivered":
        return recover(event, context);
      default:
        return;
    }
  };

  return Object.freeze({
    dispose() {
      for (const status of [...runs.values()]) forget(status);
    },
    async idle() {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
    listener
  });
}

/** Status messages for every Telegram run of this process; returns the function that removes them. */
export function registerTelegramAgentStatus(deps: Readonly<{
  access: Pick<TelegramAccessResolver, "resolveTelegramAccess">;
  sessions: TelegramSessionProvider;
  messageRefs: Pick<TelegramMessageRefStore, "record">;
  runLinks: Pick<TelegramRunLinkStore, "find" | "setStatusMessage">;
  runMode?: TelegramAgentStatusDeps["runMode"];
}>): () => void {
  const status = createTelegramAgentStatus({
    access: deps.access, messageRefs: deps.messageRefs, runLinks: deps.runLinks, runMode: deps.runMode ?? telegramRunWorkMode,
    sessions: deps.sessions
  });
  const unsubscribe = onTelegramRunEvent(status.listener);
  return () => {
    unsubscribe();
    status.dispose();
  };
}
