import { estimateApproxTokens } from "../../../domain/contextBudget";
import {
  memorySha256,
  normalizeMemorySearchText
} from "../persistence/lexical";
import { detectMemoryTextLanguage, type MemoryTextLanguage } from "./language";
import {
  MEMORY_HISTORY_SOURCE_PROJECTION_VERSION,
  type MemoryHistoryProjectedMessage,
  type MemoryHistoryRecallTurnGroup,
  type MemorySafeSourceSnapshot
} from "./sourceProjection";
import { projectMemoryHistorySafeText } from "./safety";

// v2 introduces explicit speaker labels in the provider-safe projection.  The
// version is part of chunk identity, so old role-less chunks cannot be mixed
// with the new representation in one active generation.
export const MEMORY_HISTORY_CHUNKING_VERSION = "memory-history-chunking-v2";

export type MemoryHistoryChunkingOptions = Readonly<{
  maxApproxTokens: number;
  maxCharacters: number;
  maxChunks: number;
  maxMessagesPerChunk: number;
  maxTurnGroupsPerChunk: number;
  overlapTurnGroups: number;
}>;

export type MemoryHistoryChunkAdmission = Readonly<{
  excludedMessageIds?: readonly string[];
  sourceCreatedAtCutoff?: string | null;
}>;

export const DEFAULT_MEMORY_HISTORY_CHUNKING_OPTIONS: MemoryHistoryChunkingOptions =
  Object.freeze({
    maxApproxTokens: 768,
    maxCharacters: 3_600,
    maxChunks: 512,
    maxMessagesPerChunk: 12,
    maxTurnGroupsPerChunk: 8,
    overlapTurnGroups: 1
  });

export type MemoryRecallChunkMessageJoin = Readonly<{
  endOffset: number;
  messageId: string;
  ordinal: number;
  role: "assistant" | "user";
  safeTextHash: string;
  startOffset: number;
}>;

export type MemoryRecallChunkProjection = Readonly<{
  approxTokens: number;
  branchGeneration: number;
  chatId: string;
  chunkingVersion: typeof MEMORY_HISTORY_CHUNKING_VERSION;
  contentHash: string;
  folderId: string | null;
  languageCode: MemoryTextLanguage;
  messageJoins: readonly MemoryRecallChunkMessageJoin[];
  normalizedSafeSearchText: string;
  occurredFrom: string;
  occurredTo: string;
  ordinal: number;
  overlapFromPreviousTurnGroupIds: readonly string[];
  providerSafeText: string;
  redactionReasonCodes: readonly string[];
  redactionState: "NOT_NEEDED" | "REDACTED";
  safeProjectedText: string;
  safetyClass: "NORMAL" | "SENSITIVE";
  sourceAssistantId: string | null;
  sourceContentHash: string;
  sourceProjectionVersion: typeof MEMORY_HISTORY_SOURCE_PROJECTION_VERSION;
  sourceRevision: number;
  turnGroupIds: readonly string[];
  userId: string;
}>;

type Piece = Readonly<{
  endOffset: number;
  group: MemoryHistoryRecallTurnGroup;
  message: MemoryHistoryProjectedMessage;
  startOffset: number;
  text: string;
}>;

type GroupUnit = Readonly<{
  group: MemoryHistoryRecallTurnGroup;
  pieces: readonly Piece[];
}>;

type PlannedChunk = Readonly<{
  overlapFromPreviousTurnGroupIds: readonly string[];
  pieces: readonly Piece[];
}>;

type RenderedPieces = Readonly<{
  approxTokens: number;
  messageJoins: readonly MemoryRecallChunkMessageJoin[];
  occurredFrom: string;
  occurredTo: string;
  redactionReasonCodes: readonly string[];
  redactionState: "NOT_NEEDED" | "REDACTED";
  safetyClass: "NORMAL" | "SENSITIVE";
  sourceAssistantId: string | null;
  text: string;
  turnGroupIds: readonly string[];
}>;

const sha256Pattern = /^[a-f0-9]{64}$/u;

export class MemoryHistoryChunkingError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MemoryHistoryChunkingError";
  }
}

function fail(code: string): never {
  throw new MemoryHistoryChunkingError(code);
}

