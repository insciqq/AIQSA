import type { ThreadArtifactSummary } from "../../contracts/chats";
import type { ContentBlock } from "../../domain/content";
import { uploadFormatForExtension } from "../../domain/uploadFormats";
import { cleanTelegramFileName as cleanOutgoingFileName, telegramAnswerFiles, type TelegramFileReader } from "../telegram/files";
import { cleanTelegramFileName as cleanIncomingFileName } from "../telegram/media/plan";
import type { DiscordAnswerFilesHook } from "./bridge/answer";
import type { DiscordAttachmentHook } from "./bridge/context";
import { logDiscordBridgeFailure } from "./bridge/journal";
import type { DiscordContextAttachment, DiscordContextMessage } from "./bridge/messages";
import type { DiscordUploads } from "./bridge/uploads";
import { DISCORD_ATTACHMENT_COPY, discordAttachmentsNotAddedText, discordEarlierAttachmentsNamedText, discordFilesOnlyInAiqsaText } from "./copy";
import { redactOutgoing } from "./redaction";
import type { DiscordRest } from "./rest";
import {
  DISCORD_DOWNLOAD_MAX_BYTES, DISCORD_FILE_MAX_BYTES, DISCORD_UPLOAD_FILES_MAX, DISCORD_UPLOAD_MAX_BYTES, type DiscordDownloadResult,
  type DiscordTransport,
  type DiscordUploadFile
} from "./transport";

/**
 * Files between Discord and AIQSA (PRD D-24, O-18, O-33).
 *
 * In: a turn's attachments go into the ordinary upload as the service account
 * and reach the run as image and file blocks. Images take a budget of ten by
 * priority: every image of the question (the trigger and the messages joined
 * to it) and of the message it replies to, however many, then images of the
 * included history from the newest while the budget lasts. Other files of the
 * allowed attachment formats take up to ten the same way. The run's own
 * attachment allowance (`lib/server/runs/attachmentLimits.ts`: count and
 * bytes of one message, one place kept for the history file) bounds the whole
 * set, history images going first, so admission never refuses the turn for
 * them. Bytes come from Discord's CDN through the Discord transport (at most
 * 20 MiB and the upload cap); an expired signed URL is renewed by reading the
 * message again through REST, never through `attachments/refresh-urls`.
 * Everything not added stays named in the turn's text, and the question's and
 * reference's leftovers and refused uploads get a short line why.
 *
 * Out: an answer's generated images, then its other generated files, read
 * through the download route's authority as their owner, go with the final
 * message: at most ten, each up to 20 MiB, together up to 25 MiB, names
 * cleaned and redacted; the rest is "N files are only in AIQSA". Logs carry
 * codes only, never names, URLs or content.
 */

export const DISCORD_TURN_IMAGES_MAX = 10;
export const DISCORD_TURN_FILES_MAX = 10;
/** Places of the run's attachment allowance kept for the history file a long thread adds (`discord-history.md`). */
export const DISCORD_HISTORY_FILE_RESERVE = 1;
/** Downloads and uploads at once per turn: each holds up to 20 MiB. */
export const DISCORD_TRANSFER_CONCURRENCY = 2;
/** A signed URL this close to its expiry is renewed before the download. */
const EXPIRY_MARGIN_MS = 30_000;
const NOTE_NAMES_MAX = 20;
const NOTE_NAME_MAX_CHARS = 120;

/** Every code this module logs; all registered in the failure-code registry. */
export const DISCORD_FILE_LOG_CODES = [
  "discord_attachment_download_failed",
  "discord_attachment_upload_refused",
  "discord_file_unavailable"
] as const;

// ---------------------------------------------------------------------------
// In

export type DiscordAttachmentLimits = Readonly<{
  /** The installation's upload cap (`AIQSA_UPLOAD_MAX_BYTES`). */
  uploadMaxBytes: number;
  /** Attachments one run message may carry (`AIQSA_RUN_ATTACHMENT_MAX_COUNT`). */
  runMaxCount: number;
  /** Their bytes together (the run's materialization and encoding bounds). */
  runMaxBytes: number;
}>;

type Origin = "question" | "reference" | "history";
type NotAdded = "too_large" | "unsupported" | "over_limit" | "unreadable";

type Candidate = Readonly<{
  message: DiscordContextMessage;
  attachment: DiscordContextAttachment;
  origin: Origin;
  kind: "image" | "file";
  fileName: string;
  mimeType: string;
  /** The declared size, or the bound when Discord did not say. */
  bytes: number;
  maxBytes: number;
}>;

type Skipped = Readonly<{ origin: Origin; name: string; reason: NotAdded }>;

