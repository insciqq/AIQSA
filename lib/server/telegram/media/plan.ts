import {
  DICTATION_AUDIO_MAX_BYTES, DICTATION_MAX_DURATION_MS, dictationAudioMimeType, type DictationAudioMimeType
} from "../../../contracts/speechToText";
import {
  isSafeUploadFileName, normalizedUploadMimeType, UPLOAD_FORMAT_REGISTRY, uploadFormatForExtension, type UploadFormatScope
} from "../../../domain/uploadFormats";
import type { TelegramMessage, TelegramPhotoSize } from "../botApi";
import { TELEGRAM_DOWNLOAD_MAX_BYTES } from "../transport";

/**
 * What a Telegram media message becomes before anything is downloaded
 * (D-17, D-18): a voice message or an audio file of a dictation type is
 * transcribed; a photo (its largest size Telegram serves) or a document is
 * uploaded as the user. Every check that needs only Telegram's own fields —
 * the declared length and size, the file type by name — refuses here, so a
 * refused message costs no download. The upload itself still runs the
 * product's full validation on the bytes.
 */

/** A voice message may last as long as a dictation. Telegram's `duration` is the sender's claim. */
export const TELEGRAM_VOICE_MAX_SECONDS = DICTATION_MAX_DURATION_MS / 1_000;
export const TELEGRAM_VOICE_MAX_BYTES = DICTATION_AUDIO_MAX_BYTES;
/** Telegram's `getFile` serves at most 20 MiB. */
export const TELEGRAM_FILE_MAX_BYTES = TELEGRAM_DOWNLOAD_MAX_BYTES;
const FILE_NAME_MAX_BYTES = 255;
const EXTENSION_MAX_LENGTH = 16;

export type TelegramMediaRefusal =
  | Readonly<{ reason: "voice_too_long" }>
  | Readonly<{ reason: "voice_too_large" }>
  | Readonly<{ reason: "file_too_large" }>
  | Readonly<{ reason: "unsupported_file"; workspaceHint: boolean }>;

export type TelegramMediaPlan =
  | Readonly<{ kind: "audio"; fileId: string; mimeType: DictationAudioMimeType; caption: string | null }>
  | Readonly<{
    kind: "attachment"; fileId: string; fileName: string; mimeType: string; scope: Extract<UploadFormatScope, "attachment" | "workspace">;
    maxBytes: number; caption: string | null;
  }>
  | Readonly<{ kind: "refused"; refusal: TelegramMediaRefusal }>;

export type TelegramMediaPlanOptions = Readonly<{
  /** The link's Workspace switch: uploads then take every file Workspace takes, as in the browser. */
  workspaceEnabled: boolean;
  /** The installation's upload cap (`AIQSA_UPLOAD_MAX_BYTES`). */
  uploadMaxBytes: number;
}>;

/** The file types an attachment may have without Workspace, as the refusal names them. */
export function telegramAttachmentTypeNames(): string[] {
  return [...new Set(UPLOAD_FORMAT_REGISTRY.filter((format) => format.scopes.includes("attachment"))
    .map((format) => format.extensions[0].slice(1).toUpperCase()))];
}

function caption(message: TelegramMessage): string | null {
  return message.caption?.trim() ? message.caption : null;
}

function overLimit(size: number | undefined, limit: number): boolean {
  return size !== undefined && size > limit;
}

/** The largest photo size Telegram serves (by pixels, the later one on a tie); null when every size is too large. */
export function largestTelegramPhoto(sizes: readonly TelegramPhotoSize[], maxBytes = TELEGRAM_FILE_MAX_BYTES): TelegramPhotoSize | null {
  let best: TelegramPhotoSize | null = null;
  for (const size of sizes) {
    if (overLimit(size.file_size, maxBytes)) continue;
    if (!best || size.width * size.height >= best.width * best.height) best = size;
  }
  return best;
}

function extensionForMime(mimeType: string | undefined): string {
  const normalized = mimeType ? normalizedUploadMimeType(mimeType) : undefined;
  if (!normalized || normalized === "application/octet-stream") return "";
  return UPLOAD_FORMAT_REGISTRY.find((format) => format.mimeTypes.includes(normalized))?.extensions[0] ?? "";
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = "";
  for (const char of value) {
    if (Buffer.byteLength(result + char, "utf8") > maxBytes) break;
    result += char;
  }
  return result;
}

/**
 * A document's own name, made a safe upload name: no control characters or
 * path separators, single spaces, at most 255 bytes with its extension kept.
 * A document without a usable name is `document-<file_unique_id>` with the
 * extension its declared type implies.
 */