function integerInRange(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function optionsWithDefaults(
  options: Partial<MemoryHistoryChunkingOptions> | undefined
): MemoryHistoryChunkingOptions {
  const resolved = {
    ...DEFAULT_MEMORY_HISTORY_CHUNKING_OPTIONS,
    ...options
  };
  if (
    !integerInRange(resolved.maxApproxTokens, 64, 2_048) ||
    !integerInRange(resolved.maxCharacters, 256, 4_000) ||
    !integerInRange(resolved.maxChunks, 1, 1_024) ||
    !integerInRange(resolved.maxMessagesPerChunk, 2, 32) ||
    !integerInRange(resolved.maxTurnGroupsPerChunk, 1, 16) ||
    !integerInRange(resolved.overlapTurnGroups, 0, 4) ||
    resolved.overlapTurnGroups >= resolved.maxTurnGroupsPerChunk
  ) {
    fail("memory_history_chunking_options_invalid");
  }
  return resolved;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function pieceSeparator(previous: Piece | undefined, current: Piece): string {
  const label = current.message.role === "user" ? "User: " : "Assistant: ";
  if (!previous) return label;
  if (
    previous.message.id === current.message.id &&
    previous.endOffset === current.startOffset
  ) return "";
  return `\n\n${label}`;
}

function renderPieces(pieces: readonly Piece[]): RenderedPieces {
  let text = "";
  const joins: MemoryRecallChunkMessageJoin[] = [];
  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index]!;
    text += pieceSeparator(pieces[index - 1], piece);
    text += piece.text;
    const previousJoin = joins.at(-1);
    if (
      previousJoin &&
      previousJoin.messageId === piece.message.id &&
      previousJoin.endOffset === piece.startOffset
    ) {
      joins[joins.length - 1] = {
        ...previousJoin,
        endOffset: piece.endOffset
      };
    } else {
      joins.push({
        endOffset: piece.endOffset,
        messageId: piece.message.id,
        ordinal: joins.length,
        role: piece.message.role,
        safeTextHash: piece.message.safeTextHash,
        startOffset: piece.startOffset
      });
    }
  }
  const groups = [...new Map(pieces.map((piece) => [piece.group.id, piece.group])).values()];
  const reasonCodes = uniqueSorted(groups.flatMap((group) => group.redactionReasonCodes));
  return {
    approxTokens: estimateApproxTokens(text),
    messageJoins: joins,
    occurredFrom: groups.map((group) => group.occurredFrom).sort()[0] ??
      fail("memory_history_chunk_empty"),
    occurredTo: groups.map((group) => group.occurredTo).sort().at(-1) ??
      fail("memory_history_chunk_empty"),
    redactionReasonCodes: reasonCodes,
    redactionState: reasonCodes.length > 0 ? "REDACTED" : "NOT_NEEDED",
    safetyClass: "NORMAL",
    sourceAssistantId: groups[0]?.sourceAssistantId ?? null,
    text,
    turnGroupIds: groups.map((group) => group.id)
  };
}

function fits(
  pieces: readonly Piece[],
  options: MemoryHistoryChunkingOptions
): boolean {
  if (pieces.length === 0) return true;
  const rendered = renderPieces(pieces);
  return rendered.text.length <= options.maxCharacters &&
    rendered.approxTokens <= options.maxApproxTokens &&
    rendered.messageJoins.length <= options.maxMessagesPerChunk &&
    rendered.turnGroupIds.length <= options.maxTurnGroupsPerChunk;
}

function preferredBoundary(value: string, start: number, maximumEnd: number): number {
  const minimumPreferred = start + Math.floor((maximumEnd - start) * 0.6);
  for (let end = maximumEnd; end > minimumPreferred; end -= 1) {
    const character = value[end - 1]!;
    if (/\s|[.!?。！？…;:]/u.test(character)) return end;
  }
  return maximumEnd;
}

function boundedPrefixEnd(
  value: string,
  start: number,
  options: MemoryHistoryChunkingOptions
): number {
  const boundaries: number[] = [];
  let cursor = start;
  while (cursor < value.length) {
    const codePoint = value.codePointAt(cursor);
    if (codePoint === undefined) break;
    const width = codePoint > 0xffff ? 2 : 1;
    if (cursor + width - start > options.maxCharacters) break;
    cursor += width;
    boundaries.push(cursor);
  }
  let lower = 0;
  let upper = boundaries.length - 1;
  let bestIndex = -1;
  while (lower <= upper) {
    const candidateIndex = Math.floor((lower + upper) / 2);
    const candidate = boundaries[candidateIndex]!;
    if (estimateApproxTokens(value.slice(start, candidate)) <= options.maxApproxTokens) {
      bestIndex = candidateIndex;
      lower = candidateIndex + 1;
    } else {
      upper = candidateIndex - 1;
    }
  }
  const best = boundaries[bestIndex];
  if (best === undefined || best <= start) {
    fail("memory_history_chunking_unit_too_large");
  }
  return preferredBoundary(value, start, best);
}

function fullGroupUnit(group: MemoryHistoryRecallTurnGroup): GroupUnit {
  return {
    group,
    pieces: group.messages.map((message): Piece => ({
      endOffset: message.safeText.length,
      group,
      message,
      startOffset: 0,
      text: message.safeText
    }))
  };
}

