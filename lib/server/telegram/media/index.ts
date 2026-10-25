import type { ContentBlock } from "../../../domain/content";
import { logEvent } from "../../observability";
import type { TranscribeUserAudioResult, TranscriptionRefusal, UserAudio } from "../../speechToText/transcribeUserAudio";
import type { TelegramMessage } from "../botApi";
import type { TelegramConversation } from "../bridge/conversation";
import { telegramFailureCode } from "../codes";
import {
  TELEGRAM_COPY, TELEGRAM_MEDIA_COPY, TELEGRAM_RUN_REFUSAL_COPY, telegramReasonText, telegramUnsupportedFileText,
  telegramUsageLimitText, telegramVoiceRateLimitedText, telegramVoiceTranscriptText
} from "../copy";
import type { TelegramMessageContext, TelegramMessageHandler } from "../dispatcher";
import { splitTelegramText, type TelegramKeyboard } from "../outbound";
import { planTelegramMedia, telegramAttachmentTypeNames, TELEGRAM_VOICE_MAX_BYTES, type TelegramMediaPlan, type TelegramMediaRefusal } from "./plan";

/**
 * Voice messages, audio files, photos, documents and albums from Telegram
 * (D-17, D-18). The handler answers what it refuses at once and otherwise
 * puts the message's content, still being prepared, into the chat's merge
 * window, so the chat's later updates never wait for a download and an
 * album's photos, arriving as separate messages, become one request:
 * - voice and audio of a dictation type: downloaded only once the shared
 *   Speech to text path admitted the attempt, transcribed, shown back as a
 *   quote, then sent as the user's text (after the caption);
 * - photos and documents: downloaded within Telegram's bound, uploaded as the
 *   linked user through the product's upload handler (its full type, content
 *   and size checks), awaited until processed, then sent as image or file
 *   blocks after the caption.
 * A refused part adds nothing to the request and says why, with the action
 * that helps (`/settings`, or doing it in AIQSA). Content is never logged.
 */

export const TELEGRAM_MEDIA_READY_TIMEOUT_MS = 90_000;
/** Downloads and uploads at once, bot-wide: each holds up to 20 MiB, and uploads share the product's upload permits. */
export const TELEGRAM_MEDIA_TRANSFER_CONCURRENCY = 2;
const READY_POLL_FIRST_MS = 250;
const READY_POLL_MAX_MS = 3_000;
const UPLOAD_BUSY_ATTEMPTS = 4;
/** One quote message of a transcript stays well inside a rich message. */
const TRANSCRIPT_CHUNK_LENGTH = 3_500;
const UPLOAD_URL = "http://localhost/api/uploads";

/** Log codes media adds; all registered in the failure-code registry. */
export const TELEGRAM_MEDIA_LOG_CODES = [
  "telegram_media_download_failed",
  "telegram_media_failed",
  "telegram_media_not_ready",
  "telegram_media_upload_refused",
  "telegram_voice_refused"
] as const;

export type TelegramMediaServices = Readonly<{
  /** The shared Speech to text path; `audio` is read only once the attempt is admitted. */
  transcribe(input: Readonly<{ userId: string; audio: () => Promise<UserAudio | TranscriptionRefusal> }>): Promise<TranscribeUserAudioResult>;
  /** The product's upload handler, called in process as the linked user. */
  upload(input: Readonly<{ userId: string; request: Request }>): Promise<Response>;
  /** The user's own attachment's processing status; null when it is gone. */
  attachmentStatus(input: Readonly<{ userId: string; attachmentId: string }>): Promise<string | null>;
  uploadMaxBytes(): number;
}>;

export type TelegramMediaDeps = Readonly<{
  conversation: Pick<TelegramConversation, "queue">;
  /** Loaded on the first media message, so starting the bot never loads the upload and speech stacks. */
  services: () => Promise<TelegramMediaServices>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  readyTimeoutMs?: number;
  transferConcurrency?: number;
}>;

type UploadedAttachment = Readonly<{ id: string; kind: string; status: string; fileName: string }>;
type Refusal = Readonly<{ text: string; keyboard?: "settings" }>;

