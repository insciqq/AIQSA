import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { ScheduledTaskRunTrigger, ScheduledTaskUnavailableSource } from "../../contracts/scheduledTasks";
import { summarizeMessageRunArtifacts } from "../chats/prismaRepository";
import { logEvent, runInBackground } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import { prisma } from "../prisma";
import { scheduledTaskOutcomeCopy, scheduledTaskSourceLines } from "../scheduledTasks/notifications";
import type { ScheduledTaskSettledState } from "../scheduledTasks/runnerPolicy";
import { scheduledCopyText } from "../scheduledTasks/runnerStore";
import { unavailableSourcesWire } from "../scheduledTasks/sourceHealth";
import { createS3StorageAdapter, type StorageAdapter } from "../uploads/storage";
import type { TelegramInputRichBlock, TelegramInputRichMessage } from "./botApi";
import { telegramFailureCode } from "./codes";
import type { TelegramAccessRefusal, TelegramAccessResolver } from "./control/access";
import { reachTelegramChat, type TelegramChatBinding } from "./control/reach";
import type { TelegramSessionProvider } from "./control/session";
import { telegramFilesSummaryText, telegramScheduledFilesInAiqsaText, telegramScheduledTitle } from "./copy";
import { getDefaultTelegram } from "./defaultTelegram";
import {
  createPrismaTelegramFileReader, planTelegramFiles, sendTelegramFile, TELEGRAM_FILES_EXPORT_POLL_MS, TELEGRAM_FILES_EXPORT_WAIT_MS,
  telegramAnswerFiles, telegramRunExport, type TelegramAnswerFile, type TelegramPlannedFile
} from "./files";
import type { TelegramDelivery } from "./outbound";
import { plainTelegramMessage, renderTelegramAnswer, type TelegramAnswerCitation, type TelegramAnswerSource } from "./render";
import { packBlocks } from "./render/split";
import type { TelegramMessageRefOwner } from "./store/messageRefs";
import type { TelegramFailure } from "./transport";

/**
 * Scheduled task results in Telegram (D-19). The runner records one durable
 * outbox row per notifying occurrence of a task with Telegram delivery on;
 * this sender delivers it outside the runner's tick: the task title, the
 * outcome and its reason, the result text rendered as explicit blocks (D-10),
 * the run's files (D-16) and an Open in AIQSA button, every message
 * referenced to the run's chat (D-11) so a reply continues it. Before every
 * attempt it rechecks Telegram access (D-04), the task's switch, the chat and
 * the occurrence; the attempt is bound to the user's exact link (link, chat
 * and bot), and every part, a file again after its bytes were read, first
 * checks that this link still reaches the chat, and every message and upload
 * checks again right before it leaves the Bot API (after its pacing or a
 * 429's wait): once it does not, nothing more goes out and the row settles
 * with the access reason. Only a send that provably never reached Telegram
 * (429 or a network failure before sending) is retried, up to five attempts
 * within 30 minutes; an ambiguous one settles `unknown`. Rows are swept at
 * start and once a minute. Logs carry ids and codes, never content.
 */

/** Settled rows record why they were skipped or failed; content-free codes. */
export const TELEGRAM_SCHEDULED_CODES = Object.freeze({
  /** A claimed attempt that never settled (the process ended while sending), or an ambiguous send. */
  unknown: "telegram_delivery_unknown",
  /** The task no longer sends results to Telegram, or is gone. */
  off: "telegram_scheduled_off",
  /** The result's chat or answer is gone or waits for permanent deletion. */
  chatUnavailable: "telegram_scheduled_chat_unavailable",
  /** The occurrence is not a settled result its owner hears about (a hidden check without news). */
  notNews: "telegram_scheduled_not_news"
});
/** Every code this module records or logs besides Telegram's own access and transport codes. */
export const TELEGRAM_SCHEDULED_LOG_CODES = [
  TELEGRAM_SCHEDULED_CODES.chatUnavailable, TELEGRAM_SCHEDULED_CODES.notNews, TELEGRAM_SCHEDULED_CODES.off
] as const;

export const TELEGRAM_SCHEDULED_MAX_ATTEMPTS = 5;
export const TELEGRAM_SCHEDULED_RETRY_WINDOW_MS = 30 * 60_000;
export const TELEGRAM_SCHEDULED_SWEEP_INTERVAL_MS = 60_000;
/** How long a claimed attempt may run before the sweep settles it `unknown`. */
export const TELEGRAM_SCHEDULED_CLAIM_LEASE_MS = 15 * 60_000;
const NETWORK_RETRY_BASE_MS = 30_000;
const NETWORK_RETRY_MAX_MS = 10 * 60_000;
const DEFAULT_CONCURRENCY = 2;
const SWEEP_BATCH = 50;
const SOURCE_LINES = 3;

