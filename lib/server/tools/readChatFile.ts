import type { PrismaClient } from "@prisma/client";
import { decodePdfProcessing, documentProcessingFromMetadata } from "../../contracts/uploads";
import { ImageInputError } from "../images/inputError";
import type { ProviderRunRequest } from "../providers/types";
import { attachmentIdsFromContentBlocks } from "../runs/runAttachmentMaterialization";
import type { DirectImageBudget } from "../workspace/directImageView";
import { CHAT_FILE_NO_TEXT, CHAT_FILE_UNTRUSTED, READ_CHAT_FILE_NAME } from "./chatFileContext";
import { createHeldResultImages } from "./heldResultImages";
import type { ModelToolCall, RunTool, ToolExecutionResult } from "./types";

export const CHAT_FILE_READ_LIMIT = 12_000;
export type ChatFileScope = Readonly<{ attachmentId: string; chatId: string; userId: string }>;
export type ChatFile = Readonly<{ fileName: string; kind: string; status: string; extractedText: string | null; metadata: unknown }>;
export type ChatFileReader = Readonly<{ read(scope: ChatFileScope): Promise<ChatFile | null> }>;
export type ChatImagePreview = Readonly<{ bytes: Buffer; width: number; height: number; mimeType: "image/png" | "image/jpeg" }>;
export type ChatImageReader = (scope: ChatFileScope, signal?: AbortSignal) => Promise<ChatImagePreview | null>;

/** Both attachment ownership and live chat access are checked at the read, even for an admitted reference. */
export function createPrismaChatFileReader(prisma: Pick<PrismaClient, "attachment">): ChatFileReader {
  return { read: (scope) => prisma.attachment.findFirst({
    where: { id: scope.attachmentId, chatId: scope.chatId, userId: scope.userId, savedAt: null,
      chat: { userId: scope.userId, permanentDeletionAt: null } },
    select: { fileName: true, kind: true, status: true, extractedText: true, metadata: true }
  }) };
}

async function defaultReader(): Promise<ChatFileReader> {
  const { prisma } = await import("../prisma");
  return createPrismaChatFileReader(prisma);
}

export const readChatFileTool: RunTool = {
  capability: "session", name: READ_CHAT_FILE_NAME, strict: false,
  description: "Read one file attached to this chat's active conversation by its exact attachment_id. " +
    "For documents, read stored extracted text by character offset (default 0) and limit (default and maximum 12000); " +
    "nextOffset continues the file. This does no search and does not start a Workspace. " +
    "For images, a vision-capable model receives a bounded preview; otherwise use analyze_image if offered. " +
    "A missing or partial extraction is reported explicitly. " + CHAT_FILE_UNTRUSTED,
  inputSchema: { type: "object", additionalProperties: false, required: ["attachment_id"], properties: {
    attachment_id: { type: "string", minLength: 1, maxLength: 256 },
    offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: CHAT_FILE_READ_LIMIT }
  } }
};

function result(call: ModelToolCall, value: unknown, error = false): ToolExecutionResult {
  return { callId: call.id, name: call.name, status: error ? "error" : "complete", content: [{ type: "json", value }] };
}
const refusal = (call: ModelToolCall, error: string, message: string) => result(call, { error, message }, true);
const notFound = (call: ModelToolCall) => refusal(call, "chat_file_not_found", "No such attachment is available in this chat's active conversation.");

