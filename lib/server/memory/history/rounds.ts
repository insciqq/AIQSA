import { estimateApproxTokens } from "../../../domain/contextBudget";
import {
  memorySha256,
  normalizeMemorySearchText
} from "../persistence/lexical";
import { detectMemoryTextLanguage, type MemoryTextLanguage } from "./language";
import type {
  MemoryHistoryProjectedMessage,
  MemoryHistoryRecallTurnGroup,
  MemorySafeSourceSnapshot
} from "./sourceProjection";
import type { MemoryRecallChunkMessageJoin } from "./chunking";
import { projectMemoryHistorySafeText } from "./safety";
import { memoryHistoryEvidenceRootHash } from "./evidenceRoot";

export const MEMORY_RECALL_ROUND_PROJECTION_VERSION =
  "memory-recall-round-projection-v1";
export const MEMORY_CONTEXTUAL_KEY_POLICY_VERSION =
  "memory-contextual-narrative-key-v1";
export const MEMORY_CONTEXTUAL_KEY_MAX_PRIOR_GROUPS = 2;
export const MEMORY_RECALL_ROUND_MAX_RAW_CHARACTERS = 200_000;
export const MEMORY_RECALL_ROUND_MAX_SEARCH_CHARACTERS = 4_000;

/**
 * Frozen Memory evidence is bounded in UTF-16 code units because the runtime
 * and wire contracts use JavaScript string lengths. PostgreSQL char_length
 * counts Unicode code points, so its defensive substring alone is not enough
 * for non-BMP text. Never leave a dangling high surrogate at the boundary.
 */
export function boundedMemoryRecallRoundEvidenceText(value: string): string {
  const sliced = value.slice(0, MEMORY_RECALL_ROUND_MAX_SEARCH_CHARACTERS);
  const last = sliced.charCodeAt(sliced.length - 1);
  const complete = last >= 0xD800 && last <= 0xDBFF
    ? sliced.slice(0, -1)
    : sliced;
  return complete.trim();
}

export type MemoryRecallRoundMessageJoin = Readonly<{
  messageId: string;
  ordinal: number;
  role: "assistant" | "tool" | "user";
  roundEndOffset: number;
  roundStartOffset: number;
  safeTextHash: string;
  sourceEndOffset: number;
  sourceMessageContentHash: string;
  sourceMessageUpdatedAt: string;
  sourceStartOffset: number;
}>;

export type MemoryRecallRoundProjection = Readonly<{
  approxTokens: number;
  branchGeneration: number;
  chatId: string;
  contextualKeyPolicyVersion: string;
  contextualKeyState: "GENERATED" | "RAW_FALLBACK";
  contextualNarrativeText: string;
  contextualSearchText: string;
  contextualSearchHash: string;
  contentHash: string;
  evidenceRootHash: string;
  folderId: string | null;
  groupId: string;
  groupKind: "STANDALONE" | "TOOL_EVENT" | "TURN";
  id: string;
  languageCode: MemoryTextLanguage;
  messageJoins: readonly MemoryRecallRoundMessageJoin[];
  occurredFrom: string;
  occurredTo: string;
  ordinal: number;
  parentChunkId: string;
  projectionVersion: typeof MEMORY_RECALL_ROUND_PROJECTION_VERSION;
  rawSafeText: string;
  redactionReasonCodes: readonly string[];
  redactionState: "NOT_NEEDED" | "REDACTED";
  safetyClass: "NORMAL" | "SENSITIVE";
  sourceAssistantId: string | null;
  sourceContentHash: string;
  sourceProjectionVersion: string;
  sourceRevision: number;
  userId: string;
}>;

export type MemoryContextualRoundInput = Readonly<{
  current: Readonly<{
    id: string;
    rawSafeText: string;
  }>;
  prior: readonly Readonly<{
    id: string;
    rawSafeText: string;
  }>[];
}>;

export type MemoryContextualRoundOutput = Readonly<{
  roundId: string;
  statements: readonly string[];
}>;