export type TelegramScheduledDeliveryRow = Readonly<{
  id: string;
  occurrenceId: string;
  userId: string;
  attempts: number;
  nextAttemptAt: Date;
  lastFailureCode: string | null;
  createdAt: Date;
}>;

/** A file of a scheduled result, as every answer's files are sent (`files.ts`). */
export type TelegramScheduledFile = TelegramAnswerFile;

/** What one attempt delivers, read fresh before it. */
export type TelegramScheduledDeliveryContext = Readonly<{
  occurrence: Readonly<{
    reasonCode: string | null;
    /** Null while the occurrence is not settled. */
    state: ScheduledTaskSettledState | null;
    trigger: ScheduledTaskRunTrigger;
    unavailableSources: readonly ScheduledTaskUnavailableSource[];
  }>;
  task: Readonly<{ pauseReason: string | null; telegramNotify: boolean; title: string }>;
  /**
   * The chat a reply continues: the run's chat for a completed result, or the
   * occurrence's (else the task's) chat for a settlement without one. Null
   * when there is none; `usable` is false once it waits for permanent deletion.
   */
  chat: Readonly<{ id: string; usable: boolean }> | null;
  /** A completed run's shown answer; null when it is gone or not the owner's. */
  result: Readonly<{
    messageId: string;
    markdown: string;
    citations: readonly TelegramAnswerCitation[];
    sources: readonly TelegramAnswerSource[];
    files: readonly TelegramScheduledFile[];
    /** The run's Workspace files are still being exported, or their export failed. */
    outputs?: "pending" | "failed";
  }> | null;
}>;

export type TelegramScheduledDeliveryStore = Readonly<{
  /** Records the occurrence's delivery once (`ON CONFLICT DO NOTHING`) when its task sends to Telegram. */
  enqueue(occurrenceId: string, now: Date): Promise<boolean>;
  /** Pending rows due by `now`, oldest first. */
  listDue(now: Date, limit: number): Promise<readonly TelegramScheduledDeliveryRow[]>;
  /** Null when the occurrence or its task is gone. */
  load(row: TelegramScheduledDeliveryRow): Promise<TelegramScheduledDeliveryContext | null>;
  /**
   * Claims the next attempt of a pending row still at `attempts`: one more
   * attempt, due again only at `leaseUntil`, recorded as `unknown` until it
   * settles. True only for the one caller that may send.
   */
  claim(input: Readonly<{ attempts: number; id: string; leaseUntil: Date }>): Promise<boolean>;
  /** Leaves a claimed row pending for a later attempt at `nextAttemptAt`, with the failure's code. */
  release(input: Readonly<{ code: string; id: string; nextAttemptAt: Date }>): Promise<void>;
  /** Settles a pending row; false when it was already settled. */
  settle(input: Readonly<{ at: Date; code: string | null; id: string; state: "sent" | "failed" | "unknown" | "skipped" }>): Promise<boolean>;
  /** The bytes of a ready file the owner may open now (`files.ts` reader), at most `maxBytes`; null when unavailable. */
  readFile(input: Readonly<{ attachmentId: string; maxBytes: number; userId: string }>): Promise<Buffer | null>;
}>;

/** One message (or one file) a delivery sends, in order. */
export type TelegramScheduledPart =
  | Readonly<{ kind: "content"; message: TelegramInputRichMessage; plainFallback: readonly string[]; openInAiqsa: boolean }>
  | Readonly<{ kind: "text"; text: string; openInAiqsa: boolean }>
  | Readonly<{ kind: "file"; item: TelegramPlannedFile }>;
type Part = TelegramScheduledPart;

type Plan = Readonly<{
  /** The exact link, chat and bot the parts go to while that link still reaches the chat. */
  binding: TelegramChatBinding;
  owner: TelegramMessageRefOwner | null; parts: readonly Part[]; outputs?: "pending" | "failed";
}>;

/**
 * A part's outcome; `refused`: the plan's link no longer reaches its chat, and nothing more goes out
 * (`partly`: some of this part's messages went before that).
 */
type PartOutcome = TelegramDelivery | "skipped" | Readonly<{ refused: TelegramAccessRefusal; partly?: boolean }>;