/** One run owns the pixels; only the textual reference enters the durable transcript. */
export function createChatFileTool(input: Readonly<{
  request: ProviderRunRequest; userId: string; runId: string;
  reader?: ChatFileReader; readImage?: ChatImageReader; budget?: DirectImageBudget; runEnded?: Promise<void> | null;
}>) {
  const request = input.request;
  const ids = new Set(request.attachmentIds);
  for (const message of request.context?.messages ?? []) {
    if (message.purpose === undefined) for (const id of attachmentIdsFromContentBlocks(message.content.blocks)) ids.add(id);
  }
  for (const id of attachmentIdsFromContentBlocks(request.content.blocks)) ids.add(id);
  const held = createHeldResultImages({ request, runId: input.runId, toolName: READ_CHAT_FILE_NAME,
    ...(input.budget ? { budget: input.budget } : {}), ...(input.runEnded === undefined ? {} : { runEnded: input.runEnded }) });
  const images = held.images;

  async function view(call: ModelToolCall, scope: ChatFileScope, round: number, signal?: AbortSignal): Promise<ToolExecutionResult> {
    if (!request.modelCapabilities.vision || !input.readImage) return refusal(call, "chat_image_unavailable",
      "This model cannot view this image here. Use analyze_image if it is offered; otherwise explain that its pixels are unavailable.");
    const preparation = await held.prepare(signal);
    if (!preparation) return refusal(call, "chat_image_limit_exceeded", "Image previews are busy. Try this read again later.");
    try {
      const preview = await input.readImage(scope, signal);
      if (!preview) return notFound(call);
      signal?.throwIfAborted();
      if (held.ended()) return refusal(call, "chat_image_unavailable", "The run has ended.");
      const value = { attachment_id: scope.attachmentId, width: preview.width, height: preview.height,
        note: "Image preview. " + CHAT_FILE_UNTRUSTED + " Pixels accompany this result only while this run holds them. " +
          "If no image is attached to this result, call read_chat_file with this attachment_id to view it again." };
      if (!held.hold(call, round, preview, JSON.stringify(value))) {
        return refusal(call, "chat_image_limit_exceeded", "This image preview exceeds this request's image limits. Read fewer images at once.");
      }
      return result(call, value);
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof ImageInputError) return refusal(call, error.code,
        "The image could not be viewed safely in this request (format, integrity or size). Do not guess its contents; ask for a readable copy.");
      throw error;
    } finally { preparation(); }
  }

  return { images, async execute(call: ModelToolCall, round: number, signal?: AbortSignal): Promise<ToolExecutionResult> {
    const args = call.arguments;
    const id = args.attachment_id;
    const offset = args.offset ?? 0;
    const limit = args.limit ?? CHAT_FILE_READ_LIMIT;
    if (Object.keys(args).some((key) => !["attachment_id", "offset", "limit"].includes(key)) ||
      typeof id !== "string" || !id || id.length > 256 || id.trim() !== id || id.includes("\0") ||
      !Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > CHAT_FILE_READ_LIMIT) {
      return refusal(call, "chat_file_arguments_invalid", "Pass attachment_id and optional nonnegative character offset and limit from 1 to 12000.");
    }
    if (!ids.has(id)) return notFound(call);
    signal?.throwIfAborted();
    const scope = { attachmentId: id, chatId: request.chatId, userId: input.userId };
    const file = await (input.reader ?? await defaultReader()).read(scope);
    signal?.throwIfAborted();
    if (!file) return notFound(call);
    if (file.status !== "ready") return refusal(call, "chat_file_unreadable", "This file is not ready to read. Do not guess its contents.");
    if (file.kind === "image") {
      if (offset !== 0 || args.limit !== undefined) return refusal(call, "chat_file_arguments_invalid", "Images take attachment_id only.");
      return view(call, scope, round, signal);
    }
    const text = file.extractedText;
    if (!text?.trim()) return refusal(call, "chat_file_no_text", CHAT_FILE_NO_TEXT + " Ask for a readable copy or Workspace access.");
    if (Number(offset) > text.length) return refusal(call, "chat_file_offset_invalid", `offset is past the end of the extracted text (${text.length} characters).`);
    const start = Number(offset);
    const metadata = file.metadata && typeof file.metadata === "object" ? file.metadata as Record<string, unknown> : {};
    const partial = documentProcessingFromMetadata(metadata)?.status === "partial" || decodePdfProcessing(metadata.pdf)?.status === "partial";
    const value = (end: number) => ({ attachment_id: id, name: file.fileName.slice(0, 256), kind: file.kind, offset: start,
      nextOffset: end < text.length ? end : null, totalCharacters: text.length, text: text.slice(start, end),
      note: CHAT_FILE_UNTRUSTED + (partial ? " The text stops early; the remaining file contents were not extracted." : "") });
    let end = Math.min(text.length, start + Number(limit));
    // Escaping counts too: a page must fit whole in the engine's inline result, with no second layer of truncation.
    while (JSON.stringify(value(end)).length > 24_000 && end > start) end = start + Math.floor((end - start) / 2);
    return result(call, value(end));
  } };
}
