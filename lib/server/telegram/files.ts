import type { PrismaClient } from "@prisma/client";
import type { ThreadArtifactSummary } from "../../contracts/chats";
import { logEvent, runInBackground } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import { createPrismaAttachmentDownloadRepository } from "../uploads/downloadRepository";
import type { StorageAdapter } from "../uploads/storage";
import { onTelegramRunEvent, type TelegramRunEventContext, type TelegramRunListener } from "./bridge/events";
import { telegramFailureCode } from "./codes";
import type { TelegramAccessResolver } from "./control/access";
import { telegramFilesSummaryText } from "./copy";
import type { TelegramOutbound } from "./outbound";
import type { TelegramMessageRefOwner } from "./store/messageRefs";
import type { TelegramFailure } from "./transport";

/**
 * Files of an answer in Telegram (D-16), for a run's generated files and
 * images and for a scheduled result alike: at most ten, an image up to 10 MB
 * as a photo (a photo Telegram refuses goes once more as a document) and
 * anything else up to 50 MB as a document. The bytes are read through the
 * download route's authority (a ready file the user may open now), the shown
 * name is cleaned, and what stays in AIQSA (more or larger files) or could
 * not be sent is named once, in one line after them. A Workspace
 * run's output files are published after its answer: their export is waited
 * for, at most two minutes. Logs carry codes and counts, never names or content.
 */

export const TELEGRAM_FILES_MAX = 10;
export const TELEGRAM_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
export const TELEGRAM_DOCUMENT_MAX_BYTES = 50 * 1024 * 1024;
export const TELEGRAM_FILE_NAME_MAX_LENGTH = 120;
/** How long an answer's files wait for its Workspace outputs to be exported. */
export const TELEGRAM_FILES_EXPORT_WAIT_MS = 2 * 60_000;
/** How often a waiting delivery looks at the export again (scheduled results). */
export const TELEGRAM_FILES_EXPORT_POLL_MS = 5_000;
const EXPORT_POLL_FIRST_MS = 1_000;
const EXPORT_POLL_MAX_MS = 10_000;
const PHOTO_MIME_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/webp"]);
const EXTENSION_MAX_LENGTH = 16;
const FALLBACK_EXTENSIONS: Readonly<Record<string, string>> = {
  "application/json": ".json", "application/pdf": ".pdf", "application/zip": ".zip", "image/jpeg": ".jpg", "image/png": ".png",
  "image/webp": ".webp", "text/csv": ".csv", "text/html": ".html", "text/markdown": ".md", "text/plain": ".txt"
};

/** Every code this module logs besides Telegram's transport codes. */
export const TELEGRAM_FILE_LOG_CODES = ["telegram_file_failed", "telegram_file_unavailable"] as const;

export type TelegramAnswerFile = Readonly<{ attachmentId: string; byteSize: number; fileName: string; mimeType: string }>;
export type TelegramPlannedFile = Readonly<{ file: TelegramAnswerFile; kind: "photo" | "document" }>;
/** The files an answer sends, in order, and how many stay in AIQSA. */
export type TelegramFilePlan = Readonly<{ items: readonly TelegramPlannedFile[]; left: number }>;

/** The bytes of a ready file the user may open now, at most `maxBytes`; null when unavailable. */
export type TelegramFileReader = (input: Readonly<{ attachmentId: string; maxBytes: number; userId: string }>) => Promise<Buffer | null>;

export type TelegramFileOutcome =
  | Readonly<{ kind: "sent"; messageIds: readonly number[] }>
  /** Not sent, and safe to name as such: its bytes cannot be read now, or Telegram refused this file. */
  | Readonly<{ kind: "skipped" }>
  /** The send itself failed (the chat refuses, rate limit, network): the caller decides what follows. */
  | Readonly<{ kind: "failed"; failure: TelegramFailure }>
  /** Not sent: the chat may no longer receive it, so nothing more goes there. */
  | Readonly<{ kind: "unreachable" }>;

/**
 * Asked after a file's bytes are read, and again by the Bot API right before every upload leaves (after
 * its pacing or a 429's wait): false when the chat may no longer receive it.
 */