/** Delivery progress kept between attempts of a partly sent result, in this process only. */
type Held = Readonly<{ attempts: number; plan: Plan; progress: number; skipped: number }>;

type Settled = "sent" | "failed" | "unknown" | "skipped";

/** Content-free: the row id, codes, delays and counts. */
function log(fields: Readonly<{
  action?: "retry" | "skip" | "fail" | "wait"; code?: string; count?: number; delay_ms?: number; job_id?: string; prisma_code?: string;
  outcome: "completed" | "degraded" | "failed" | "skipped" | "waiting"; stage: "claim" | "dispatch" | "settle" | "write";
}>): void {
  logEvent("service_operation", { subsystem: "telegram", ...fields });
}

function retryable(failure: TelegramFailure): boolean {
  return failure.kind === "network_before_send" || (failure.kind === "telegram" && failure.errorCode === 429);
}

function ambiguous(failure: TelegramFailure): boolean {
  return failure.kind === "timeout" || failure.kind === "network_after_send";
}

/** The heading lines: title, outcome, reason, unavailable sources and files left in AIQSA. */
function headline(context: TelegramScheduledDeliveryContext, filesLeft: number): Readonly<{ title: string; lines: string[] }> {
  const { occurrence, task } = context;
  const copy = scheduledTaskOutcomeCopy({
    reasonCode: occurrence.reasonCode, state: occurrence.state!, taskPauseReason: task.pauseReason, trigger: occurrence.trigger,
    unavailableSources: occurrence.unavailableSources
  });
  return {
    title: telegramScheduledTitle(task.title),
    lines: [copy.headline, ...(copy.reason ? [copy.reason] : []),
      ...scheduledTaskSourceLines(occurrence.unavailableSources, SOURCE_LINES),
      ...(filesLeft > 0 ? [telegramScheduledFilesInAiqsaText(filesLeft)] : [])]
  };
}

/**
 * The parts one delivery sends, in order: the heading with the rendered
 * result (split into messages within Telegram's limits; the heading goes
 * alone when the first message has no room for it), then the files as every
 * answer sends them (`files.ts`: at most ten, photos and documents within
 * Telegram's bounds; the heading names the rest). Open in AIQSA goes on the
 * last text message.
 */
export function telegramScheduledParts(context: TelegramScheduledDeliveryContext): readonly Part[] {
  const result = context.occurrence.state === "COMPLETED" ? context.result : null;
  const files = planTelegramFiles(result?.files ?? []);
  const head = headline(context, files.left);
  const openInAiqsa = Boolean(context.chat?.usable);
  const fileParts: Part[] = files.items.map((item) => ({ item, kind: "file" }));
  if (!result) return [{ kind: "text", openInAiqsa, text: [head.title, ...head.lines].join("\n") }, ...fileParts];
  const heading: TelegramInputRichBlock = {
    type: "paragraph", text: [{ type: "bold", text: head.title }, `\n${head.lines.join("\n")}`]
  };
  const answer = renderTelegramAnswer(result.markdown, { citations: result.citations, sources: result.sources });
  const [first, ...rest] = answer.messages;
  const joined = first ? packBlocks([heading, ...first.blocks]) : [{ blocks: [heading], skip_entity_detection: true }];
  // The heading shares the first message when it fits there, and leads alone otherwise.
  const messages = joined.length === 1 ? [joined[0]!, ...rest] : [{ blocks: [heading], skip_entity_detection: true }, ...answer.messages];
  return [
    ...messages.map((message, index): Part => ({
      kind: "content", message, openInAiqsa: openInAiqsa && index === messages.length - 1, plainFallback: plainTelegramMessage(message)
    })),
    ...fileParts
  ];
}

export type TelegramScheduledDeliverySenderDeps = Readonly<{
  access: Pick<TelegramAccessResolver, "resolveTelegramAccess">;
  /** Detaches work from its caller; defaults to a plain promise. */
  background?: (work: () => Promise<void>) => Promise<void>;
  /** Rows delivered at once. */
  concurrency?: number;
  now?: () => Date;
  sessions: TelegramSessionProvider;
  /** Wakes the sender after `ms`; defaults to an unreferenced timer. */
  setTimer?: (ms: number, wake: () => void) => void;
  store: TelegramScheduledDeliveryStore;
}>;

function unrefTimer(ms: number, wake: () => void): void {
  setTimeout(wake, ms).unref?.();
}