type MemoryContextualKeyEligibleRound = Readonly<{
  publicationState: "ACTIVE" | "SUPPRESSED";
  redactionState: "EXCLUDED" | "NOT_NEEDED" | "REDACTED";
  safetyClass: "HIGHLY_SENSITIVE" | "NORMAL" | "SECRET_TAINTED" | "SENSITIVE";
}>;

type ParentChunk = Readonly<{
  id: string;
  messageJoins: readonly MemoryRecallChunkMessageJoin[];
  ordinal: number;
}>;

function fail(code: string): never {
  throw new Error(code);
}

function roleLabel(role: MemoryRecallRoundMessageJoin["role"]): string {
  switch (role) {
    case "assistant": return "Assistant: ";
    case "tool": return "Tool event: ";
    case "user": return "User: ";
  }
}

function renderMessages(
  messages: readonly MemoryHistoryProjectedMessage[]
): Readonly<{ joins: readonly MemoryRecallRoundMessageJoin[]; text: string }> {
  let text = "";
  const joins: MemoryRecallRoundMessageJoin[] = [];
  for (const [ordinal, message] of messages.entries()) {
    if (ordinal > 0) text += "\n\n";
    text += roleLabel(message.role);
    const roundStartOffset = text.length;
    text += message.safeText;
    joins.push({
      messageId: message.id,
      ordinal,
      role: message.role,
      roundEndOffset: text.length,
      roundStartOffset,
      safeTextHash: message.safeTextHash,
      sourceEndOffset: message.safeText.length,
      sourceMessageContentHash: message.contentHash,
      sourceMessageUpdatedAt: message.updatedAt,
      sourceStartOffset: 0
    });
  }
  return { joins, text };
}

function boundedSearchText(value: string): string {
  const normalized = normalizeMemorySearchText(value);
  if (normalized.length <= MEMORY_RECALL_ROUND_MAX_SEARCH_CHARACTERS) {
    return normalized;
  }
  const marker = " memory round continuation ";
  const remaining = MEMORY_RECALL_ROUND_MAX_SEARCH_CHARACTERS - marker.length;
  const left = Math.ceil(remaining / 2);
  let prefix = normalized.slice(0, left);
  const prefixLast = prefix.charCodeAt(prefix.length - 1);
  if (prefixLast >= 0xD800 && prefixLast <= 0xDBFF) prefix = prefix.slice(0, -1);
  let suffix = normalized.slice(-remaining + left);
  const suffixFirst = suffix.charCodeAt(0);
  if (suffixFirst >= 0xDC00 && suffixFirst <= 0xDFFF) suffix = suffix.slice(1);
  return `${prefix}${marker}${suffix}`;
}

function parentChunkFor(
  group: MemoryHistoryRecallTurnGroup,
  chunks: readonly ParentChunk[]
): ParentChunk | null {
  const messageIds = new Set(group.messages.map((message) => message.id));
  const candidates = chunks.flatMap((chunk) => {
    const joins = chunk.messageJoins.filter((join) => messageIds.has(join.messageId));
    if (joins.length === 0) return [];
    const completeMessages = new Set(joins.filter((join) =>
      join.startOffset === 0 && group.messages.some((message) =>
        message.id === join.messageId && message.safeText.length === join.endOffset)
    ).map((join) => join.messageId)).size;
    const startsFirstMessage = joins.some((join) =>
      join.messageId === group.messages[0]?.id && join.startOffset === 0);
    return [{ chunk, completeMessages, startsFirstMessage }];
  });
  return candidates.sort((left, right) =>
    Number(right.completeMessages === messageIds.size) -
      Number(left.completeMessages === messageIds.size) ||
    Number(right.startsFirstMessage) - Number(left.startsFirstMessage) ||
    right.completeMessages - left.completeMessages ||
    left.chunk.ordinal - right.chunk.ordinal ||
    left.chunk.id.localeCompare(right.chunk.id)
  )[0]?.chunk ?? null;
}

function admittedGroup(
  group: MemoryHistoryRecallTurnGroup,
  admission: Readonly<{
    excludedMessageIds?: readonly string[];
    sourceCreatedAtCutoff?: string | null;
  }> | undefined
): boolean {
  const excluded = new Set(admission?.excludedMessageIds ?? []);
  const cutoff = admission?.sourceCreatedAtCutoff
    ? new Date(admission.sourceCreatedAtCutoff)
    : null;
  if (cutoff && !Number.isFinite(cutoff.getTime())) {
    fail("memory_recall_round_admission_invalid");
  }
  return group.messages.every((message) =>
    !excluded.has(message.id) && (cutoff === null || new Date(message.createdAt) > cutoff));
}

