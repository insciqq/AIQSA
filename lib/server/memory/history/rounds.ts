import { estimateApproxTokens } from "../../../domain/contextBudget";
import {
  memorySha256,
  normalizeMemorySearchText
} from "../persistence/lexical";
import {
  detectMemoryTextLanguage,
  normalizeMemoryLanguageCode,
  type MemoryTextLanguage
} from "./language";
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
  "memory-contextual-narrative-key-v3";
export const MEMORY_CONTEXTUAL_KEY_MAX_PRIOR_GROUPS = 2;
export const MEMORY_RECALL_ROUND_MAX_RAW_CHARACTERS = 200_000;
export const MEMORY_RECALL_ROUND_MAX_SEARCH_CHARACTERS = 4_000;

export const MEMORY_CONTEXTUAL_FALLBACK_REASONS = Object.freeze([
  "NOT_ELIGIBLE",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_OUTPUT_INVALID",
  "HANDLE_MISMATCH",
  "EMPTY_STATEMENTS",
  "STATEMENT_COUNT_INVALID",
  "STATEMENT_TOO_LONG",
  "SAFETY_REDACTED_OR_REJECTED",
  "SOURCE_REF_INVALID",
  "UNSUPPORTED_TOKEN",
  "UNSUPPORTED_NUMBER",
  "UNSUPPORTED_DATE",
  "UNSUPPORTED_ENTITY",
  "DUPLICATE_STATEMENT",
  "SEARCH_TEXT_BUDGET_EXCEEDED"
] as const);

export type MemoryContextualFallbackReason =
  (typeof MEMORY_CONTEXTUAL_FALLBACK_REASONS)[number];

export type MemoryContextualFallbackDiagnostic = Readonly<{
  reason: MemoryContextualFallbackReason;
  roundId: string;
}>;

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
  languageCode: MemoryTextLanguage;
  roundId: string;
  statements: readonly Readonly<{
    sourceRoundIds: readonly string[];
    text: string;
  }>[];
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
      supportingRoundIds: Object.freeze([]),
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

