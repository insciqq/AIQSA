import type { ProviderHistoryFormat, ProviderNativeData } from "../providers/history";
import { VIEW_WORKSPACE_IMAGE } from "../tools/viewWorkspaceImage";
import { parseWorkspaceImageEvidence, type WorkspaceImageEvidence } from "../workspace/directImageEvidence";
import type { TranscriptItem, TranscriptOrigin, TranscriptRequestAnchor } from "./transcript";

/**
 * The row form of one transcript item (`RunTranscriptItem`): its kind, the
 * provider call id of a tool call or result, and the rest of its fields as a
 * JSON object. The row id is the item id. Decoding is strict: a row that does
 * not decode fails the run that reads it with a stable code instead of being
 * skipped, so a transcript never loses an item silently.
 */
export type TranscriptItemKind = TranscriptItem["kind"];

export type TranscriptRowFields = Readonly<{
  body: Record<string, unknown>;
  callId: string | null;
  kind: TranscriptItemKind;
}>;

export const TRANSCRIPT_ITEM_LIMITS = Object.freeze({
  /** One serialized body; a tool result's output is already bounded far below. */
  bodyBytes: 8 * 1024 * 1024,
  callIdLength: 256,
  identityLength: 256,
  nameLength: 256
});

export const TRANSCRIPT_ITEM_INVALID = "transcript_item_invalid";

export class TranscriptItemInvalidError extends Error {
  readonly code = TRANSCRIPT_ITEM_INVALID;

  constructor() {
    super(TRANSCRIPT_ITEM_INVALID);
    this.name = "TranscriptItemInvalidError";
  }
}

const KINDS: readonly TranscriptItemKind[] = ["user", "assistant_text", "reasoning", "tool_call", "tool_result", "compaction"];
const FORMATS: readonly ProviderHistoryFormat[] = ["anthropic_messages", "chat_completions", "gemini_interactions", "openai_responses"];
const OUTCOMES = ["complete", "error", "unknown"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(): never {
  throw new TranscriptItemInvalidError();
}

function boundedString(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === "string" && value.length <= maximum && (allowEmpty || value.length > 0);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : invalid();
}

function tokens(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : invalid();
}

function origin(value: unknown, required: true): TranscriptOrigin;
function origin(value: unknown, required: false): TranscriptOrigin | undefined;
function origin(value: unknown, required: boolean): TranscriptOrigin | undefined {
  if (value === undefined && !required) return undefined;
  if (!isRecord(value) || !boundedString(value.model, TRANSCRIPT_ITEM_LIMITS.identityLength) ||
    !boundedString(value.provider, TRANSCRIPT_ITEM_LIMITS.identityLength)) return invalid();
  return { model: value.model, provider: value.provider };
}

function native(value: unknown, required: true): ProviderNativeData;
function native(value: unknown, required: false): ProviderNativeData | undefined;
function native(value: unknown, required: boolean): ProviderNativeData | undefined {
  if (value === undefined && !required) return undefined;
  if (!isRecord(value) || !FORMATS.includes(value.format as ProviderHistoryFormat) || !isRecord(value.fields)) return invalid();
  return { fields: value.fields, format: value.format as ProviderHistoryFormat };
}

function requestAnchor(value: unknown): TranscriptRequestAnchor | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || (value.baseId !== null && !boundedString(value.baseId, TRANSCRIPT_ITEM_LIMITS.identityLength)) ||
    !Array.isArray(value.attachmentIds) || value.attachmentIds.length > 64 ||
    !value.attachmentIds.every((id) => boundedString(id, TRANSCRIPT_ITEM_LIMITS.identityLength))) return invalid();
  return { attachmentIds: value.attachmentIds as string[], baseId: value.baseId, fixedTokens: tokens(value.fixedTokens) ?? invalid(),
    inputTokens: tokens(value.inputTokens) ?? invalid() };
}

function optional<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [key]: value };
}

/** A completed `view_workspace_image` result's image reference, exactly as its evidence parses; never pixels. */
function image(value: unknown, name: string, outcome: unknown): WorkspaceImageEvidence | undefined {
  if (value === undefined) return undefined;
  const evidence = parseWorkspaceImageEvidence(value);
  return evidence && name === VIEW_WORKSPACE_IMAGE && outcome === "complete" ? evidence : invalid();
}