function splitGroup(
  group: MemoryHistoryRecallTurnGroup,
  options: MemoryHistoryChunkingOptions
): PlannedChunk[] {
  // A split piece receives a role label when it starts a chunk (or follows a
  // non-contiguous piece). Reserve the largest label budget while choosing
  // source offsets so the rendered canonical text remains within the public
  // chunk bounds. The source offsets themselves continue to refer only to the
  // original message text.
  const labelBudget = "Assistant: ";
  const splitOptions: MemoryHistoryChunkingOptions = {
    ...options,
    maxApproxTokens: Math.max(1, options.maxApproxTokens - estimateApproxTokens(labelBudget)),
    maxCharacters: Math.max(1, options.maxCharacters - labelBudget.length)
  };
  const pieces: Piece[] = [];
  for (const message of group.messages) {
    let start = 0;
    while (start < message.safeText.length) {
      const end = boundedPrefixEnd(message.safeText, start, splitOptions);
      pieces.push({
        endOffset: end,
        group,
        message,
        startOffset: start,
        text: message.safeText.slice(start, end)
      });
      start = end;
    }
  }
  const chunks: PlannedChunk[] = [];
  let current: Piece[] = [];
  for (const piece of pieces) {
    const candidate = [...current, piece];
    if (current.length > 0 && !fits(candidate, options)) {
      chunks.push({ overlapFromPreviousTurnGroupIds: [], pieces: current });
      current = [piece];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) {
    chunks.push({ overlapFromPreviousTurnGroupIds: [], pieces: current });
  }
  return chunks;
}

function groupIsSafe(group: MemoryHistoryRecallTurnGroup): boolean {
  if (
    group.messages.length !== 2 ||
    group.messages[0].role !== "user" ||
    group.messages[1].role !== "assistant" ||
    group.userMessageId !== group.messages[0].id ||
    group.assistantMessageId !== group.messages[1].id ||
    group.messages[0].provenance.assistantId !== null ||
    group.sourceAssistantId !== group.messages[1].provenance.assistantId ||
    group.messages.some((message) =>
      !sha256Pattern.test(message.contentHash) ||
      memorySha256(message.safeText) !== message.safeTextHash ||
      message.providerSafeText !== message.safeText)
  ) {
    fail("memory_history_turn_group_invalid");
  }
  const combinedText = group.messages.map((message) => message.safeText).join("\n\n");
  if (memorySha256(combinedText) !== group.safeTextHash) {
    fail("memory_history_turn_group_invalid");
  }
  const safety = projectMemoryHistorySafeText(combinedText);
  return safety.eligible && safety.safeText === combinedText &&
    safety.providerSafeText === combinedText;
}

function chunkTextPassesSafety(text: string): boolean {
  const safety = projectMemoryHistorySafeText(text);
  const trimmed = text.trim();
  return safety.eligible && safety.safeText === trimmed &&
    safety.providerSafeText === trimmed;
}

function validateSnapshot(snapshot: MemorySafeSourceSnapshot): void {
  if (
    snapshot.projectionVersion !== MEMORY_HISTORY_SOURCE_PROJECTION_VERSION ||
    !sha256Pattern.test(snapshot.sourceContentHash) ||
    !sha256Pattern.test(snapshot.snapshotHash) ||
    !Number.isSafeInteger(snapshot.branchGeneration) ||
    snapshot.branchGeneration < 0 ||
    !Number.isSafeInteger(snapshot.sourceRevision) ||
    snapshot.sourceRevision < 0 ||
    snapshot.recallChunkProjection.turnGroups.some((group, ordinal) =>
      group.ordinal !== ordinal)
  ) {
    fail("memory_history_safe_snapshot_invalid");
  }
}

function admittedGroupSegments(
  groups: readonly MemoryHistoryRecallTurnGroup[],
  admission: MemoryHistoryChunkAdmission | undefined
): readonly (readonly MemoryHistoryRecallTurnGroup[])[] {
  if (!admission) return groups.length === 0 ? [] : [groups];
  const excluded = new Set(admission.excludedMessageIds ?? []);
  const cutoff = admission.sourceCreatedAtCutoff === null ||
      admission.sourceCreatedAtCutoff === undefined
    ? null
    : new Date(admission.sourceCreatedAtCutoff);
  if (cutoff && !Number.isFinite(cutoff.getTime())) {
    fail("memory_history_chunk_admission_invalid");
  }
  const segments: MemoryHistoryRecallTurnGroup[][] = [];
  let current: MemoryHistoryRecallTurnGroup[] = [];
  for (const group of groups) {
    const admitted = group.messages.every((message) =>
      !excluded.has(message.id) &&
      (cutoff === null || new Date(message.createdAt) > cutoff));
    if (admitted) {
      current.push(group);
      continue;
    }
    if (current.length > 0) segments.push(current);
    current = [];
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

function planChunks(
  groups: readonly MemoryHistoryRecallTurnGroup[],
  options: MemoryHistoryChunkingOptions
): PlannedChunk[] {
  const chunks: PlannedChunk[] = [];
  let currentUnits: GroupUnit[] = [];
  let currentOverlapIds: string[] = [];

  const flush = (): void => {
    if (currentUnits.length === 0) return;
    chunks.push({
      overlapFromPreviousTurnGroupIds: currentOverlapIds,
      pieces: currentUnits.flatMap((unit) => unit.pieces)
    });
    currentUnits = [];
    currentOverlapIds = [];
  };

  for (const group of groups) {
    const unit = fullGroupUnit(group);
    if (
      currentUnits.length > 0 &&
      currentUnits[0]?.group.sourceAssistantId !== group.sourceAssistantId
    ) {
      flush();
    }
    if (!fits(unit.pieces, options)) {
      flush();
      chunks.push(...splitGroup(group, options));
      continue;
    }
    const candidatePieces = [...currentUnits, unit].flatMap((entry) => entry.pieces);
    if (currentUnits.length === 0 || fits(candidatePieces, options)) {
      currentUnits.push(unit);
      continue;
    }

    const priorUnits = currentUnits;
    flush();
    let overlapUnits = priorUnits.slice(-options.overlapTurnGroups);
    while (
      overlapUnits.length > 0 &&
      !fits([...overlapUnits, unit].flatMap((entry) => entry.pieces), options)
    ) {
      overlapUnits = overlapUnits.slice(1);
    }
    currentUnits = [...overlapUnits, unit];
    currentOverlapIds = overlapUnits.map((entry) => entry.group.id);
  }
  flush();
  return chunks;
}

export function chunkMemoryRecallProjection(
  snapshot: MemorySafeSourceSnapshot,
  options?: Partial<MemoryHistoryChunkingOptions>,
  admission?: MemoryHistoryChunkAdmission
): readonly MemoryRecallChunkProjection[] {
  validateSnapshot(snapshot);
  if (snapshot.mode !== "NORMAL") return [];
  const resolvedOptions = optionsWithDefaults(options);
  const safeGroupSegments = admittedGroupSegments(
    snapshot.recallChunkProjection.turnGroups.filter(groupIsSafe),
    admission
  );
  const planned = safeGroupSegments.flatMap((groups) =>
    planChunks(groups, resolvedOptions)
  ).filter((chunk) => {
    const rendered = renderPieces(chunk.pieces);
    return chunkTextPassesSafety(rendered.text);
  });
  if (planned.length > resolvedOptions.maxChunks) {
    fail("memory_history_chunk_limit_exceeded");
  }
  return planned.map((chunk, ordinal): MemoryRecallChunkProjection => {
    const rendered = renderPieces(chunk.pieces);
    if (!fits(chunk.pieces, resolvedOptions)) {
      fail("memory_history_chunk_limit_invalid");
    }
    const contentHash = memorySha256({
      branchGeneration: snapshot.branchGeneration,
      chatId: snapshot.chatId,
      chunkingVersion: MEMORY_HISTORY_CHUNKING_VERSION,
      messageJoins: rendered.messageJoins,
      ordinal,
      safeProjectedText: rendered.text,
      sourceContentHash: snapshot.sourceContentHash,
      sourceProjectionVersion: snapshot.projectionVersion,
      sourceRevision: snapshot.sourceRevision,
      turnGroupIds: rendered.turnGroupIds,
      userId: snapshot.userId
    });
    return {
      approxTokens: rendered.approxTokens,
      branchGeneration: snapshot.branchGeneration,
      chatId: snapshot.chatId,
      chunkingVersion: MEMORY_HISTORY_CHUNKING_VERSION,
      contentHash,
      folderId: snapshot.folderId,
      languageCode: detectMemoryTextLanguage(rendered.text),
      messageJoins: rendered.messageJoins,
      normalizedSafeSearchText: normalizeMemorySearchText(rendered.text),
      occurredFrom: rendered.occurredFrom,
      occurredTo: rendered.occurredTo,
      ordinal,
      overlapFromPreviousTurnGroupIds: chunk.overlapFromPreviousTurnGroupIds,
      providerSafeText: rendered.text,
      redactionReasonCodes: rendered.redactionReasonCodes,
      redactionState: rendered.redactionState,
      safeProjectedText: rendered.text,
      safetyClass: rendered.safetyClass,
      sourceAssistantId: rendered.sourceAssistantId,
      sourceContentHash: snapshot.sourceContentHash,
      sourceProjectionVersion: snapshot.projectionVersion,
      sourceRevision: snapshot.sourceRevision,
      turnGroupIds: rendered.turnGroupIds,
      userId: snapshot.userId
    };
  });
}