export function projectMemoryRecallRounds(
  snapshot: MemorySafeSourceSnapshot,
  chunks: readonly ParentChunk[],
  admission?: Readonly<{
    excludedMessageIds?: readonly string[];
    sourceCreatedAtCutoff?: string | null;
  }>
): readonly MemoryRecallRoundProjection[] {
  if (snapshot.mode !== "NORMAL") return [];
  const groups = snapshot.recallChunkProjection.turnGroups.filter((group) =>
    admittedGroup(group, admission));
  return groups.map((group, ordinal): MemoryRecallRoundProjection => {
    const rendered = renderMessages(group.messages);
    // Every message was already normalized, redacted, and group-checked by
    // the source projection. Re-running the single-message 100k guard after
    // adding trusted speaker labels would reject an otherwise valid bounded
    // turn at the boundary.
    if (!rendered.text ||
      rendered.text.length > MEMORY_RECALL_ROUND_MAX_RAW_CHARACTERS) {
      return fail("memory_recall_round_source_invalid");
    }
    const parent = parentChunkFor(group, chunks);
    if (!parent) return fail("memory_recall_round_parent_missing");
    const evidenceRootHash = memoryHistoryEvidenceRootHash({
      chatId: snapshot.chatId,
      messageJoins: rendered.joins,
      userId: snapshot.userId
    });
    const contentHash = memorySha256({
      evidenceRootHash,
      projectionVersion: MEMORY_RECALL_ROUND_PROJECTION_VERSION,
      rawSafeText: rendered.text,
      sourceProjectionVersion: snapshot.projectionVersion
    });
    const id = memorySha256({
      domain: "aiqsa.memory.recall-round",
      evidenceRootHash,
      projectionVersion: MEMORY_RECALL_ROUND_PROJECTION_VERSION,
      userId: snapshot.userId
    });
    const contextualSearchText = boundedSearchText(rendered.text);
    return {
      approxTokens: estimateApproxTokens(rendered.text),
      branchGeneration: snapshot.branchGeneration,
      chatId: snapshot.chatId,
      contextualKeyPolicyVersion: MEMORY_CONTEXTUAL_KEY_POLICY_VERSION,
      contextualKeyState: "RAW_FALLBACK",
      contextualNarrativeText: rendered.text,
      contextualSearchHash: memorySha256(contextualSearchText),
      contextualSearchText,
      contentHash,
      evidenceRootHash,
      folderId: snapshot.folderId,
      groupId: group.id,
      groupKind: group.kind,
      id,
      languageCode: detectMemoryTextLanguage(rendered.text),
      messageJoins: rendered.joins,
      occurredFrom: group.occurredFrom,
      occurredTo: group.occurredTo,
      ordinal,
      parentChunkId: parent.id,
      projectionVersion: MEMORY_RECALL_ROUND_PROJECTION_VERSION,
      rawSafeText: rendered.text,
      redactionReasonCodes: group.redactionReasonCodes,
      redactionState: group.redactionState,
      safetyClass: group.safetyClass,
      sourceAssistantId: group.sourceAssistantId,
      sourceContentHash: snapshot.sourceContentHash,
      sourceProjectionVersion: snapshot.projectionVersion,
      sourceRevision: snapshot.sourceRevision,
      userId: snapshot.userId
    };
  });
}

export function memoryContextualRoundInputs<
  T extends Readonly<{ id: string; rawSafeText: string }>
>(
  rounds: readonly T[]
): readonly MemoryContextualRoundInput[] {
  return rounds.map((round, index) => ({
    current: { id: round.id, rawSafeText: round.rawSafeText },
    prior: rounds.slice(
      Math.max(0, index - MEMORY_CONTEXTUAL_KEY_MAX_PRIOR_GROUPS),
      index
    ).map((prior) => ({ id: prior.id, rawSafeText: prior.rawSafeText }))
  }));
}

