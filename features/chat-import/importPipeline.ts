import {
  CHAT_IMPORT_MAX_CHATS_PER_REQUEST,
  CHAT_IMPORT_REQUEST_MAX_BYTES,
  decodeChatImportItem,
  normalizeChatImportSourceModel
} from "@/lib/contracts/chatImport";
import { importedChatTitle } from "@/lib/contracts/chats";
import {
  IMPORT_SKIPPED_CHAT_KINDS,
  type ChatImportConverter,
  type ConvertedChat,
  type ImportLocalFailureReason,
  type ImportSkipKind
} from "./converters/converterTypes";
import type { ImportFile } from "./importFile";

/** A chat, or with `file` a whole file, that never reached the server. */
export type ImportLocalFailure = Readonly<{ title: string; reason: ImportLocalFailureReason; message?: string; file?: true }>;
export type ImportSentChat = Readonly<{ title: string; messages: number }>;

/**
 * One step of an import: a request body ready to send, if any, and the local
 * outcomes since the previous step. The last step has `done`.
 */
export type ImportBatch = Readonly<{
  /** `POST /api/me/chats/import` body: `{"chats":[...]}` within the request limit. */
  body: string | null;
  /** The chats in `body`, in order. */
  sent: readonly ImportSentChat[];
  /** More chats now expected. */
  totalDelta: number;
  skipped: Readonly<Partial<Record<ImportSkipKind, number>>>;
  failed: readonly ImportLocalFailure[];
  done: boolean;
}>;

export type ImportPipelineOptions = Readonly<{
  converters: readonly ChatImportConverter[];
  maxBodyBytes?: number;
  maxChats?: number;
  /** Local outcomes that end a step early, so progress keeps moving without sendable chats. */
  flushOutcomes?: number;
  now?: () => Date;
}>;

/** Small requests keep the progress moving; a large chat still travels alone. */
export const CLIENT_BATCH_MAX_CHATS = 25;
const ENVELOPE_START = '{"chats":[';
const ENVELOPE_END = "]}";
const ENVELOPE_BYTES = ENVELOPE_START.length + ENVELOPE_END.length;

/** UTF-8 length of a string without encoding it. */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length &&
      (value.charCodeAt(index + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

type PreparedItem =
  | Readonly<{ ok: true; json: string; bytes: number; sent: ImportSentChat }>
  | Readonly<{ ok: false; failure: ImportLocalFailure }>;

/** The request item exactly as the server will validate it, refused here with the same code. */
function prepareItem(chat: ConvertedChat, now: Date): PreparedItem {
  // The title as the chat will be stored: converters may pass an empty one.
  const title = importedChatTitle(chat.document.chat.title);
  const sourceModel = normalizeChatImportSourceModel(chat.sourceModel);
  const item = {
    document: { ...chat.document, chat: { ...chat.document.chat, title } },
    source: chat.source,
    ...(chat.source !== "AIQSA" && chat.sourceKey !== undefined ? { sourceKey: chat.sourceKey } : {}),
    ...(sourceModel ? { sourceModel } : {})
  };
  const decoded = decodeChatImportItem(item, now);
  if (!decoded.ok) return { failure: { reason: decoded.code, title }, ok: false };
  const json = JSON.stringify(decoded.value);
  return {
    bytes: utf8ByteLength(json),
    json,
    ok: true,
    sent: { messages: decoded.value.document.chat.messages.length, title }
  };
}

/**
 * Detects the converter of every picked file, converts them in order and
 * packs the chats into import requests: up to the byte limit and chat count,
 * a large chat alone, and a chat that cannot fit even alone reported as too
 * large without being sent.
 */
export async function* importBatches(
  files: readonly ImportFile[],
  options: ImportPipelineOptions
): AsyncGenerator<ImportBatch> {
  const maxBodyBytes = options.maxBodyBytes ?? CHAT_IMPORT_REQUEST_MAX_BYTES;
  const maxChats = Math.min(options.maxChats ?? CLIENT_BATCH_MAX_CHATS, CHAT_IMPORT_MAX_CHATS_PER_REQUEST);
  const flushOutcomes = options.flushOutcomes ?? 25;
  const now = options.now ?? (() => new Date());

  let items: string[] = [];
  let bodyBytes = ENVELOPE_BYTES;
  let sent: ImportSentChat[] = [];
  let totalDelta = 0;
  let skipped: Partial<Record<ImportSkipKind, number>> = {};
  let failed: ImportLocalFailure[] = [];
  let pendingOutcomes = 0;

  const step = (done: boolean): ImportBatch => {
    const batch: ImportBatch = {
      body: items.length ? `${ENVELOPE_START}${items.join(",")}${ENVELOPE_END}` : null,
      done,
      failed,
      sent,
      skipped,
      totalDelta
    };
    items = [];
    bodyBytes = ENVELOPE_BYTES;
    sent = [];
    totalDelta = 0;
    skipped = {};
    failed = [];
    pendingOutcomes = 0;
    return batch;
  };
  const fail = (failure: ImportLocalFailure) => {
    failed.push(failure);
    pendingOutcomes += 1;
  };

  let unclaimed = [...files];
  const plan: Array<Readonly<{ converter: ChatImportConverter; files: readonly ImportFile[] }>> = [];
  for (const converter of options.converters) {
    if (unclaimed.length === 0) break;
    const detection = await converter.detect(unclaimed);
    const taken = new Set<ImportFile>(detection.claimed);
    for (const refusal of detection.refused ?? []) {
      taken.add(refusal.file);
      fail({ file: true, reason: refusal.reason, title: refusal.file.name, ...(refusal.message ? { message: refusal.message } : {}) });
    }
    if (detection.claimed.length) plan.push({ converter, files: detection.claimed });
    unclaimed = unclaimed.filter((file) => !taken.has(file));
  }
  for (const file of unclaimed) fail({ file: true, reason: "unsupported_file", title: file.name });

  for (const { converter, files: claimed } of plan) {
    for await (const event of converter.convert(claimed)) {
      if (event.type === "total") {
        totalDelta += event.chats;
      } else if (event.type === "skipped") {
        skipped[event.kind] = (skipped[event.kind] ?? 0) + event.count;
        if (IMPORT_SKIPPED_CHAT_KINDS.has(event.kind)) pendingOutcomes += event.count;
      } else if (event.type === "failed") {
        fail({
          reason: event.reason,
          title: event.title,
          ...(event.message ? { message: event.message } : {}),
          ...(event.file ? { file: true as const } : {})
        });
      } else {
        const prepared = prepareItem(event.chat, now());
        if (!prepared.ok) {
          fail(prepared.failure);
        } else if (ENVELOPE_BYTES + prepared.bytes > maxBodyBytes) {
          fail({ reason: "too_large", title: prepared.sent.title });
        } else {
          if (items.length > 0 && bodyBytes + 1 + prepared.bytes > maxBodyBytes) yield step(false);
          bodyBytes += (items.length > 0 ? 1 : 0) + prepared.bytes;
          items.push(prepared.json);
          sent.push(prepared.sent);
          if (items.length >= maxChats) yield step(false);
        }
      }
      if (pendingOutcomes >= flushOutcomes) yield step(false);
    }
  }
  yield step(true);
}