export function createTelegramScheduledDeliverySender(deps: TelegramScheduledDeliverySenderDeps) {
  const clock = deps.now ?? (() => new Date());
  const background = deps.background ?? ((work) => work());
  const setTimer = deps.setTimer ?? unrefTimer;
  const concurrency = Math.max(1, deps.concurrency ?? DEFAULT_CONCURRENCY);
  const inFlight = new Set<string>();
  const held = new Map<string, Held>();
  /** When this process first saw a row's result files still exported. */
  const exporting = new Map<string, number>();
  /** One wake serves every row waiting for an export. */
  let exportWake = false;
  let scanning: Promise<void> | null = null;
  let rescan = false;
  let interval: ReturnType<typeof setInterval> | null = null;

  async function settle(row: TelegramScheduledDeliveryRow, state: Settled, code: string | null): Promise<void> {
    held.delete(row.id);
    exporting.delete(row.id);
    await deps.store.settle({ at: clock(), code, id: row.id, state });
    log({
      ...(code ? { code } : {}), job_id: row.id, stage: "settle",
      ...(state === "sent" ? { outcome: "completed" as const } : state === "skipped"
        ? { action: "skip" as const, outcome: "skipped" as const } : { action: "fail" as const, outcome: "failed" as const })
    });
  }

  /** Why the row must not be delivered now, or the plan for it. */
  async function prepare(row: TelegramScheduledDeliveryRow): Promise<Readonly<{ skip: string }> | Readonly<{ plan: Plan }> | null> {
    const context = await deps.store.load(row);
    if (!context) return null;
    if (!context.task.telegramNotify) return { skip: TELEGRAM_SCHEDULED_CODES.off };
    const { occurrence } = context;
    if (occurrence.state === null || (occurrence.state === "COMPLETED" && occurrence.reasonCode === "no_update")) {
      return { skip: TELEGRAM_SCHEDULED_CODES.notNews };
    }
    // A result is its chat's answer: without that chat there is nothing to send or continue.
    if (occurrence.state === "COMPLETED" && (!context.result || !context.chat?.usable)) {
      return { skip: TELEGRAM_SCHEDULED_CODES.chatUnavailable };
    }
    const access = await deps.access.resolveTelegramAccess(row.userId);
    if (!access.allowed) return { skip: access.reasonCode };
    const session = await deps.sessions.current();
    if (!session) return { skip: "telegram_access_off" };
    if (session.botId !== access.link.botId) return { skip: "telegram_bot_changed" };
    const chat = context.chat?.usable ? context.chat.id : null;
    const outputs = context.occurrence.state === "COMPLETED" ? context.result?.outputs : undefined;
    return { plan: {
      binding: { botId: session.botId, linkId: access.link.id, telegramChatId: access.link.telegramChatId, userId: row.userId },
      owner: chat ? { chatId: chat, linkId: access.link.id, messageId: context.result?.messageId ?? null, userId: row.userId } : null,
      parts: telegramScheduledParts(context),
      ...(outputs ? { outputs } : {})
    } };
  }

  /**
   * A result's Workspace files are published after its run: the delivery
   * waits for their export in this process, at most two minutes, then sends
   * what is there and names the rest. True while it waits.
   */
  function awaitOutputs(row: TelegramScheduledDeliveryRow, plan: Plan): boolean {
    if (plan.outputs !== "pending") {
      exporting.delete(row.id);
      return false;
    }
    const at = clock().getTime();
    const since = exporting.get(row.id) ?? at;
    if (at - since >= TELEGRAM_FILES_EXPORT_WAIT_MS) {
      exporting.delete(row.id);
      return false;
    }
    exporting.set(row.id, since);
    log({ action: "wait", delay_ms: TELEGRAM_FILES_EXPORT_POLL_MS, job_id: row.id, outcome: "waiting", stage: "dispatch" });
    if (!exportWake) {
      exportWake = true;
      setTimer(TELEGRAM_FILES_EXPORT_POLL_MS, () => {
        exportWake = false;
        wake();
      });
    }
    return true;
  }

  /**
   * The plan's link checked again right before each message or upload leaves the Bot API; `reasonCode`
   * is why it no longer reaches the chat once `authorize` said false.
   */
  function authority(binding: TelegramChatBinding): { authorize: () => Promise<boolean>; reasonCode: TelegramAccessRefusal } {
    const recheck = {
      authorize: async () => {
        const again = await reachTelegramChat(deps, binding);
        if (!again.ok) recheck.reasonCode = again.reasonCode;
        return again.ok;
      },
      reasonCode: "telegram_access_off" as TelegramAccessRefusal
    };
    return recheck;
  }

  /**
   * Sends one part, right after checking that the plan's link still reaches its chat (a file once
   * more after its bytes were read). `skipped`: a file Telegram did not get (unreadable now, or
   * refused itself), named once after the last part.
   */
  async function sendPart(plan: Plan, part: Part, userId: string): Promise<PartOutcome> {
    const reached = await reachTelegramChat(deps, plan.binding);
    if (!reached.ok) return { refused: reached.reasonCode };
    const { outbound } = reached.bot;
    const chatId = plan.binding.telegramChatId;
    const owner = plan.owner;
    const recheck = authority(plan.binding);
    const sent = (delivery: TelegramDelivery): PartOutcome => !delivery.ok && delivery.failure.kind === "unreachable"
      ? { partly: delivery.messageIds.length > 0, refused: recheck.reasonCode }
      : delivery;
    if (part.kind === "text") {
      return sent(await outbound.sendText({
        authorize: recheck.authorize, chatId, openInAiqsa: part.openInAiqsa && Boolean(owner), text: part.text, ...(owner ? { owner } : {})
      }));
    }
    if (part.kind === "content") {
      if (!owner) return sent(await outbound.sendText({ authorize: recheck.authorize, chatId, text: part.plainFallback.join("\n\n") }));
      return sent(await outbound.sendContent({
        authorize: recheck.authorize, chatId, messages: [part.message], openInAiqsa: part.openInAiqsa, owner
      }));
    }
    // Only a result in a usable chat has files; they stay in AIQSA otherwise.
    if (!owner) return "skipped";
    const outcome = await sendTelegramFile({
      authorize: recheck.authorize, chatId, item: part.item, outbound, owner, read: (input) => deps.store.readFile(input), userId
    });
    if (outcome.kind === "sent") return { fallback: false, messageIds: outcome.messageIds, ok: true };
    if (outcome.kind === "unreachable") return { refused: recheck.reasonCode };
    return outcome.kind === "skipped" ? "skipped" : { failure: outcome.failure, messageIds: [], ok: false };
  }

  /**
   * The files Telegram did not get, named once under Open in AIQSA; the result itself is delivered
   * either way. The access reason when the plan's link no longer reaches the chat.
   */
  async function summarizeFiles(row: TelegramScheduledDeliveryRow, plan: Plan, skipped: number): Promise<TelegramAccessRefusal | null> {
    const text = telegramFilesSummaryText({ failed: skipped, left: 0, ...(plan.outputs ? { outputs: plan.outputs } : {}) });
    if (!text || !plan.owner) return null;
    if (skipped > 0) log({ code: "telegram_file_failed", count: skipped, job_id: row.id, outcome: "degraded", stage: "dispatch" });
    const reached = await reachTelegramChat(deps, plan.binding);
    if (!reached.ok) return reached.reasonCode;
    const recheck = authority(plan.binding);
    const delivery = await reached.bot.outbound.sendText({
      authorize: recheck.authorize, chatId: plan.binding.telegramChatId, openInAiqsa: true, owner: plan.owner, text
    });
    return !delivery.ok && delivery.failure.kind === "unreachable" ? recheck.reasonCode : null;
  }

  /** The delay before the next attempt, or null when the attempts or the window are used up. */
  function retryDelay(row: TelegramScheduledDeliveryRow, attempts: number, failure: TelegramFailure): number | null {
    if (attempts >= TELEGRAM_SCHEDULED_MAX_ATTEMPTS) return null;
    const delay = failure.kind === "telegram"
      ? Math.max(1, failure.retryAfter ?? 1) * 1_000
      : Math.min(NETWORK_RETRY_BASE_MS * 2 ** (attempts - 1), NETWORK_RETRY_MAX_MS);
    return clock().getTime() + delay > row.createdAt.getTime() + TELEGRAM_SCHEDULED_RETRY_WINDOW_MS ? null : delay;
  }

  async function attempt(row: TelegramScheduledDeliveryRow, plan: Plan, from: number, skippedBefore = 0): Promise<void> {
    const attempts = row.attempts + 1;
    if (!await deps.store.claim({
      attempts: row.attempts, id: row.id, leaseUntil: new Date(clock().getTime() + TELEGRAM_SCHEDULED_CLAIM_LEASE_MS)
    })) {
      held.delete(row.id);
      return;
    }
    let skipped = skippedBefore;
    for (let index = from; index < plan.parts.length; index += 1) {
      const delivery = await sendPart(plan, plan.parts[index]!, row.userId);
      if (delivery === "skipped") {
        skipped += 1;
        continue;
      }
      // The link no longer reaches the chat: nothing more goes out, and what already went fails the delivery.
      if ("refused" in delivery) return settle(row, index === 0 && !delivery.partly ? "skipped" : "failed", delivery.refused);
      if (delivery.ok) continue;
      const { failure } = delivery;
      const code = telegramFailureCode(failure.kind, failure.errorCode);
      if (ambiguous(failure)) return settle(row, "unknown", TELEGRAM_SCHEDULED_CODES.unknown);
      // A part Telegram took in pieces cannot be resumed exactly; it is never sent twice.
      const delay = retryable(failure) && delivery.messageIds.length === 0 ? retryDelay(row, attempts, failure) : null;
      if (delay === null) return settle(row, "failed", code);
      const nextAttemptAt = new Date(clock().getTime() + delay);
      if (index === 0) {
        // Nothing reached Telegram: a later attempt, here or after a restart, starts over.
        held.delete(row.id);
        await deps.store.release({ code, id: row.id, nextAttemptAt });
      } else {
        // Part of the result is out: only this process knows where to go on, so the
        // row stays claimed and settles `unknown` if the process ends meanwhile.
        held.set(row.id, { attempts, plan, progress: index, skipped });
        await deps.store.release({ code: TELEGRAM_SCHEDULED_CODES.unknown, id: row.id, nextAttemptAt });
      }
      log({ action: "retry", code, delay_ms: delay, job_id: row.id, outcome: "waiting", stage: "dispatch" });
      setTimer(delay, wake);
      return;
    }
    const refused = await summarizeFiles(row, plan, skipped);
    return refused ? settle(row, "failed", refused) : settle(row, "sent", null);
  }

  async function deliver(row: TelegramScheduledDeliveryRow): Promise<void> {
    const kept = held.get(row.id);
    const resumable = kept && kept.attempts === row.attempts ? kept : undefined;
    if (row.lastFailureCode === TELEGRAM_SCHEDULED_CODES.unknown && !resumable) {
      // A claimed attempt nobody settled: it may have reached Telegram, so it is never repeated.
      return settle(row, "unknown", TELEGRAM_SCHEDULED_CODES.unknown);
    }
    const prepared = await prepare(row);
    if (!prepared) {
      held.delete(row.id);
      return;
    }
    // Part of a result is out already: what stops the rest fails the delivery rather than skipping it.
    if ("skip" in prepared) return settle(row, resumable ? "failed" : "skipped", prepared.skip);
    if (!resumable) return awaitOutputs(row, prepared.plan) ? undefined : attempt(row, prepared.plan, 0);
    const current = prepared.plan.binding;
    const earlier = resumable.plan.binding;
    if (current.linkId !== earlier.linkId || current.telegramChatId !== earlier.telegramChatId || current.botId !== earlier.botId) {
      // Linked anew meanwhile: the rest never goes to another link or Telegram chat.
      return settle(row, "failed", "telegram_not_linked");
    }
    return attempt(row, resumable.plan, resumable.progress, resumable.skipped);
  }

  async function guarded(row: TelegramScheduledDeliveryRow): Promise<void> {
    inFlight.add(row.id);
    try {
      await deliver(row);
    } catch (error) {
      log({ action: "skip", job_id: row.id, outcome: "failed", prisma_code: databaseFailureCode(error), stage: "dispatch" });
    } finally {
      inFlight.delete(row.id);
    }
  }

  async function scan(): Promise<void> {
    do {
      rescan = false;
      let rows: readonly TelegramScheduledDeliveryRow[];
      try {
        rows = (await deps.store.listDue(clock(), SWEEP_BATCH)).filter((row) => !inFlight.has(row.id));
      } catch (error) {
        log({ action: "skip", outcome: "failed", prisma_code: databaseFailureCode(error), stage: "claim" });
        return;
      }
      const queue = [...rows];
      await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        for (let row = queue.shift(); row; row = queue.shift()) await guarded(row);
      }));
    } while (rescan);
  }

  /** Looks for due rows now, or once more after the scan in progress. */
  function wake(): void {
    if (scanning) {
      rescan = true;
      return;
    }
    scanning = background(scan).catch(() => undefined).finally(() => {
      scanning = null;
    });
  }

  /** Resolves when no scan is running (tests and shutdown). */
  async function idle(): Promise<void> {
    while (scanning) await scanning;
  }

  return {
    /**
     * Records a notifying occurrence's delivery and wakes the sender; never
     * throws and never waits for Telegram. The row is written only for a task
     * with Telegram delivery on. Resolves once the row is recorded.
     */
    queue(occurrenceId: string): Promise<void> {
      return background(async () => {
        try {
          if (await deps.store.enqueue(occurrenceId, clock())) wake();
        } catch (error) {
          log({ action: "skip", job_id: occurrenceId, outcome: "failed", prisma_code: databaseFailureCode(error), stage: "write" });
        }
      }).catch(() => undefined);
    },
    /** Delivers the due rows now, as the start and the once-a-minute sweep do. */
    async sweep(): Promise<void> {
      wake();
      await idle();
    },
    /** Sweeps now and then once a minute. */
    start(): void {
      if (interval) return;
      interval = setInterval(wake, TELEGRAM_SCHEDULED_SWEEP_INTERVAL_MS);
      interval.unref?.();
      wake();
    },
    stop(): void {
      if (interval) clearInterval(interval);
      interval = null;
    },
    idle
  };
}