/** Content-free: stable codes and statuses only. */
function log(fields: Readonly<{ code: string; error?: unknown; httpStatus?: number; outcome: "failed" | "skipped" }>): void {
  logEvent("service_operation", {
    code: fields.code, ...(fields.error ? { error: fields.error } : {}), ...(fields.httpStatus ? { httpStatus: fields.httpStatus } : {}),
    outcome: fields.outcome, stage: "process", subsystem: "telegram"
  });
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function createLimiter(limit: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function limited<T>(task: () => Promise<T>): Promise<T> {
    while (active >= limit) await new Promise<void>((resolve) => { waiting.push(resolve); });
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

function captionBlocks(caption: string | null): ContentBlock[] {
  return caption ? [{ text: caption, type: "text" }] : [];
}

function planRefusal(refusal: TelegramMediaRefusal): Refusal {
  switch (refusal.reason) {
    case "voice_too_long": return { text: telegramReasonText("telegram_voice_too_long")! };
    case "voice_too_large": return { text: TELEGRAM_MEDIA_COPY.voiceTooLarge };
    case "file_too_large": return { text: telegramReasonText("telegram_file_too_large")! };
    case "unsupported_file": return {
      ...(refusal.workspaceHint ? { keyboard: "settings" as const } : {}),
      text: telegramUnsupportedFileText(telegramAttachmentTypeNames(), refusal.workspaceHint)
    };
  }
}

function planRefusalCode(refusal: TelegramMediaRefusal): string {
  switch (refusal.reason) {
    case "voice_too_long": return "telegram_voice_too_long";
    case "voice_too_large":
    case "file_too_large": return "telegram_file_too_large";
    case "unsupported_file": return "telegram_unsupported_message";
  }
}

function voiceRefusal(result: TranscriptionRefusal, downloadFailed: boolean): Refusal {
  if ("usageLimit" in result) {
    return {
      text: telegramUsageLimitText({
        code: result.refusal, limit: result.usageLimit.limit, retryAfterSeconds: result.retryAfterSeconds, window: result.usageLimit.window
      })
    };
  }
  switch (result.refusal) {
    case "dictation_unavailable": return { text: telegramReasonText("telegram_voice_unavailable")! };
    case "dictation_rate_limited": return { text: telegramVoiceRateLimitedText(result.retryAfterSeconds) };
    case "usage_limits_unavailable": return { text: TELEGRAM_RUN_REFUSAL_COPY.usageUnavailable };
    case "audio_too_large": return { text: TELEGRAM_MEDIA_COPY.voiceTooLarge };
    case "audio_required": return { text: downloadFailed ? TELEGRAM_MEDIA_COPY.fileUnreadable : TELEGRAM_MEDIA_COPY.voiceUnreadable };
    case "audio_type_unsupported": return { text: TELEGRAM_MEDIA_COPY.voiceUnreadable };
    default: return { text: TELEGRAM_MEDIA_COPY.voiceFailed };
  }
}

/** The product upload's refusal codes as the bot says them. */
function uploadRefusal(code: string, status: number, workspaceEnabled: boolean): Refusal {
  switch (code) {
    case "file_too_large":
    case "image_limit_exceeded": return { text: telegramReasonText("telegram_file_too_large")! };
    case "unsupported_type":
    case "file_required": return planRefusal({ reason: "unsupported_file", workspaceHint: !workspaceEnabled });
    case "workspace_runtime_unavailable": return { keyboard: "settings", text: TELEGRAM_RUN_REFUSAL_COPY.workspaceUnavailable };
    case "pdf_invalid": return { text: TELEGRAM_MEDIA_COPY.pdfInvalid };
    case "pdf_page_limit_exceeded": return { text: TELEGRAM_MEDIA_COPY.pdfTooManyPages };
    case "upload_busy": return { text: TELEGRAM_MEDIA_COPY.uploadBusy };
    default: return status === 401 ? { text: telegramReasonText("telegram_access_off")! } : { text: TELEGRAM_MEDIA_COPY.fileFailed };
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uploadedAttachment(body: unknown): UploadedAttachment | null {
  const attachment = record(body) ? body.attachment : null;
  if (!record(attachment)) return null;
  const { fileName, id, kind, status } = attachment;
  return typeof id === "string" && id && typeof kind === "string" && typeof status === "string" && typeof fileName === "string"
    ? { fileName, id, kind, status }
    : null;
}

type Download = Readonly<{ ok: true; data: Buffer }> | Readonly<{ ok: false; tooLarge: boolean }>;

export function createTelegramMediaHandler(deps: TelegramMediaDeps): TelegramMessageHandler {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const readyTimeoutMs = deps.readyTimeoutMs ?? TELEGRAM_MEDIA_READY_TIMEOUT_MS;
  const transfer = createLimiter(deps.transferConcurrency ?? TELEGRAM_MEDIA_TRANSFER_CONCURRENCY);

  async function say(context: TelegramMessageContext, refusal: Refusal): Promise<void> {
    const keyboard: TelegramKeyboard | undefined = refusal.keyboard === "settings"
      ? [[{ callback: { kind: "open_settings" }, text: TELEGRAM_COPY.openSettings }]]
      : undefined;
    try {
      await context.bot.outbound.sendText({
        chatId: context.message.chat.id, replyTo: context.message.message_id, text: refusal.text,
        ...(keyboard ? { keyboard, linkId: context.link.id } : {})
      });
    } catch (error) {
      log({ code: "telegram_notice_failed", error, outcome: "failed" });
    }
  }

  /** One file from Telegram within `maxBytes`: the declared size, then the download's own bound. */
  async function download(context: TelegramMessageContext, fileId: string, maxBytes: number): Promise<Download> {
    const { api } = context.bot;
    const file = await api.getFile(fileId);
    if (!file.ok) {
      log({ code: telegramFailureCode(file.kind, file.errorCode), httpStatus: file.status, outcome: "failed" });
      // Telegram refuses `getFile` above its 20 MB bound.
      return { ok: false, tooLarge: file.kind === "telegram" && file.errorCode === 400 && /too big/iu.test(file.description ?? "") };
    }
    if (file.result.file_size !== undefined && file.result.file_size > maxBytes) return { ok: false, tooLarge: true };
    if (!file.result.file_path) {
      log({ code: "telegram_media_download_failed", outcome: "failed" });
      return { ok: false, tooLarge: false };
    }
    const outcome = await api.downloadFile(file.result.file_path, { maxBytes });
    if (!outcome.ok) {
      log({ code: "telegram_media_download_failed", httpStatus: outcome.status, outcome: "failed" });
      return { ok: false, tooLarge: outcome.kind === "too_large" };
    }
    return outcome.result.length > maxBytes ? { ok: false, tooLarge: true } : { ok: true, data: outcome.result };
  }

  /** The transcript as a quote, replying to the voice message; rich so Telegram detects nothing in it. */
  async function quoteTranscript(context: TelegramMessageContext, transcript: string): Promise<void> {
    const chunks = splitTelegramText(telegramVoiceTranscriptText(transcript), TRANSCRIPT_CHUNK_LENGTH);
    for (const [index, chunk] of chunks.entries()) {
      const reply = index === 0 ? { reply_parameters: { allow_sending_without_reply: true, message_id: context.message.message_id } } : {};
      const sent = await context.bot.api.sendRichMessage({
        chat_id: context.message.chat.id,
        rich_message: { blocks: [{ blocks: [{ text: chunk, type: "paragraph" }], type: "blockquote" }], skip_entity_detection: true },
        ...reply
      });
      if (sent.ok) continue;
      log({ code: telegramFailureCode(sent.kind, sent.errorCode), httpStatus: sent.status, outcome: "failed" });
      if (sent.kind !== "telegram" || sent.errorCode !== 400) return;
      const plain = await context.bot.outbound.sendText({ chatId: context.message.chat.id, text: chunk, ...(index === 0 ? { replyTo: context.message.message_id } : {}) });
      if (!plain.ok) return;
    }
  }

  async function prepareAudio(
    context: TelegramMessageContext, services: TelegramMediaServices, plan: Extract<TelegramMediaPlan, { kind: "audio" }>
  ): Promise<ContentBlock[]> {
    let downloadFailed = false;
    const result = await services.transcribe({
      async audio() {
        const file = await transfer(() => download(context, plan.fileId, TELEGRAM_VOICE_MAX_BYTES));
        if (file.ok) return { bytes: file.data, mimeType: plan.mimeType };
        downloadFailed = !file.tooLarge;
        return { refusal: file.tooLarge ? "audio_too_large" : "audio_required" };
      },
      userId: context.link.userId
    });
    if ("refusal" in result) {
      log({ code: result.refusal === "dictation_unavailable" ? "telegram_voice_unavailable" : "telegram_voice_refused", outcome: "skipped" });
      await say(context, voiceRefusal(result, downloadFailed));
      return [];
    }
    const transcript = result.text.trim();
    if (!transcript) {
      await say(context, { text: TELEGRAM_MEDIA_COPY.voiceEmpty });
      return [];
    }
    try {
      await quoteTranscript(context, transcript);
    } catch (error) {
      // The quote only shows what was heard; the request still goes.
      log({ code: "telegram_notice_failed", error, outcome: "failed" });
    }
    return [...captionBlocks(plan.caption), { text: transcript, type: "text" }];
  }

  /** Downloads and uploads the file as the user; the upload's refusals are final, a busy one is asked again a few times. */
  async function upload(
    context: TelegramMessageContext, services: TelegramMediaServices, plan: Extract<TelegramMediaPlan, { kind: "attachment" }>
  ): Promise<UploadedAttachment | Refusal> {
    const file = await download(context, plan.fileId, plan.maxBytes);
    if (!file.ok) return file.tooLarge ? planRefusal({ reason: "file_too_large" }) : { text: TELEGRAM_MEDIA_COPY.fileUnreadable };
    for (let attempt = 1; ; attempt += 1) {
      const form = new FormData();
      form.set("file", new File([new Uint8Array(file.data)], plan.fileName, { type: plan.mimeType }));
      if (plan.scope === "workspace") form.set("scope", "workspace");
      const response = await services.upload({ request: new Request(UPLOAD_URL, { body: form, method: "POST" }), userId: context.link.userId });
      const body: unknown = await response.json().catch(() => null);
      if (response.ok) {
        const attachment = uploadedAttachment(body);
        if (attachment) return attachment;
        log({ code: "telegram_media_upload_refused", httpStatus: response.status, outcome: "failed" });
        return { text: TELEGRAM_MEDIA_COPY.fileFailed };
      }
      const code = record(body) && typeof body.error === "string" ? body.error : "";
      if (response.status === 429 && attempt < UPLOAD_BUSY_ATTEMPTS) {
        await sleep(1_000 * 2 ** (attempt - 1));
        continue;
      }
      log({ code: "telegram_media_upload_refused", httpStatus: response.status, outcome: "skipped" });
      return uploadRefusal(code, response.status, plan.scope === "workspace");
    }
  }

  /** Waits for processing (`processing` → `ready`) with growing pauses, at most the ready bound. */
  async function settled(services: TelegramMediaServices, userId: string, attachment: UploadedAttachment): Promise<"ready" | "failed" | "timeout"> {
    if (attachment.status === "ready") return "ready";
    if (attachment.status !== "processing") return "failed";
    const deadline = now() + readyTimeoutMs;
    for (let pause = READY_POLL_FIRST_MS; ; pause = Math.min(pause * 2, READY_POLL_MAX_MS)) {
      await sleep(Math.max(0, Math.min(pause, deadline - now())));
      const status = await services.attachmentStatus({ attachmentId: attachment.id, userId });
      if (status === "ready") return "ready";
      if (status !== "processing") return "failed";
      if (now() >= deadline) return "timeout";
    }
  }

  async function prepareAttachment(
    context: TelegramMessageContext, services: TelegramMediaServices, plan: Extract<TelegramMediaPlan, { kind: "attachment" }>
  ): Promise<ContentBlock[]> {
    const uploaded = await transfer(() => upload(context, services, plan));
    if ("text" in uploaded) {
      await say(context, uploaded);
      return [];
    }
    const state = await settled(services, context.link.userId, uploaded);
    if (state !== "ready") {
      log({ code: "telegram_media_not_ready", outcome: "skipped" });
      await say(context, { text: state === "timeout" ? TELEGRAM_MEDIA_COPY.fileStillProcessing : TELEGRAM_MEDIA_COPY.fileProcessingFailed });
      return [];
    }
    const block: ContentBlock = uploaded.kind === "image"
      ? { alt: uploaded.fileName, attachmentId: uploaded.id, type: "image" }
      : { attachmentId: uploaded.id, fileName: uploaded.fileName, type: "file" };
    return [...captionBlocks(plan.caption), block];
  }

  async function prepare(context: TelegramMessageContext, services: TelegramMediaServices, plan: TelegramMediaPlan): Promise<ContentBlock[]> {
    try {
      if (plan.kind === "audio") return await prepareAudio(context, services, plan);
      if (plan.kind === "attachment") return await prepareAttachment(context, services, plan);
      return [];
    } catch (error) {
      log({ code: "telegram_media_failed", error, outcome: "failed" });
      await say(context, { text: plan.kind === "audio" ? TELEGRAM_MEDIA_COPY.voiceFailed : TELEGRAM_MEDIA_COPY.fileFailed });
      return [];
    }
  }

  return async (context) => {
    const { message } = context;
    if (context.command || !hasMedia(message)) return false;
    let services: TelegramMediaServices;
    try {
      services = await deps.services();
    } catch (error) {
      log({ code: "telegram_media_failed", error, outcome: "failed" });
      await context.bot.outbound.sendText({ chatId: message.chat.id, replyTo: message.message_id, text: TELEGRAM_MEDIA_COPY.fileFailed });
      return true;
    }
    const plan = planTelegramMedia(message, { uploadMaxBytes: services.uploadMaxBytes(), workspaceEnabled: context.link.workspaceEnabled });
    if (!plan) return false;
    if (plan.kind === "refused") {
      log({ code: planRefusalCode(plan.refusal), outcome: "skipped" });
      await say(context, planRefusal(plan.refusal));
      return true;
    }
    deps.conversation.queue(context, prepare(context, services, plan));
    return true;
  };
}

function hasMedia(message: TelegramMessage): boolean {
  return !message.has_other_content && Boolean(message.voice || message.audio || message.document || message.photo?.length);
}

/** Memoizes a lazily loaded service set; a failed load is tried again on the next call. */
export function lazyTelegramMediaServices(load: () => Promise<TelegramMediaServices>): () => Promise<TelegramMediaServices> {
  let pending: Promise<TelegramMediaServices> | null = null;
  return () => {
    pending ??= load().catch((error: unknown) => {
      pending = null;
      throw error;
    });
    return pending;
  };
}