export function memoryContextualKeyEligibleRounds<
  T extends MemoryContextualKeyEligibleRound
>(rounds: readonly T[]): readonly T[] {
  return rounds.filter((round) =>
    round.publicationState === "ACTIVE" &&
    round.redactionState !== "EXCLUDED" &&
    (round.safetyClass === "NORMAL" || round.safetyClass === "SENSITIVE"));
}

const connectorWords = new Set([
  "a", "an", "and", "as", "at", "by", "context", "from", "in", "is",
  "of", "on", "or", "speaker", "the", "to", "was", "with",
  "а", "без", "в", "для", "и", "из", "или", "как", "контекст", "на",
  "о", "от", "по", "с", "спикер", "у"
]);

function words(value: string): readonly string[] {
  return value.normalize("NFKC").toLocaleLowerCase("und")
    .match(/[\p{L}\p{N}_-]+/gu) ?? [];
}

function supportedStatement(statement: string, source: string): boolean {
  if (!statement.trim() || statement.length > 512 || statement.includes("\u0000")) {
    return false;
  }
  const safety = projectMemoryHistorySafeText(statement);
  if (!safety.eligible || safety.safeText !== statement.trim()) return false;
  const sourceWords = new Set(words(source));
  if (words(statement).some((word) =>
    word.length > 1 && !connectorWords.has(word) && !sourceWords.has(word))) {
    return false;
  }
  const sourceNumbers = new Set(source.match(/\p{N}+(?:[.,:/-]\p{N}+)*/gu) ?? []);
  return (statement.match(/\p{N}+(?:[.,:/-]\p{N}+)*/gu) ?? [])
    .every((value) => sourceNumbers.has(value));
}

export function applyMemoryRecallRoundContextualKeys<
  T extends Readonly<{
    contextualKeyPolicyVersion: string;
    contextualKeyState: "GENERATED" | "RAW_FALLBACK";
    contextualNarrativeText: string;
    contextualSearchHash: string;
    contextualSearchText: string;
    id: string;
    publicationState: "ACTIVE" | "SUPPRESSED";
    rawSafeText: string;
    redactionState: "EXCLUDED" | "NOT_NEEDED" | "REDACTED";
    safetyClass: "HIGHLY_SENSITIVE" | "NORMAL" | "SECRET_TAINTED" | "SENSITIVE";
  }>
>(
  rounds: readonly T[],
  outputs: readonly MemoryContextualRoundOutput[],
  policyVersion: string
): readonly T[] {
  if (!policyVersion || policyVersion.length > 64 || /[^A-Za-z0-9._:-]/u.test(policyVersion)) {
    throw new Error("memory_contextual_key_policy_invalid");
  }
  const eligibleRounds = memoryContextualKeyEligibleRounds(rounds);
  const inputByRoundId = new Map(memoryContextualRoundInputs(eligibleRounds).map((input) =>
    [input.current.id, input] as const));
  const outputById = new Map(outputs.map((output) => [output.roundId, output]));
  if (outputById.size !== outputs.length || outputs.some((output) =>
    !rounds.some((round) => round.id === output.roundId))) {
    throw new Error("memory_contextual_key_output_invalid");
  }
  return rounds.map((round) => {
    const output = outputById.get(round.id);
    const input = inputByRoundId.get(round.id);
    if (!input) return round;
    const source = [...input.prior.map((prior) => prior.rawSafeText),
      input.current.rawSafeText].join("\n\n");
    const valid = output && output.statements.length >= 1 &&
      output.statements.length <= 5 &&
      output.statements.every((statement) => supportedStatement(statement, source));
    if (!valid) return round;
    const narrative = output.statements.map((statement) => statement.trim()).join("\n");
    const contextualSearchText = boundedSearchText(
      `Contextual narrative:\n${narrative}\n\nRaw round:\n${round.rawSafeText}`
    );
    return {
      ...round,
      contextualKeyPolicyVersion: policyVersion,
      contextualKeyState: "GENERATED" as const,
      contextualNarrativeText: narrative,
      contextualSearchHash: memorySha256(contextualSearchText),
      contextualSearchText
    } as T;
  });
}