export function cleanTelegramFileName(raw: string | undefined, uniqueId: string, mimeType?: string): string {
  let name = (raw ?? "").normalize("NFC").replace(/\s+/gu, " ").replace(/[\u0000-\u001f\u007f/\\]+/gu, "_").trim();
  if (/^\.*$/u.test(name)) name = `document-${safeId(uniqueId)}${extensionForMime(mimeType)}`;
  if (Buffer.byteLength(name, "utf8") > FILE_NAME_MAX_BYTES) {
    const dot = name.lastIndexOf(".");
    const extension = dot > 0 && name.length - dot <= EXTENSION_MAX_LENGTH ? name.slice(dot) : "";
    const stem = truncateUtf8(extension ? name.slice(0, dot) : name, FILE_NAME_MAX_BYTES - Buffer.byteLength(extension, "utf8")).trim();
    name = `${stem}${extension}`;
  }
  return isSafeUploadFileName(name) ? name : `document-${safeId(uniqueId)}${extensionForMime(mimeType)}`;
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 64) || "file";
}

/** The photo's upload name: the format is chosen by extension and Telegram photos are JPEG. */
export function telegramPhotoFileName(uniqueId: string): string {
  return `photo-${safeId(uniqueId)}.jpg`;
}

function audioPlan(
  input: Readonly<{ fileId: string; fileSize?: number; duration?: number; mimeType: DictationAudioMimeType }>, message: TelegramMessage
): TelegramMediaPlan {
  if (input.duration !== undefined && input.duration > TELEGRAM_VOICE_MAX_SECONDS) return { kind: "refused", refusal: { reason: "voice_too_long" } };
  if (overLimit(input.fileSize, TELEGRAM_VOICE_MAX_BYTES)) return { kind: "refused", refusal: { reason: "voice_too_large" } };
  return { caption: caption(message), fileId: input.fileId, kind: "audio", mimeType: input.mimeType };
}

function attachmentPlan(
  input: Readonly<{ fileId: string; fileSize?: number; fileName: string; mimeType?: string }>, message: TelegramMessage,
  options: TelegramMediaPlanOptions
): TelegramMediaPlan {
  const maxBytes = Math.min(TELEGRAM_FILE_MAX_BYTES, options.uploadMaxBytes);
  if (overLimit(input.fileSize, maxBytes)) return { kind: "refused", refusal: { reason: "file_too_large" } };
  const scope = options.workspaceEnabled ? "workspace" : "attachment";
  const format = uploadFormatForExtension(input.fileName, scope);
  // Without Workspace only attachment types are taken; with it, the upload decides as the browser's does.
  if (!format && scope === "attachment") return { kind: "refused", refusal: { reason: "unsupported_file", workspaceHint: true } };
  const declared = input.mimeType ? normalizedUploadMimeType(input.mimeType) : undefined;
  // Telegram's type is its guess from the name: a type the format does not list is left to the content check.
  const mimeType = format ? format.canonicalMimeType : declared ?? "application/octet-stream";
  return { caption: caption(message), fileId: input.fileId, fileName: input.fileName, kind: "attachment", maxBytes, mimeType, scope };
}

/** The plan for a media message; null for a message that carries no media AIQSA takes. */
export function planTelegramMedia(message: TelegramMessage, options: TelegramMediaPlanOptions): TelegramMediaPlan | null {
  if (message.has_other_content) return null;
  if (message.voice) {
    const voice = message.voice;
    return audioPlan({
      duration: voice.duration, fileId: voice.file_id, fileSize: voice.file_size,
      mimeType: dictationAudioMimeType(voice.mime_type ?? "audio/ogg") ?? "audio/ogg"
    }, message);
  }
  if (message.audio) {
    const audio = message.audio;
    const mimeType = audio.mime_type ? dictationAudioMimeType(audio.mime_type) : null;
    if (mimeType) return audioPlan({ duration: audio.duration, fileId: audio.file_id, fileSize: audio.file_size, mimeType }, message);
    return attachmentPlan({
      fileId: audio.file_id, fileName: cleanTelegramFileName(audio.file_name, audio.file_unique_id, audio.mime_type),
      fileSize: audio.file_size, ...(audio.mime_type ? { mimeType: audio.mime_type } : {})
    }, message, options);
  }
  if (message.document) {
    const document = message.document;
    const fileName = cleanTelegramFileName(document.file_name, document.file_unique_id, document.mime_type);
    const audioType = document.mime_type ? dictationAudioMimeType(document.mime_type) : null;
    // A recording sent as a file is transcribed like an audio message, unless its name makes it an attachment.
    if (audioType && !uploadFormatForExtension(fileName, "attachment")) {
      return audioPlan({ fileId: document.file_id, fileSize: document.file_size, mimeType: audioType }, message);
    }
    return attachmentPlan({
      fileId: document.file_id, fileName, fileSize: document.file_size, ...(document.mime_type ? { mimeType: document.mime_type } : {})
    }, message, options);
  }
  if (message.photo && message.photo.length > 0) {
    const photo = largestTelegramPhoto(message.photo, Math.min(TELEGRAM_FILE_MAX_BYTES, options.uploadMaxBytes));
    if (!photo) return { kind: "refused", refusal: { reason: "file_too_large" } };
    return attachmentPlan({
      fileId: photo.file_id, fileName: telegramPhotoFileName(photo.file_unique_id), fileSize: photo.file_size, mimeType: "image/jpeg"
    }, message, options);
  }
  return null;
}
