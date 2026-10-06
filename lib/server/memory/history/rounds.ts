import { estimateApproxTokens } from "../../../domain/contextBudget";
import {
  memorySha256,
  normalizeMemorySearchText
} from "../persistence/lexical";
import {
  detectMemoryTextLanguage,
  type MemoryTextLanguage
} from "./language";
import type {
  MemoryHistoryProjectedMessage,
  MemoryHistoryRecallTurnGroup,
  MemorySafeSourceSnapshot
} from "./sourceProjection";
import type { MemoryRecallChunkMessageJoin } from "./chunking";
import { memoryHistoryEvidenceRootHash } from "./evidenceRoot";

export const MEMORY_RECALL_ROUND_PROJECTION_VERSION =
  "memory-recall-round-projection-v2";
/** Search-key revision every current round and index generation carries. New
 * rounds index their raw text (RAW_FALLBACK); GENERATED narratives exist only
 * on rounds indexed before model enrichment of history was removed. */
export const MEMORY_CONTEXTUAL_KEY_POLICY_VERSION =
  "memory-contextual-narrative-key-v4";
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
  supportingRoundIds: readonly string[];
  userId: string;
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
  // Every message was already normalized, redacted, and join-checked by the
  // source projection, so no single-message guard is repeated here. A round
  // carries its whole turn; a longer turn stays searchable through its
  // bounded recall chunks instead of failing the whole index job.
  const renderedGroups = snapshot.recallChunkProjection.turnGroups
    .filter((group) => admittedGroup(group, admission))
    .flatMap((group) => {
      const rendered = renderMessages(group.messages);
      if (!rendered.text) return fail("memory_recall_round_source_invalid");
      return rendered.text.length > MEMORY_RECALL_ROUND_MAX_RAW_CHARACTERS
        ? []
        : [{ group, rendered }];
    });
  return renderedGroups.map(({ group, rendered }, ordinal): MemoryRecallRoundProjection => {
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
      // A source projection upgrade changes contentHash even when its safe
      // text is identical. Preserve accepted evidence by publishing a new
      // identity instead of conflicting with the immutable prior round.
      sourceProjectionVersion: snapshot.projectionVersion,
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
      supportingRoundIds: Object.freeze([]),
      userId: snapshot.userId
    };
  });
}
