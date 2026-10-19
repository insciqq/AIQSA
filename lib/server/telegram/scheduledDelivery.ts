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
import type { TelegramAccessResolver } from "./control/access";
import type { TelegramSessionProvider } from "./control/session";
import { telegramScheduledFilesInAiqsaText, telegramScheduledTitle } from "./copy";
import { getDefaultTelegram } from "./defaultTelegram";
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
 * the occurrence. Only a send that provably never reached Telegram (429 or a
 * network failure before sending) is retried, up to five attempts within 30
 * minutes; an ambiguous one settles `unknown`. Rows are swept at start and
 * once a minute. Logs carry ids and codes, never content.
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
/** Files a result sends (D-16); more stay behind Open in AIQSA. */
export const TELEGRAM_SCHEDULED_MAX_FILES = 10;
export const TELEGRAM_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
export const TELEGRAM_DOCUMENT_MAX_BYTES = 50 * 1024 * 1024;
const PHOTO_MIME_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/webp"]);
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

export type TelegramScheduledFile = Readonly<{
  attachmentId: string;
  byteSize: number;
  fileName: string;
  mimeType: string;
}>;

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
  /** The bytes of one of the owner's ready files, at most `maxBytes`; null when unavailable. */
  readFile(input: Readonly<{ attachmentId: string; maxBytes: number; userId: string }>): Promise<Buffer | null>;
}>;

/** One message (or one file) a delivery sends, in order. */
export type TelegramScheduledPart =
  | Readonly<{ kind: "content"; message: TelegramInputRichMessage; plainFallback: readonly string[]; openInAiqsa: boolean }>
  | Readonly<{ kind: "text"; text: string; openInAiqsa: boolean }>
  | Readonly<{ kind: "file"; file: TelegramScheduledFile; photo: boolean }>;
type Part = TelegramScheduledPart;

type Plan = Readonly<{ botId: number; owner: TelegramMessageRefOwner | null; parts: readonly Part[]; telegramChatId: number }>;

/** Delivery progress kept between attempts of a partly sent result, in this process only. */
type Held = Readonly<{ attempts: number; plan: Plan; progress: number }>;

type Settled = "sent" | "failed" | "unknown" | "skipped";