const ORIGIN_RANK: Readonly<Record<Origin, number>> = { question: 0, reference: 1, history: 2 };
/** Which attachment the run's allowance takes out first (lowest first). */
const DROP_ORDER: Readonly<Record<Origin, Readonly<Record<"image" | "file", number>>>> = {
  history: { file: 1, image: 0 }, reference: { file: 2, image: 4 }, question: { file: 3, image: 5 }
};

function displayName(attachment: DiscordContextAttachment): string {
  return attachment.filename.length > NOTE_NAME_MAX_CHARS ? `${attachment.filename.slice(0, NOTE_NAME_MAX_CHARS)}…` : attachment.filename;
}

/** What one attachment would be as an upload: its kind, safe name and type, or why it is only named. */
function classify(attachment: DiscordContextAttachment, maxBytes: number):
  Readonly<{ kind: "image" | "file"; fileName: string; mimeType: string }> | NotAdded {
  const fileName = cleanIncomingFileName(attachment.filename, attachment.id, attachment.contentType ?? undefined);
  const format = uploadFormatForExtension(fileName, "attachment");
  if (!format) return "unsupported";
  if (attachment.size !== null && attachment.size > maxBytes) return "too_large";
  return { fileName, kind: format.kind === "image" ? "image" : "file", mimeType: format.canonicalMimeType };
}