export type TelegramFileAuthority = () => Promise<boolean>;

export type TelegramFilesResult = Readonly<{ sent: number; failed: number; left: number }>;

/**
 * A run's Workspace output export: `none` (the run has no Workspace), still
 * `pending` (its files are not in the answer yet), `complete` or `failed`.
 */
export type TelegramRunExport = "none" | "pending" | "complete" | "failed";
export type TelegramRunExportReader = (input: Readonly<{ runId: string; userId: string }>) => Promise<TelegramRunExport>;

/** A Workspace binding's export state as Telegram waits for it. */
export function telegramRunExport(state: string | null | undefined): TelegramRunExport {
  if (!state) return "none";
  return state === "COMPLETE" ? "complete" : state === "FAILED" ? "failed" : "pending";
}

/** Content-free: codes, counts and HTTP status. */
function log(fields: Readonly<{
  code: string; count?: number; error?: unknown; httpStatus?: number; outcome: "degraded" | "failed"; stage: "dispatch" | "read";
}>): void {
  logEvent("service_operation", {
    code: fields.code, ...(fields.count === undefined ? {} : { count: fields.count }),
    ...(fields.error ? { error: fields.error, prisma_code: databaseFailureCode(fields.error) } : {}),
    ...(fields.httpStatus ? { httpStatus: fields.httpStatus } : {}), outcome: fields.outcome, stage: fields.stage, subsystem: "telegram"
  });
}

/** At most ten files of a sendable size, each a photo when it is an image Telegram shows as one. */
export function planTelegramFiles(files: readonly TelegramAnswerFile[]): TelegramFilePlan {
  const sendable = files.filter((file) => Number.isSafeInteger(file.byteSize) && file.byteSize > 0 && file.byteSize <= TELEGRAM_DOCUMENT_MAX_BYTES)
    .slice(0, TELEGRAM_FILES_MAX);
  return {
    items: sendable.map((file) => ({
      file, kind: PHOTO_MIME_TYPES.has(file.mimeType) && file.byteSize <= TELEGRAM_PHOTO_MAX_BYTES ? "photo" : "document"
    })),
    left: files.length - sendable.length
  };
}

/** A settled answer's generated images, then its generated files, each once. */
export function telegramAnswerFiles(
  summary: Pick<ThreadArtifactSummary, "generatedFiles" | "generatedImages"> | null | undefined
): TelegramAnswerFile[] {
  const seen = new Set<string>();
  const files: TelegramAnswerFile[] = [];
  for (const file of [...(summary?.generatedImages ?? []), ...(summary?.generatedFiles ?? [])]) {
    if (seen.has(file.attachmentId)) continue;
    seen.add(file.attachmentId);
    files.push({ attachmentId: file.attachmentId, byteSize: file.byteSize, fileName: file.fileName, mimeType: file.mimeType });
  }
  return files;
}