/** The row fields of one item; the item id becomes the row id. */
export function encodeTranscriptItem(item: TranscriptItem): TranscriptRowFields {
  const body: Record<string, unknown> = (() => {
    switch (item.kind) {
      case "user":
        return { text: item.text, ...(item.followup ? { followup: true } : {}) };
      case "assistant_text":
        return { text: item.text, ...optional("native", item.native), ...optional("origin", item.origin),
          ...optional("outputTokens", item.outputTokens), ...optional("requestAnchor", item.requestAnchor) };
      case "reasoning":
        return { native: item.native, origin: item.origin, ...optional("outputTokens", item.outputTokens),
          ...optional("requestAnchor", item.requestAnchor) };
      case "tool_call":
        return { arguments: item.arguments, name: item.name, ...optional("native", item.native),
          ...optional("origin", item.origin), ...optional("outputTokens", item.outputTokens),
          ...optional("requestAnchor", item.requestAnchor) };
      case "tool_result":
        return { name: item.name, outcome: item.outcome, output: item.output, ...optional("handle", item.handle),
          ...optional("image", item.image), ...(item.inFlight ? { inFlight: true } : {}) };
      case "compaction":
        return { origin: item.origin, ...optional("keepFromId", item.keepFromId), ...optional("native", item.native),
          ...optional("outputTokens", item.outputTokens), ...optional("retained", item.retained), ...optional("summary", item.summary) };
    }
  })();
  if (Buffer.byteLength(JSON.stringify(body)) > TRANSCRIPT_ITEM_LIMITS.bodyBytes) invalid();
  const callId = item.kind === "tool_call" || item.kind === "tool_result" ? item.callId : null;
  if (callId !== null && !boundedString(callId, TRANSCRIPT_ITEM_LIMITS.callIdLength)) invalid();
  // A round trip proves the stored form decodes to the same item.
  decodeTranscriptItem({ body, callId, id: item.id, kind: item.kind });
  return { body, callId, kind: item.kind };
}

/** One stored row as its item; throws `TranscriptItemInvalidError` for any other shape. */
export function decodeTranscriptItem(row: Readonly<{ body: unknown; callId: string | null; id: string; kind: string }>): TranscriptItem {
  const kind = row.kind as TranscriptItemKind;
  if (!KINDS.includes(kind) || !isRecord(row.body) || !boundedString(row.id, TRANSCRIPT_ITEM_LIMITS.identityLength)) return invalid();
  const body = row.body;
  const id = row.id;
  const tool = kind === "tool_call" || kind === "tool_result";
  if (tool !== (row.callId !== null)) return invalid();
  switch (kind) {
    case "user":
      if (body.followup !== undefined && body.followup !== true) return invalid();
      return { ...(body.followup === true ? { followup: true as const } : {}), id, kind, text: text(body.text) };
    case "assistant_text": {
      const itemNative = native(body.native, false);
      const itemOrigin = origin(body.origin, false);
      const outputTokens = tokens(body.outputTokens);
      const anchor = requestAnchor(body.requestAnchor);
      return { id, kind, ...(itemNative ? { native: itemNative } : {}), ...(itemOrigin ? { origin: itemOrigin } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}), ...(anchor ? { requestAnchor: anchor } : {}), text: text(body.text) };
    }
    case "reasoning": {
      const outputTokens = tokens(body.outputTokens);
      const anchor = requestAnchor(body.requestAnchor);
      return { id, kind, native: native(body.native, true), origin: origin(body.origin, true),
        ...(outputTokens !== undefined ? { outputTokens } : {}), ...(anchor ? { requestAnchor: anchor } : {}) };
    }
    case "tool_call": {
      if (typeof body.arguments !== "string" || !boundedString(body.name, TRANSCRIPT_ITEM_LIMITS.nameLength)) return invalid();
      const itemNative = native(body.native, false);
      const itemOrigin = origin(body.origin, false);
      const outputTokens = tokens(body.outputTokens);
      const anchor = requestAnchor(body.requestAnchor);
      return { arguments: body.arguments, callId: row.callId!, id, kind, name: body.name,
        ...(itemNative ? { native: itemNative } : {}), ...(itemOrigin ? { origin: itemOrigin } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}), ...(anchor ? { requestAnchor: anchor } : {}) };
    }
    case "tool_result": {
      if (!boundedString(body.name, TRANSCRIPT_ITEM_LIMITS.nameLength) ||
        !OUTCOMES.includes(body.outcome as typeof OUTCOMES[number]) ||
        (body.handle !== undefined && !boundedString(body.handle, TRANSCRIPT_ITEM_LIMITS.identityLength)) ||
        (body.inFlight !== undefined && (body.inFlight !== true || body.outcome !== "unknown"))) return invalid();
      const resultImage = image(body.image, body.name, body.outcome);
      return { callId: row.callId!, ...(typeof body.handle === "string" ? { handle: body.handle } : {}), id,
        ...(resultImage ? { image: resultImage } : {}), ...(body.inFlight === true ? { inFlight: true as const } : {}), kind,
        name: body.name, outcome: body.outcome as typeof OUTCOMES[number], output: text(body.output) };
    }
    case "compaction": {
      const itemNative = native(body.native, false);
      if (body.summary !== undefined && typeof body.summary !== "string") return invalid();
      if (body.retained !== undefined && typeof body.retained !== "string") return invalid();
      if (body.keepFromId !== undefined && !boundedString(body.keepFromId, TRANSCRIPT_ITEM_LIMITS.identityLength)) return invalid();
      if (!itemNative && typeof body.summary !== "string") return invalid();
      const outputTokens = tokens(body.outputTokens);
      return { id, ...(typeof body.keepFromId === "string" ? { keepFromId: body.keepFromId } : {}), kind,
        ...(itemNative ? { native: itemNative } : {}), origin: origin(body.origin, true),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
        ...(typeof body.retained === "string" ? { retained: body.retained } : {}),
        ...(typeof body.summary === "string" ? { summary: body.summary } : {}) };
    }
  }
}