const numberTokenPattern = /\p{N}+(?:[.,:/-]\p{N}+)*/gu;
const numericDatePattern = /\p{N}{1,4}[./-]\p{N}{1,2}(?:[./-]\p{N}{1,4})?/gu;
const entityTokenPattern = /\p{Lu}[\p{L}\p{M}'’.-]+/gu;

function normalizedStatementIdentity(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("und")
    .replace(/\s+/gu, " ").trim();
}

function unsupportedEntityTokens(
  statement: string,
  sourceWords: ReadonlySet<string>
): readonly string[] {
  return (statement.match(entityTokenPattern) ?? []).filter((token) => {
    const normalized = token.normalize("NFKC").toLocaleLowerCase("und");
    return normalized.length > 1 && !connectorWords.has(normalized) &&
      !sourceWords.has(normalized);
  });
}

function hasUnsupportedDate(
  statement: string,
  source: string,
  unsupportedNumbers: ReadonlySet<string>
): boolean {
  const sourceDates = new Set(source.match(numericDatePattern) ?? []);
  if ((statement.match(numericDatePattern) ?? []).some((date) =>
    !sourceDates.has(date))) return true;
  const statementNumbers = statement.match(numberTokenPattern) ?? [];
  const hasYear = statementNumbers.some((value) =>
    /^\p{N}{4}$/u.test(value) && Number(value) >= 1_000 && Number(value) <= 2_999);
  return hasYear && statementNumbers.some((value) =>
    unsupportedNumbers.has(value) && (/^\p{N}{4}$/u.test(value) || Number(value) <= 31));
}

function unsupportedStatementReasons(
  statement: string,
  source: string
): readonly MemoryContextualFallbackReason[] {
  const reasons = new Set<MemoryContextualFallbackReason>();
  if (!statement.trim()) reasons.add("EMPTY_STATEMENTS");
  if (statement.length > 512) reasons.add("STATEMENT_TOO_LONG");
  if (statement.includes("\u0000")) reasons.add("PROVIDER_OUTPUT_INVALID");
  const safety = projectMemoryHistorySafeText(statement);
  if (!safety.eligible || safety.safeText !== statement.trim()) {
    reasons.add("SAFETY_REDACTED_OR_REJECTED");
  }
  const sourceWords = new Set(words(source));
  const unsupportedWords = words(statement).filter((word) =>
    word.length > 1 && !connectorWords.has(word) && !sourceWords.has(word));
  if (unsupportedWords.length > 0) {
    reasons.add("UNSUPPORTED_TOKEN");
  }
  if (unsupportedEntityTokens(statement, sourceWords).length > 0) {
    reasons.add("UNSUPPORTED_ENTITY");
  }
  const sourceNumbers = new Set(source.match(numberTokenPattern) ?? []);
  const unsupportedNumbers = new Set((statement.match(numberTokenPattern) ?? [])
    .filter((value) => !sourceNumbers.has(value)));
  if (unsupportedNumbers.size > 0) {
    reasons.add("UNSUPPORTED_NUMBER");
  }
  if (hasUnsupportedDate(statement, source, unsupportedNumbers)) {
    reasons.add("UNSUPPORTED_DATE");
  }
  return Object.freeze([...reasons]);
}

export function applyMemoryRecallRoundContextualKeysWithDiagnostics<
  T extends Readonly<{
    contextualKeyPolicyVersion: string;
    contextualKeyState: "GENERATED" | "RAW_FALLBACK";
    contextualNarrativeText: string;
    contextualSearchHash: string;
    contextualSearchText: string;
    id: string;
    languageCode: MemoryTextLanguage;
    publicationState: "ACTIVE" | "SUPPRESSED";
    rawSafeText: string;
    redactionState: "EXCLUDED" | "NOT_NEEDED" | "REDACTED";
    safetyClass: "HIGHLY_SENSITIVE" | "NORMAL" | "SECRET_TAINTED" | "SENSITIVE";
    supportingRoundIds: readonly string[];
  }>
>(
  rounds: readonly T[],
  outputs: readonly MemoryContextualRoundOutput[],
  policyVersion: string
): Readonly<{
  fallbackDiagnostics: readonly MemoryContextualFallbackDiagnostic[];
  rounds: readonly T[];
}> {
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
  const fallbackDiagnostics: MemoryContextualFallbackDiagnostic[] = [];
  const projected = rounds.map((round) => {
    const output = outputById.get(round.id);
    const input = inputByRoundId.get(round.id);
    if (!input) return round;
    const sourceByRoundId = new Map([
      ...input.prior.map((prior) => [prior.id, prior.rawSafeText] as const),
      [input.current.id, input.current.rawSafeText] as const
    ]);
    const allowedRoundIds = new Set(sourceByRoundId.keys());
    const reasons = new Set<MemoryContextualFallbackReason>();
    // Missing output is a no-op here: the coordinator owns the explicit
    // target set and assigns PROVIDER_OUTPUT_INVALID only to attempted rounds.
    if (!output) return round;
    const outputLanguageCode = normalizeMemoryLanguageCode(output.languageCode);
    if (!outputLanguageCode) reasons.add("PROVIDER_OUTPUT_INVALID");
    if (output.statements.length < 1 || output.statements.length > 5) {
      reasons.add(output.statements.length === 0
        ? "EMPTY_STATEMENTS"
        : "STATEMENT_COUNT_INVALID");
    }
    const statementIdentities = output.statements.map((statement) =>
      normalizedStatementIdentity(statement.text));
    if (new Set(statementIdentities).size !== statementIdentities.length) {
      reasons.add("DUPLICATE_STATEMENT");
    }
    let currentRoundCited = false;
    for (const statement of output.statements) {
      const citedIds = statement.sourceRoundIds;
      if (citedIds.length < 1 || citedIds.length > 3 ||
        new Set(citedIds).size !== citedIds.length ||
        citedIds.some((id) => !allowedRoundIds.has(id))) {
        reasons.add("SOURCE_REF_INVALID");
        continue;
      }
      if (citedIds.includes(input.current.id)) currentRoundCited = true;
      const citedSource = citedIds.map((id) => sourceByRoundId.get(id)!).join("\n\n");
      for (const reason of unsupportedStatementReasons(statement.text, citedSource)) {
        reasons.add(reason);
      }
    }
    if (!currentRoundCited) reasons.add("SOURCE_REF_INVALID");
    if (reasons.size > 0) {
      for (const reason of reasons) fallbackDiagnostics.push({ reason, roundId: round.id });
      return round;
    }
    const narrative = output.statements.map((statement) => statement.text.trim()).join("\n");
    const citedPriorIds = new Set(output.statements.flatMap((statement) =>
      statement.sourceRoundIds.filter((id) => id !== input.current.id)));
    const supportingRoundIds = input.prior.flatMap((prior) =>
      citedPriorIds.has(prior.id) ? [prior.id] : []);
    const contextualSearchText = boundedSearchText(
      `Contextual narrative:\n${narrative}\n\nRaw round:\n${round.rawSafeText}`
    );
    return {
      ...round,
      contextualKeyPolicyVersion: policyVersion,
      contextualKeyState: "GENERATED" as const,
      contextualNarrativeText: narrative,
      contextualSearchHash: memorySha256(contextualSearchText),
      contextualSearchText,
      languageCode: outputLanguageCode!,
      supportingRoundIds: Object.freeze(supportingRoundIds)
    } as T;
  });
  return Object.freeze({
    fallbackDiagnostics: Object.freeze(fallbackDiagnostics),
    rounds: Object.freeze(projected)
  });
}

export function applyMemoryRecallRoundContextualKeys<
  T extends Readonly<{
    contextualKeyPolicyVersion: string;
    contextualKeyState: "GENERATED" | "RAW_FALLBACK";
    contextualNarrativeText: string;
    contextualSearchHash: string;
    contextualSearchText: string;
    id: string;
    languageCode: MemoryTextLanguage;
    publicationState: "ACTIVE" | "SUPPRESSED";
    rawSafeText: string;
    redactionState: "EXCLUDED" | "NOT_NEEDED" | "REDACTED";
    safetyClass: "HIGHLY_SENSITIVE" | "NORMAL" | "SECRET_TAINTED" | "SENSITIVE";
    supportingRoundIds: readonly string[];
  }>
>(
  rounds: readonly T[],
  outputs: readonly MemoryContextualRoundOutput[],
  policyVersion: string
): readonly T[] {
  return applyMemoryRecallRoundContextualKeysWithDiagnostics(
    rounds,
    outputs,
    policyVersion
  ).rounds;
}