export type TelegramScheduledDeliverySender = ReturnType<typeof createTelegramScheduledDeliverySender>;

// ---------------------------------------------------------------------------
// PostgreSQL

const SETTLED_STATES: ReadonlySet<string> = new Set(["COMPLETED", "FAILED", "SKIPPED"]);

function trigger(value: string): ScheduledTaskRunTrigger {
  return value === "manual" ? "manual" : "schedule";
}

export function createPrismaTelegramScheduledDeliveryStore(deps: Readonly<{
  prisma: PrismaClient;
  /** The object store holding run files; loaded on the first file. */
  storage: () => StorageAdapter;
}>): TelegramScheduledDeliveryStore {
  const { prisma } = deps;
  const readFile = createPrismaTelegramFileReader({ prisma, storage: deps.storage });
  return Object.freeze({
    async enqueue(occurrenceId, now) {
      const inserted = await prisma.$executeRaw(Prisma.sql`
        INSERT INTO "TelegramScheduledDelivery" ("id", "occurrenceId", "userId", "state", "attempts", "nextAttemptAt", "createdAt")
        SELECT ${randomUUID()}, occurrence."id", occurrence."userId", 'pending'::"TelegramScheduledDeliveryState", 0, ${now}, ${now}
        FROM "ScheduledTaskOccurrence" AS occurrence
        INNER JOIN "ScheduledTask" AS task ON task."id" = occurrence."taskId" AND task."userId" = occurrence."userId"
        WHERE occurrence."id" = ${occurrenceId}
          AND task."telegramNotify"
          AND occurrence."state" IN ('COMPLETED'::"ScheduledTaskOccurrenceState",
            'FAILED'::"ScheduledTaskOccurrenceState", 'SKIPPED'::"ScheduledTaskOccurrenceState")
        ON CONFLICT ("occurrenceId") DO NOTHING
      `);
      return inserted === 1;
    },

    async listDue(now, limit) {
      return prisma.telegramScheduledDelivery.findMany({
        orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }],
        select: { attempts: true, createdAt: true, id: true, lastFailureCode: true, nextAttemptAt: true, occurrenceId: true, userId: true },
        take: Math.max(1, Math.min(limit, 500)),
        where: { nextAttemptAt: { lte: now }, state: "pending" }
      });
    },

    async load(row) {
      const occurrence = await prisma.scheduledTaskOccurrence.findFirst({
        select: {
          chat: { select: { id: true, permanentDeletionAt: true } },
          reasonCode: true,
          runId: true,
          state: true,
          task: { select: {
            chat: { select: { id: true, permanentDeletionAt: true } }, pauseReason: true, telegramNotify: true, title: true
          } },
          trigger: true,
          unavailableSources: true
        },
        where: { id: row.occurrenceId, userId: row.userId }
      });
      if (!occurrence) return null;
      const state = SETTLED_STATES.has(occurrence.state) ? occurrence.state as ScheduledTaskSettledState : null;
      const base = {
        occurrence: {
          reasonCode: occurrence.reasonCode, state, trigger: trigger(occurrence.trigger),
          unavailableSources: unavailableSourcesWire(occurrence.unavailableSources)
        },
        task: occurrence.task
      };
      if (state !== "COMPLETED") {
        const chat = occurrence.chat ?? occurrence.task.chat;
        return { ...base, chat: chat && { id: chat.id, usable: chat.permanentDeletionAt === null }, result: null };
      }
      const run = occurrence.runId ? await prisma.modelRun.findFirst({
        select: {
          assistantMessage: { select: { chat: { select: { id: true, permanentDeletionAt: true, userId: true } }, content: true, id: true,
            role: true } },
          events: {
            orderBy: { sequence: "asc" }, select: { eventType: true, payload: true },
            where: { eventType: { in: ["artifact", "grounding_display"] } }
          },
          searchRuns: { orderBy: { createdAt: "asc" }, select: { artifacts: true, invocationId: true, status: true, strategyId: true } },
          workspaceRunBinding: { select: { exportState: true } },
          workspaceProducedAttachments: {
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            select: {
              byteSize: true, checksum: true, fileName: true, id: true, metadata: true, mimeType: true, origin: true,
              workspaceCheckpointFile: { select: { checkpoint: { select: { createdAt: true, description: true, id: true, state: true } },
                relativePath: true } },
              workspaceRunOutput: { select: { relativePath: true } }
            }
          }
        },
        where: { id: occurrence.runId, userId: row.userId }
      }) : null;
      const message = run?.assistantMessage;
      // The run's own chat: the occurrence keeps it until that chat is deleted.
      if (!run || !message || message.role !== "assistant" || message.chat.userId !== row.userId ||
        message.chat.id !== occurrence.chat?.id) {
        return { ...base, chat: occurrence.chat && { id: occurrence.chat.id, usable: false }, result: null };
      }
      const markdown = scheduledCopyText(message.content);
      const summary = summarizeMessageRunArtifacts(run);
      const files = telegramAnswerFiles(summary);
      const exported = telegramRunExport(run.workspaceRunBinding?.exportState);
      const outputs = exported === "pending" || exported === "failed" ? exported : undefined;
      return {
        ...base,
        chat: { id: message.chat.id, usable: message.chat.permanentDeletionAt === null },
        result: markdown || files.length > 0 || outputs ? {
          citations: summary?.citations ?? [], files, markdown, messageId: message.id, sources: summary?.sources ?? [],
          ...(outputs ? { outputs } : {})
        } : null
      };
    },

    async claim({ attempts, id, leaseUntil }) {
      const claimed = await prisma.telegramScheduledDelivery.updateMany({
        data: { attempts: { increment: 1 }, lastFailureCode: TELEGRAM_SCHEDULED_CODES.unknown, nextAttemptAt: leaseUntil },
        where: { attempts, id, state: "pending" }
      });
      return claimed.count === 1;
    },

    async release({ code, id, nextAttemptAt }) {
      await prisma.telegramScheduledDelivery.updateMany({
        data: { lastFailureCode: code, nextAttemptAt }, where: { id, state: "pending" }
      });
    },

    async settle({ at, code, id, state }) {
      const settled = await prisma.telegramScheduledDelivery.updateMany({
        data: { lastFailureCode: code, sentAt: state === "sent" ? at : null, state }, where: { id, state: "pending" }
      });
      return settled.count === 1;
    },

    readFile
  });
}