// Control, format and invisible characters (bidirectional overrides included) never reach a shown name.
const NAME_INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const NAME_UNSAFE = /["*:<>?\\/|]/gu;

/**
 * The name Telegram shows for a file: the last path segment without control,
 * format or invisible characters, reserved punctuation as `_`, no leading
 * dots, at most 120 characters keeping the extension; `file` (with the
 * type's usual extension) when nothing is left.
 */
export function cleanTelegramFileName(fileName: string, mimeType: string): string {
  const segment = fileName.normalize("NFC").split(/[\\/]/u).at(-1) ?? "";
  const cleaned = segment.replace(NAME_INVISIBLE, "").replace(NAME_UNSAFE, "_").replace(/\s+/gu, " ").trim().replace(/^[.\s]+/u, "");
  const dot = cleaned.lastIndexOf(".");
  const extension = dot > 0 && cleaned.length - dot <= EXTENSION_MAX_LENGTH ? cleaned.slice(dot) : "";
  const stem = Array.from(extension ? cleaned.slice(0, dot) : cleaned)
    .slice(0, TELEGRAM_FILE_NAME_MAX_LENGTH - extension.length).join("").trimEnd();
  if (stem) return `${stem}${extension}`;
  return `file${extension || FALLBACK_EXTENSIONS[mimeType.toLowerCase()] || ""}`;
}

/**
 * Reads a file's bytes through the download route's authority: a ready file
 * of the user's own. A file whose stored size differs from its record, or that
 * storage cannot return, is unavailable.
 */
export function createPrismaTelegramFileReader(deps: Readonly<{
  prisma: PrismaClient;
  storage: () => StorageAdapter | Promise<StorageAdapter>;
}>): TelegramFileReader {
  const downloads = createPrismaAttachmentDownloadRepository(deps.prisma);
  return async ({ attachmentId, maxBytes, userId }) => {
    const record = await downloads.resolve({ attachmentId, userId });
    if (!record || !Number.isSafeInteger(record.byteSize) || record.byteSize < 1 || record.byteSize > maxBytes) return null;
    try {
      const stored = await (await deps.storage()).getObject(record.storageKey, { maxBytes: record.byteSize });
      return stored.body.length === record.byteSize ? stored.body : null;
    } catch (error) {
      // The file stays in AIQSA; the answer's files line says so.
      log({ code: "telegram_file_unavailable", error, outcome: "degraded", stage: "read" });
      return null;
    }
  };
}

/** The export state of the user's own run's Workspace outputs. */
export function createPrismaTelegramRunExportReader(prisma: Pick<PrismaClient, "workspaceRunBinding">): TelegramRunExportReader {
  return async ({ runId, userId }) => {
    const binding = await prisma.workspaceRunBinding.findFirst({
      select: { exportState: true }, where: { modelRun: { userId }, modelRunId: runId }
    });
    return telegramRunExport(binding?.exportState);
  };
}

function defaultTelegramRunExportReader(): TelegramRunExportReader {
  return async (input) => createPrismaTelegramRunExportReader((await import("../prisma")).prisma)(input);
}

/** The application's reader, loading Prisma and object storage on its first file. */
export function defaultTelegramFileReader(): TelegramFileReader {
  let reader: Promise<TelegramFileReader> | null = null;
  const load = async (): Promise<TelegramFileReader> => {
    const [{ prisma }, { createS3StorageAdapter }] = await Promise.all([import("../prisma"), import("../uploads/storage")]);
    const storage = createS3StorageAdapter();
    return createPrismaTelegramFileReader({ prisma, storage: () => storage });
  };
  return async (input) => {
    reader ??= load().catch((error: unknown) => {
      reader = null;
      throw error;
    });
    return (await reader)(input);
  };
}

/** Telegram refused this file itself (its form or size), not the chat or the send. */
function refusedFile(failure: TelegramFailure): boolean {
  return failure.kind === "telegram" && (failure.errorCode === 400 || failure.errorCode === 413);
}

/** Telegram may have received it: never sent again, and never named as missing. */
function ambiguous(failure: TelegramFailure): boolean {
  return failure.kind === "timeout" || failure.kind === "network_after_send";
}

/** Sends one planned file: its owner-authorized bytes under its cleaned name. */
export async function sendTelegramFile(input: Readonly<{
  outbound: Pick<TelegramOutbound, "sendFile">;
  chatId: number;
  owner: TelegramMessageRefOwner;
  userId: string;
  item: TelegramPlannedFile;
  read: TelegramFileReader;
  authorize?: TelegramFileAuthority;
}>): Promise<TelegramFileOutcome> {
  const { file, kind } = input.item;
  const data = await input.read({
    attachmentId: file.attachmentId, maxBytes: kind === "photo" ? TELEGRAM_PHOTO_MAX_BYTES : TELEGRAM_DOCUMENT_MAX_BYTES, userId: input.userId
  });
  if (!data) return { kind: "skipped" };
  const upload = { contentType: file.mimeType, data, filename: cleanTelegramFileName(file.fileName, file.mimeType) };
  const authority = input.authorize ? { authorize: input.authorize } : {};
  if (input.authorize && !(await input.authorize())) return { kind: "unreachable" };
  let delivery = await input.outbound.sendFile({ chatId: input.chatId, file: upload, kind, owner: input.owner, ...authority });
  // Telegram shows some images only as files (dimensions, format): the same file once more as a document.
  if (!delivery.ok && kind === "photo" && refusedFile(delivery.failure)) {
    if (input.authorize && !(await input.authorize())) return { kind: "unreachable" };
    delivery = await input.outbound.sendFile({ chatId: input.chatId, file: upload, kind: "document", owner: input.owner, ...authority });
  }
  if (delivery.ok) return { kind: "sent", messageIds: delivery.messageIds };
  if (delivery.failure.kind === "unreachable") return { kind: "unreachable" };
  return refusedFile(delivery.failure) ? { kind: "skipped" } : { kind: "failed", failure: delivery.failure };
}

/**
 * An answer's files after its final message, in order, then the one line
 * naming what stayed in AIQSA. A chat that refuses a send ends the files: the
 * rest is counted in that line. A chat that may no longer receive them
 * (`authorize`) ends them without that line.
 */
export async function deliverTelegramFiles(input: Readonly<{
  outbound: Pick<TelegramOutbound, "sendFile" | "sendText">;
  chatId: number;
  owner: TelegramMessageRefOwner;
  userId: string;
  files: readonly TelegramAnswerFile[];
  read: TelegramFileReader;
  /** Workspace outputs still exported after the wait, or whose export failed. */
  outputs?: "pending" | "failed";
  authorize?: TelegramFileAuthority;
}>): Promise<TelegramFilesResult> {
  const plan = planTelegramFiles(input.files);
  let sent = 0;
  let failed = 0;
  for (const [index, item] of plan.items.entries()) {
    const outcome = await sendTelegramFile({ ...input, item });
    if (outcome.kind === "sent") {
      sent += 1;
      continue;
    }
    if (outcome.kind === "skipped") {
      failed += 1;
      continue;
    }
    // The chat may no longer receive files: the rest stays in AIQSA, and nothing more goes there to name it.
    if (outcome.kind === "unreachable") return { failed: failed + plan.items.length - index, left: plan.left, sent };
    log({ code: telegramFailureCode(outcome.failure.kind, outcome.failure.errorCode), httpStatus: outcome.failure.status, outcome: "failed",
      stage: "dispatch" });
    if (ambiguous(outcome.failure)) continue;
    failed += plan.items.length - index;
    break;
  }
  if (failed > 0) log({ code: "telegram_file_failed", count: failed, outcome: "failed", stage: "dispatch" });
  const summary = telegramFilesSummaryText({ failed, left: plan.left, ...(input.outputs ? { outputs: input.outputs } : {}) });
  if (summary && (!input.authorize || await input.authorize())) {
    await input.outbound.sendText({
      chatId: input.chatId, owner: input.owner, text: summary, ...(input.authorize ? { authorize: input.authorize } : {})
    });
  }
  return { failed, left: plan.left, sent };
}

export type TelegramRunFiles = Readonly<{
  listener: TelegramRunListener;
  /** Resolves when no answer's files are being sent (tests and shutdown). */
  idle(): Promise<void>;
}>;

/** A run's Workspace outputs as its answer files wait for them. */
export type TelegramRunOutputs = Readonly<{
  exportState: TelegramRunExportReader;
  /** The run's answer files as AIQSA shows them now; null when the answer can no longer be read. */
  files(input: Readonly<{ runId: string; userId: string }>): Promise<readonly TelegramAnswerFile[] | null>;
}>;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * The generated files of every Telegram run, sent once its final message
 * reached Telegram (live or after a restart), while the run's link still
 * reaches its chat with access allowed: checked before the files and again
 * after every file's read. Files a Workspace run still exports are waited for
 * (bounded) and read anew.
 */
export function createTelegramRunFiles(deps: Readonly<{
  access: Pick<TelegramAccessResolver, "resolveTelegramAccess">;
  read: TelegramFileReader;
  outputs?: TelegramRunOutputs;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}>): TelegramRunFiles {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const pending = new Set<Promise<void>>();

  /** The answer's files once its Workspace outputs left their export, or as they are after the wait. */
  async function settledFiles(summaryFiles: readonly TelegramAnswerFile[], ids: Readonly<{ runId: string; userId: string }>): Promise<Readonly<{
    files: readonly TelegramAnswerFile[]; outputs?: "pending" | "failed";
  }>> {
    const outputs = deps.outputs;
    if (!outputs) return { files: summaryFiles };
    // A read that fails changes nothing: the files the answer already lists still go.
    const exportState = (fallback: TelegramRunExport) => outputs.exportState(ids).catch((error: unknown) => {
      log({ code: "telegram_file_unavailable", error, outcome: "degraded", stage: "read" });
      return fallback;
    });
    let state = await exportState("none");
    if (state === "none" || state === "complete" && summaryFiles.length > 0) return { files: summaryFiles };
    const deadline = now() + TELEGRAM_FILES_EXPORT_WAIT_MS;
    for (let delay = EXPORT_POLL_FIRST_MS; state === "pending" && now() + delay <= deadline; delay = Math.min(delay * 2, EXPORT_POLL_MAX_MS)) {
      await sleep(delay);
      state = await exportState("pending");
    }
    const files = await outputs.files(ids).catch(() => null) ?? summaryFiles;
    return { files, ...(state === "pending" || state === "failed" ? { outputs: state } : {}) };
  }

  async function send(summaryFiles: readonly TelegramAnswerFile[], context: TelegramRunEventContext): Promise<void> {
    const settled = await settledFiles(summaryFiles, { runId: context.runId, userId: context.userId });
    if (settled.files.length === 0 && !settled.outputs) return;
    // The run's link still reaches its chat (the same link, bot and chat) with Telegram access allowed.
    const reaches = async (): Promise<boolean> => {
      const access = await deps.access.resolveTelegramAccess(context.userId);
      return access.allowed && access.link.id === context.linkId && access.link.botId === context.bot.botId &&
        access.link.telegramChatId === context.telegramChatId;
    };
    if (!(await reaches())) return;
    await deliverTelegramFiles({
      // Asked again after every file's read and before its upload, and before the files line.
      authorize: reaches,
      chatId: context.telegramChatId, files: settled.files, outbound: context.bot.outbound,
      owner: { chatId: context.chatId, linkId: context.linkId, userId: context.userId }, read: deps.read, userId: context.userId,
      ...(settled.outputs ? { outputs: settled.outputs } : {})
    });
  }

  const listener: TelegramRunListener = (event, context) => {
    if (event.type !== "delivered" || !event.sent) return;
    const files = telegramAnswerFiles(event.artifactSummary);
    // A Workspace run's files may still be exported: only a run without that wait and without files ends here.
    if (files.length === 0 && !deps.outputs) return;
    const work = runInBackground(() => send(files, context)).catch((error: unknown) => {
      log({ code: "telegram_file_failed", error, outcome: "failed", stage: "dispatch" });
    });
    pending.add(work);
    void work.finally(() => pending.delete(work));
  };

  return Object.freeze({
    listener,
    async idle() {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    }
  });
}

/**
 * Sends the files of every Telegram run of this process; returns the
 * unsubscribe function. With `answer` (the bridge's read of a run's answer),
 * files a Workspace run still exports are waited for.
 */
export function registerTelegramRunFiles(deps: Readonly<{
  access: Pick<TelegramAccessResolver, "resolveTelegramAccess">;
  answer?: (input: Readonly<{ runId: string; userId: string }>) => Promise<Readonly<{ artifactSummary: ThreadArtifactSummary | null }> | null>;
  exportState?: TelegramRunExportReader;
  read?: TelegramFileReader;
}>): () => void {
  const { answer } = deps;
  const outputs: TelegramRunOutputs | undefined = answer ? {
    exportState: deps.exportState ?? defaultTelegramRunExportReader(),
    files: async (input) => {
      const read = await answer(input);
      return read ? telegramAnswerFiles(read.artifactSummary) : null;
    }
  } : undefined;
  return onTelegramRunEvent(createTelegramRunFiles({
    access: deps.access, read: deps.read ?? defaultTelegramFileReader(), ...(outputs ? { outputs } : {})
  }).listener);
}