/** The signed URL's expiry (`ex`, hexadecimal seconds); null when it names none. */
function expiresAt(url: string): number | null {
  try {
    const ex = new URL(url).searchParams.get("ex");
    return ex && /^[0-9a-f]{1,12}$/iu.test(ex) ? Number.parseInt(ex, 16) * 1_000 : null;
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** The attachments' current URLs of a message read again, by attachment id. */
function attachmentUrls(message: unknown): Map<string, string> {
  const urls = new Map<string, string>();
  const list = record(message)?.attachments;
  if (!Array.isArray(list)) return urls;
  for (const entry of list.slice(0, 25)) {
    const attachment = record(entry);
    const url = typeof attachment?.url === "string" ? attachment.url : typeof attachment?.proxy_url === "string" ? attachment.proxy_url : null;
    if (typeof attachment?.id === "string" && url) urls.set(attachment.id, url);
  }
  return urls;
}

/**
 * The turn's attachments by priority within the budgets and the run's allowance, and what is left out.
 * History is newest first here; the blocks go out in the text's order.
 */
export function planDiscordAttachments(input: Readonly<{
  question: readonly DiscordContextMessage[];
  reference: DiscordContextMessage | null;
  history: readonly DiscordContextMessage[];
  limits: DiscordAttachmentLimits;
}>): Readonly<{ selected: Candidate[]; skipped: Skipped[] }> {
  const maxBytes = Math.max(0, Math.min(input.limits.uploadMaxBytes, DISCORD_DOWNLOAD_MAX_BYTES));
  const seenMessages = new Set<string>();
  const seenAttachments = new Set<string>();
  const ordered: Array<Readonly<{ message: DiscordContextMessage; origin: Origin }>> = [];
  const add = (message: DiscordContextMessage, origin: Origin) => {
    if (seenMessages.has(message.id)) return;
    seenMessages.add(message.id);
    ordered.push({ message, origin });
  };
  for (const message of input.question) add(message, "question");
  if (input.reference) add(input.reference, "reference");
  for (const message of [...input.history].reverse()) add(message, "history");

  const skipped: Skipped[] = [];
  const images: Candidate[] = [];
  const files: Candidate[] = [];
  for (const { message, origin } of ordered) {
    for (const attachment of message.attachments) {
      if (seenAttachments.has(attachment.id)) continue;
      seenAttachments.add(attachment.id);
      const kind = classify(attachment, maxBytes);
      if (typeof kind === "string") {
        skipped.push({ name: displayName(attachment), origin, reason: kind });
        continue;
      }
      const candidate: Candidate = { ...kind, attachment, bytes: attachment.size ?? maxBytes, maxBytes, message, origin };
      (kind.kind === "image" ? images : files).push(candidate);
    }
  }

  // The question's and the reference's images are never cut by the budget; history's fill what is left.
  const keptImages = images.filter((candidate, index) => candidate.origin !== "history" || index < DISCORD_TURN_IMAGES_MAX);
  const keptFiles = files.slice(0, DISCORD_TURN_FILES_MAX);
  for (const candidate of [...images, ...files]) {
    if (!keptImages.includes(candidate) && !keptFiles.includes(candidate)) {
      skipped.push({ name: displayName(candidate.attachment), origin: candidate.origin, reason: "over_limit" });
    }
  }

  // The run's allowance: what goes first is history's images (oldest first), then history's files,
  // then the reference's and the question's files, and their images only last.
  const dropOrder = (candidate: Candidate) => DROP_ORDER[candidate.origin][candidate.kind];
  let selected = [...keptImages, ...keptFiles];
  const maxCount = Math.max(0, input.limits.runMaxCount - DISCORD_HISTORY_FILE_RESERVE);
  const total = (list: readonly Candidate[]) => list.reduce((sum, candidate) => sum + candidate.bytes, 0);
  while (selected.length > 0 && (selected.length > maxCount || total(selected) > input.limits.runMaxBytes)) {
    // Within one rank the lowest priority (latest in `selected`) goes first.
    let victim = selected[selected.length - 1]!;
    for (const candidate of selected) if (dropOrder(candidate) <= dropOrder(victim)) victim = candidate;
    selected = selected.filter((candidate) => candidate !== victim);
    skipped.push({ name: displayName(victim.attachment), origin: victim.origin, reason: "over_limit" });
  }
  return { selected, skipped };
}

type Transferred =
  | Readonly<{ ok: true; block: ContentBlock }>
  | Readonly<{ ok: false; reason: NotAdded }>
  | Readonly<{ ok: false; code: string }>;

async function pool<T, R>(items: readonly T[], concurrency: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function lines(skipped: readonly Skipped[], refused: ReadonlyMap<string, string[]>): string[] {
  const notes: string[] = [];
  const named = (reason: NotAdded) => skipped.filter((entry) => entry.origin !== "history" && entry.reason === reason).map((entry) => entry.name);
  const reasons: ReadonlyArray<readonly [NotAdded, string]> = [
    ["too_large", DISCORD_ATTACHMENT_COPY.tooLarge], ["unsupported", DISCORD_ATTACHMENT_COPY.unsupported],
    ["over_limit", DISCORD_ATTACHMENT_COPY.overLimit], ["unreadable", DISCORD_ATTACHMENT_COPY.unreadable]
  ];
  for (const [reason, text] of reasons) {
    const names = named(reason);
    if (names.length > 0) notes.push(discordAttachmentsNotAddedText(text, names.slice(0, NOTE_NAMES_MAX), names.length));
  }
  for (const [code, names] of refused) {
    notes.push(discordAttachmentsNotAddedText(`${DISCORD_ATTACHMENT_COPY.uploadRefused} ${code}`, names.slice(0, NOTE_NAMES_MAX), names.length));
  }
  const earlier = skipped.filter((entry) => entry.origin === "history" && entry.reason !== "unsupported").length;
  if (earlier > 0) notes.push(discordEarlierAttachmentsNamedText(earlier));
  return notes;
}

/** The attachment hook: the turn's files uploaded as the service account and added as blocks (`deps.attachments`). */
export function createDiscordAttachments(deps: Readonly<{
  uploads: DiscordUploads;
  download: DiscordTransport["download"];
  rest: () => DiscordRest;
  limits: () => DiscordAttachmentLimits;
  now?: () => number;
  concurrency?: number;
}>): DiscordAttachmentHook {
  const now = deps.now ?? Date.now;
  return async (input) => {
    const plan = planDiscordAttachments({ ...input, limits: deps.limits() });
    if (plan.selected.length === 0) {
      const notes = lines(plan.skipped, new Map());
      return { blocks: [], notes };
    }
    // One fresh read per message, shared by its attachments.
    const reread = new Map<string, Promise<Map<string, string>>>();
    const freshUrl = async (candidate: Candidate): Promise<string | null> => {
      const { message } = candidate;
      let read = reread.get(message.id);
      if (!read) {
        read = deps.rest().getChannelMessage(message.channelId, message.id)
          .then((answer) => (answer.ok ? attachmentUrls(answer.value) : new Map<string, string>()), () => new Map<string, string>());
        reread.set(message.id, read);
      }
      return (await read).get(candidate.attachment.id) ?? null;
    };

    const fetchBytes = async (candidate: Candidate): Promise<Readonly<{ ok: true; data: Buffer }> | Readonly<{ ok: false; reason: NotAdded }>> => {
      let url = candidate.attachment.url ?? candidate.attachment.proxyUrl;
      let renewed = false;
      const expiry = url ? expiresAt(url) : null;
      if (!url || (expiry !== null && expiry <= now() + EXPIRY_MARGIN_MS)) {
        url = await freshUrl(candidate);
        renewed = true;
      }
      for (;;) {
        if (!url) return { ok: false, reason: "unreadable" };
        const result: DiscordDownloadResult | null = await deps.download({ maxBytes: candidate.maxBytes, url }).catch(() => null);
        if (result && result.ok) return { data: result.body, ok: true };
        if (result && !result.ok && result.kind === "too_large") return { ok: false, reason: "too_large" };
        // An expired or revoked signature answers 403 or 404: the message read again carries a fresh one.
        if (!renewed && result && !result.ok && result.kind === "http" &&
          (result.status === 403 || result.status === 404 || result.status === 410)) {
          url = await freshUrl(candidate);
          renewed = true;
          continue;
        }
        logDiscordBridgeFailure({ code: "discord_attachment_download_failed", outcome: "skipped" });
        return { ok: false, reason: "unreadable" };
      }
    };

    const transfer = async (candidate: Candidate): Promise<Transferred> => {
      const bytes = await fetchBytes(candidate);
      if (!bytes.ok) return bytes;
      const uploaded = await deps.uploads.uploadFile({
        data: bytes.data, fileName: candidate.fileName, mimeType: candidate.mimeType, userId: input.userId
      }).catch(() => ({ code: "discord_upload_failed", ok: false as const }));
      if (uploaded.ok) return uploaded;
      logDiscordBridgeFailure({ code: "discord_attachment_upload_refused", outcome: "skipped" });
      return { code: uploaded.code, ok: false };
    };

    const results = await pool(plan.selected, deps.concurrency ?? DISCORD_TRANSFER_CONCURRENCY, transfer);
    const skipped = [...plan.skipped];
    const refused = new Map<string, string[]>();
    const added: Array<Readonly<{ candidate: Candidate; block: ContentBlock }>> = [];
    results.forEach((result, index) => {
      const candidate = plan.selected[index]!;
      if (result.ok) added.push({ block: result.block, candidate });
      else if ("reason" in result) skipped.push({ name: displayName(candidate.attachment), origin: candidate.origin, reason: result.reason });
      else refused.set(result.code, [...(refused.get(result.code) ?? []), displayName(candidate.attachment)]);
    });
    // The text's order: history oldest first, then the reference, then the question.
    const position = (candidate: Candidate) => -ORIGIN_RANK[candidate.origin];
    added.sort((left, right) => position(left.candidate) - position(right.candidate) ||
      (left.candidate.message.id === right.candidate.message.id ? 0
        : BigInt(left.candidate.message.id) < BigInt(right.candidate.message.id) ? -1 : 1));
    return { blocks: added.map((entry) => entry.block), notes: lines(skipped, refused) };
  };
}

// ---------------------------------------------------------------------------
// Out

/** What the files hook reads an answer's files with: their bytes under the owner's download authority. */
export type DiscordFileReader = TelegramFileReader;

/** The name Discord shows: cleaned like Telegram's, then with every secret in its stem redacted, the extension kept. */
export function discordOutgoingFileName(fileName: string, mimeType: string): string {
  const cleaned = cleanOutgoingFileName(fileName, mimeType);
  const extension = /\.[A-Za-z0-9]{1,15}$/u.exec(cleaned)?.[0] ?? "";
  const stem = extension && cleaned.length > extension.length ? cleaned.slice(0, -extension.length) : cleaned;
  return `${redactOutgoing(stem).text}${stem === cleaned ? "" : extension}`;
}

/** An answer's files as they go: images first (generated, then other images), then the rest, each once. */
export function discordAnswerFileList(summary: Pick<ThreadArtifactSummary, "generatedFiles" | "generatedImages"> | null | undefined) {
  const files = telegramAnswerFiles(summary);
  return [...files.filter((file) => file.mimeType.startsWith("image/")), ...files.filter((file) => !file.mimeType.startsWith("image/"))];
}

/** The files hook (`deps.answerFiles`): up to ten files within Discord's bounds, the rest named by count. */
export function createDiscordAnswerFiles(deps: Readonly<{ read: DiscordFileReader }>): DiscordAnswerFilesHook {
  return async ({ answer, userId }) => {
    const list = discordAnswerFileList(answer.artifactSummary);
    if (list.length === 0) return { files: [], note: null };
    const files: DiscordUploadFile[] = [];
    let total = 0;
    let left = 0;
    for (const file of list) {
      const size = file.byteSize;
      if (files.length >= DISCORD_UPLOAD_FILES_MAX || !Number.isSafeInteger(size) || size < 1 || size > DISCORD_FILE_MAX_BYTES ||
        total + size > DISCORD_UPLOAD_MAX_BYTES) {
        left += 1;
        continue;
      }
      const data = await deps.read({ attachmentId: file.attachmentId, maxBytes: size, userId }).catch((error: unknown) => {
        logDiscordBridgeFailure({ code: "discord_file_unavailable", error, outcome: "degraded", stage: "settle" });
        return null;
      });
      if (!data || data.length !== size) {
        left += 1;
        continue;
      }
      files.push({ contentType: file.mimeType, data, filename: discordOutgoingFileName(file.fileName, file.mimeType) });
      total += size;
    }
    return {
      fallbackNote: files.length > 0 ? discordFilesOnlyInAiqsaText(list.length) : null,
      files,
      note: left > 0 ? discordFilesOnlyInAiqsaText(left) : null
    };
  };
}