// ---------------------------------------------------------------------------
// Process defaults

const globalForDelivery = globalThis as unknown as { __aiqsaTelegramScheduledDelivery?: TelegramScheduledDeliverySender };

/** One sender per application process (single replica), shared across route bundles. */
export function getDefaultTelegramScheduledDelivery(): TelegramScheduledDeliverySender {
  if (!globalForDelivery.__aiqsaTelegramScheduledDelivery) {
    const telegram = getDefaultTelegram();
    let storage: StorageAdapter | null = null;
    globalForDelivery.__aiqsaTelegramScheduledDelivery = createTelegramScheduledDeliverySender({
      access: telegram.access,
      background: (work) => runInBackground(work),
      sessions: telegram.sessions,
      store: createPrismaTelegramScheduledDeliveryStore({ prisma, storage: () => storage ??= createS3StorageAdapter() })
    });
  }
  return globalForDelivery.__aiqsaTelegramScheduledDelivery;
}

/**
 * The scheduled task editor's flag: the owner has a link that Telegram access
 * allows now. A failed read says false.
 */
export async function isTelegramScheduledDeliveryAvailable(userId: string): Promise<boolean> {
  try {
    return (await getDefaultTelegram().access.resolveTelegramAccess(userId)).allowed;
  } catch (error) {
    logEvent("service_operation", { code: "telegram_control_unavailable", error, outcome: "failed", stage: "read", subsystem: "telegram" });
    return false;
  }
}