/** Content-free: the row id, codes, delays and counts. */
function log(fields: Readonly<{
  action?: "retry" | "skip" | "fail"; code?: string; count?: number; delay_ms?: number; job_id?: string; prisma_code?: string;
  outcome: "completed" | "failed" | "skipped" | "waiting"; stage: "claim" | "dispatch" | "settle" | "write";
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
 * alone when the first message has no room for it), then the files. Open in
 * AIQSA goes on the last text message.
 */
export function telegramScheduledParts(context: TelegramScheduledDeliveryContext): readonly Part[] {
  const result = context.occurrence.state === "COMPLETED" ? context.result : null;
  const files = result?.files ?? [];
  // A photo over Telegram's photo bound goes as a document; anything over the document bound stays in AIQSA.
  const sendable = files.filter((file) => file.byteSize > 0 && file.byteSize <= TELEGRAM_DOCUMENT_MAX_BYTES)
    .slice(0, TELEGRAM_SCHEDULED_MAX_FILES);
  const head = headline(context, files.length - sendable.length);
  const openInAiqsa = Boolean(context.chat?.usable);
  const fileParts: Part[] = sendable.map((file) => ({
    file, kind: "file", photo: PHOTO_MIME_TYPES.has(file.mimeType) && file.byteSize <= TELEGRAM_PHOTO_MAX_BYTES
  }));
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
  let scanning: Promise<void> | null = null;
  let rescan = false;
  let interval: ReturnType<typeof setInterval> | null = null;

  async function settle(row: TelegramScheduledDeliveryRow, state: Settled, code: string | null): Promise<void> {
    held.delete(row.id);
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
    return { plan: {
      botId: session.botId,
      owner: chat ? { chatId: chat, linkId: access.link.id, messageId: context.result?.messageId ?? null, userId: row.userId } : null,
      parts: telegramScheduledParts(context),
      telegramChatId: access.link.telegramChatId
    } };
  }

  async function sendPart(plan: Plan, part: Part, userId: string): Promise<TelegramDelivery | "unavailable"> {
    const session = await deps.sessions.current();
    // The bot went off or changed since the recheck: its links no longer reach the user.
    if (!session || session.botId !== plan.botId) return "unavailable";
    const { outbound } = session;
    const owner = plan.owner;
    if (part.kind === "text") {
      return outbound.sendText({
        chatId: plan.telegramChatId, openInAiqsa: part.openInAiqsa && Boolean(owner), text: part.text, ...(owner ? { owner } : {})
      });
    }
    if (part.kind === "content") {
      if (!owner) return outbound.sendText({ chatId: plan.telegramChatId, text: part.plainFallback.join("\n\n") });
      return outbound.sendContent({
        chatId: plan.telegramChatId, messages: [part.message], openInAiqsa: part.openInAiqsa, owner
      });
    }
    const maxBytes = part.photo ? TELEGRAM_PHOTO_MAX_BYTES : TELEGRAM_DOCUMENT_MAX_BYTES;
    const data = owner ? await deps.store.readFile({ attachmentId: part.file.attachmentId, maxBytes, userId }) : null;
    // A file that cannot be read now stays in AIQSA, behind the result's Open in AIQSA.
    if (!data || !owner) return { fallback: false, messageIds: [], ok: true };
    return outbound.sendFile({
      chatId: plan.telegramChatId, file: { contentType: part.file.mimeType, data, filename: part.file.fileName },
      kind: part.photo ? "photo" : "document", owner
    });
  }

  /** The delay before the next attempt, or null when the attempts or the window are used up. */
  function retryDelay(row: TelegramScheduledDeliveryRow, attempts: number, failure: TelegramFailure): number | null {
    if (attempts >= TELEGRAM_SCHEDULED_MAX_ATTEMPTS) return null;
    const delay = failure.kind === "telegram"
      ? Math.max(1, failure.retryAfter ?? 1) * 1_000
      : Math.min(NETWORK_RETRY_BASE_MS * 2 ** (attempts - 1), NETWORK_RETRY_MAX_MS);
    return clock().getTime() + delay > row.createdAt.getTime() + TELEGRAM_SCHEDULED_RETRY_WINDOW_MS ? null : delay;
  }

  async function attempt(row: TelegramScheduledDeliveryRow, plan: Plan, from: number): Promise<void> {
    const attempts = row.attempts + 1;
    if (!await deps.store.claim({
      attempts: row.attempts, id: row.id, leaseUntil: new Date(clock().getTime() + TELEGRAM_SCHEDULED_CLAIM_LEASE_MS)
    })) {
      held.delete(row.id);
      return;
    }
    for (let index = from; index < plan.parts.length; index += 1) {
      const delivery = await sendPart(plan, plan.parts[index]!, row.userId);
      if (delivery === "unavailable") return settle(row, index === 0 ? "skipped" : "failed", "telegram_access_off");
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
        held.set(row.id, { attempts, plan, progress: index });
        await deps.store.release({ code: TELEGRAM_SCHEDULED_CODES.unknown, id: row.id, nextAttemptAt });
      }
      log({ action: "retry", code, delay_ms: delay, job_id: row.id, outcome: "waiting", stage: "dispatch" });
      setTimer(delay, wake);
      return;
    }
    return settle(row, "sent", null);
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
    if (!resumable) return attempt(row, prepared.plan, 0);
    if (prepared.plan.telegramChatId !== resumable.plan.telegramChatId || prepared.plan.botId !== resumable.plan.botId) {
      // Linked anew meanwhile: the rest never goes to another Telegram chat.
      return settle(row, "failed", "telegram_not_linked");
    }
    return attempt(row, resumable.plan, resumable.progress);
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
      const summary = summarizeMessageRunArtifacts(run, message.content);
      const files: TelegramScheduledFile[] = [
        ...(summary?.generatedImages ?? []).map((image) => ({
          attachmentId: image.attachmentId, byteSize: image.byteSize, fileName: image.fileName, mimeType: image.mimeType
        })),
        ...(summary?.generatedFiles ?? []).map((file) => ({
          attachmentId: file.attachmentId, byteSize: file.byteSize, fileName: file.fileName, mimeType: file.mimeType
        }))
      ];
      return {
        ...base,
        chat: { id: message.chat.id, usable: message.chat.permanentDeletionAt === null },
        result: markdown || files.length > 0 ? {
          citations: summary?.citations ?? [], files, markdown, messageId: message.id, sources: summary?.sources ?? []
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

    async readFile({ attachmentId, maxBytes, userId }) {
      const attachment = await prisma.attachment.findFirst({
        select: { byteSize: true, storageKey: true },
        where: { id: attachmentId, projectId: null, status: "ready", userId }
      });
      if (!attachment || attachment.byteSize > maxBytes) return null;
      try {
        return (await deps.storage().getObject(attachment.storageKey, { maxBytes })).body;
      } catch (error) {
        // The file stays behind the result's Open in AIQSA.
        logEvent("service_operation", { action: "degrade", error, outcome: "degraded", stage: "read", subsystem: "telegram" });
        return null;
      }
    }
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
