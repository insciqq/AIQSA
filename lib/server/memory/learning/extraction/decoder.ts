import { detectMemoryTextLanguage } from "../../history/language";
import {
  memorySha256,
  memoryStableJson,
  normalizeMemorySearchText
} from "../../persistence/lexical";
import type { ModelToolCall } from "../../../tools/types";
import {
  MEMORY_FACT_MAX_EVIDENCE_PER_CANDIDATE,
  MEMORY_FACT_MAX_OUTPUT_CANDIDATES,
  MEMORY_FACT_TEMPORAL_RESOLVER_VERSION,
  memoryFactCandidateId,
  memoryFactExtractionOutputHash,
  type MemoryExtractedCandidate,
  type MemoryFactCandidateEvidence,
  type MemoryFactCandidateScope,
  type MemoryFactExtractionInput,
  type MemoryFactExtractionPlan
} from "./contract";
import { MEMORY_FACT_EXTRACTION_TOOL_NAME } from "./prompt";
import { memoryFactCandidateSensitivityAllowed } from "./safety";

const exactCandidateKeys = [
  "canonical_key", "category", "confidence", "directness", "display_text",
  "evidence", "importance", "language", "modality", "negated",
  "raw_temporal_expression", "reason_code", "scope", "sensitivity", "state",
  "structured_value", "valid_from", "valid_to"
].sort();
const exactEvidenceKeys = ["message_id", "quote"].sort();
const exactScopeKeys = ["target_id", "type"].sort();
const languageCodes = new Set(["en", "mixed", "ru", "und"]);
const modalities = new Set([
  "CONSIDERATION", "CONSTRAINT", "EVENT", "HABIT", "INTENTION", "PLAN",
  "PREFERENCE", "STATE", "WORKFLOW"
]);
const categoryPattern = /^[a-z][a-z0-9_-]{0,63}$/u;
const canonicalKeyPattern = /^[a-z0-9][a-z0-9._:-]{0,255}$/u;
const controlPattern = /[\u0000-\u001f\u007f]/u;
const considerationPattern = /(?:consider(?:ing)?|thinking about|weighing|unsure about|maybe|might|possibly|рассматрива(?:ю|ем)|думаю (?:о|над)|сравнива(?:ю|ем)|возможно|может быть|не уверен|не уверена)/iu;
const intentionPattern = /(?:intend(?:ing)?|want to|would like to|going to|планирую|намерен|намерена|хочу|собираюсь|хотел бы|хотела бы)/iu;
const planPattern = /(?:my plan|plan to|scheduled to|will (?:start|buy|move|do)|мой план|планирую|запланировал|запланировала|буду (?:делать|покупать|переезжать|начинать))/iu;
const negationPattern = /(?:^|[^\p{L}\p{N}_])(?:not|never|no longer|don't|doesn't|didn't|cannot|can't|won't|не|никогда|больше не|нет)(?=$|[^\p{L}\p{N}_])/iu;
const misleadingNegationPattern = /(?:^|[^\p{L}\p{N}_])(?:not only|не только)(?=$|[^\p{L}\p{N}_])/giu;
const durableGlobalPattern = /(?:i always|i usually|i prefer|my name is|i am (?:a|an)|i work as|i live in|for all my|я всегда|я обычно|я предпочитаю|меня зовут|я работаю|я живу|для меня всегда)/iu;
const projectScopePattern = /(?:this project|current project|for the project|in this workspace|этот проект|текущий проект|для проекта|в этом проекте)/iu;
const relativeTemporalPattern = /(?:today|yesterday|tomorrow|currently|recently|soon|later|this (?:morning|afternoon|evening|weekend|week|month|quarter|year|summer|winter|spring|autumn|fall)|next (?:week|month|quarter|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|last (?:week|month|quarter|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|(?:on )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|(?:in|within) \d+ (?:days?|weeks?|months?|years?)|\d+ (?:days?|weeks?|months?|years?) ago|until (?:the )?end of (?:the )?(?:week|month|quarter|year)|сегодня|вчера|завтра|сейчас|недавно|скоро|позже|этим (?:утром|днём|вечером|летом)|этой (?:ночью|зимой|весной|осенью)|на (?:этих|следующих|прошлых) выходных|на этой неделе|в этом (?:месяце|квартале|году)|на следующей неделе|в следующем (?:месяце|квартале|году)|на прошлой неделе|в прошлом (?:месяце|квартале|году)|в (?:понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье)|через \d+ (?:дн(?:я|ей)|недел(?:ю|и|ь)|месяц(?:а|ев)?|год(?:а|лет)?)|\d+ (?:дн(?:я|ей)|недел(?:ю|и|ь)|месяц(?:а|ев)?|год(?:а|лет)?) назад|до конца (?:недели|месяца|квартала|года)|позапрошлом году)|\d{1,4}[./-]\d{1,2}[./-]\d{1,4}/iu;
const exactTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u;

export class MemoryFactDecodeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MemoryFactDecodeError";
  }
}

function fail(code = "memory_fact_output_invalid"): never {
  throw new MemoryFactDecodeError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]);
}

function exactString(
  value: unknown,
  maxLength: number,
  pattern?: RegExp
): string {
  if (
    typeof value !== "string" || value.trim() !== value || !value ||
    value.length > maxLength || controlPattern.test(value) ||
    (pattern && !pattern.test(value))
  ) fail();
  return value;
}

function score(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    fail();
  }
  return value;
}

function nullableString(value: unknown, maxLength: number): string | null {
  return value === null ? null : exactString(value, maxLength);
}

function canonicalTimestamp(value: unknown): string | null {
  if (value === null) return null;
  const text = exactString(value, 64);
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.getTime())) fail("memory_fact_temporal_invalid");
  return parsed.toISOString();
}

function structuredValueStrings(
  value: unknown,
  depth = 0
): Array<string | number> {
  if (depth > 6) fail("memory_fact_structured_value_invalid");
  if (value === null || typeof value === "boolean") return [];
  if (typeof value === "string") {
    if (!value || value.length > 1_000 || controlPattern.test(value)) {
      fail("memory_fact_structured_value_invalid");
    }
    return [value];
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("memory_fact_structured_value_invalid");
    return [value];
  }
  if (Array.isArray(value)) {
    if (value.length > 32) fail("memory_fact_structured_value_invalid");
    return value.flatMap((entry) => structuredValueStrings(entry, depth + 1));
  }
  if (!isRecord(value) || Object.keys(value).length > 32) {
    fail("memory_fact_structured_value_invalid");
  }
  for (const key of Object.keys(value)) {
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/u.test(key)) {
      fail("memory_fact_structured_value_invalid");
    }
  }
  return Object.values(value).flatMap((entry) =>
    structuredValueStrings(entry, depth + 1));
}

function decodeEvidence(
  value: unknown,
  input: MemoryFactExtractionInput
): MemoryFactCandidateEvidence[] {
  if (!Array.isArray(value) || value.length < 1 ||
    value.length > MEMORY_FACT_MAX_EVIDENCE_PER_CANDIDATE) fail();
  const messageIds = new Set<string>();
  return value.map((entry) => {
    if (!isRecord(entry) || !hasExactKeys(entry, exactEvidenceKeys)) fail();
    const messageId = exactString(entry.message_id, 256);
    const quote = exactString(entry.quote, 2_000);
    if (messageIds.has(messageId)) fail("memory_fact_evidence_ambiguous");
    messageIds.add(messageId);
    const message = input.messages.find((candidate) => candidate.id === messageId);
    if (!message) fail("memory_fact_evidence_invalid");
    const startOffset = message.text.indexOf(quote);
    if (startOffset < 0 || startOffset !== message.text.lastIndexOf(quote)) {
      fail("memory_fact_evidence_ungrounded");
    }
    const endOffset = startOffset + quote.length;
    return {
      endOffset,
      messageId,
      sourceTextHash: memorySha256(message.text),
      startOffset
    };
  });
}

function evidenceText(
  input: MemoryFactExtractionInput,
  evidence: readonly MemoryFactCandidateEvidence[]
): string {
  return evidence.map((item) => {
    const message = input.messages.find((candidate) => candidate.id === item.messageId);
    if (!message || memorySha256(message.text) !== item.sourceTextHash) {
      return fail("memory_fact_evidence_invalid");
    }
    return message.text.slice(item.startOffset, item.endOffset);
  }).join("\n");
}

function decodeScope(
  value: unknown,
  input: MemoryFactExtractionInput,
  text: string
): Readonly<{ deferred: boolean; scope: MemoryFactCandidateScope }> {
  if (!isRecord(value) || !hasExactKeys(value, exactScopeKeys)) fail();
  const type = exactString(value.type, 32);
  const targetId = value.target_id === null
    ? null
    : exactString(value.target_id, 256);
  if (type === "CHAT") {
    if (targetId !== input.source.chatId) fail("memory_fact_scope_invalid");
    return { deferred: false, scope: { targetId, type } };
  }
  if (type === "FOLDER") {
    if (!input.folderId || targetId !== input.folderId) {
      return fail("memory_fact_scope_invalid");
    }
    return projectScopePattern.test(text)
      ? { deferred: false, scope: { targetId, type } }
      : {
          deferred: false,
          scope: { targetId: input.source.chatId, type: "CHAT" }
        };
  }
  if (type === "GLOBAL_USER") {
    if (targetId !== null) fail("memory_fact_scope_invalid");
    return durableGlobalPattern.test(text)
      ? { deferred: false, scope: { targetId: null, type } }
      : {
          deferred: false,
          scope: { targetId: input.source.chatId, type: "CHAT" }
        };
  }
  if (type === "ASSISTANT") {
    if (!targetId) fail("memory_fact_scope_invalid");
    return {
      deferred: true,
      scope: { targetId: input.source.chatId, type: "CHAT" }
    };
  }
  return fail("memory_fact_scope_invalid");
}

function temporalCue(text: string): string | null {
  const match = relativeTemporalPattern.exec(text);
  return match?.[0] ?? null;
}

function decodeTemporal(
  rawValue: unknown,
  fromValue: unknown,
  toValue: unknown,
  text: string,
  input: MemoryFactExtractionInput
): Readonly<{
  deferred: boolean;
  evidence: Readonly<Record<string, unknown>> | null;
  raw: string | null;
  validFrom: string | null;
  validTo: string | null;
}> {
  let raw = nullableString(rawValue, 512);
  const cue = temporalCue(text);
  if (raw && !text.includes(raw)) fail("memory_fact_temporal_ungrounded");
  if (!raw && cue) raw = cue;
  const validFrom = canonicalTimestamp(fromValue);
  const validTo = canonicalTimestamp(toValue);
  if (validFrom && validTo && validFrom > validTo) {
    fail("memory_fact_temporal_invalid");
  }
  if (raw === null) {
    if (validFrom !== null || validTo !== null) fail("memory_fact_temporal_invalid");
    return {
      deferred: false,
      evidence: null,
      raw: null,
      validFrom: null,
      validTo: null
    };
  }
  if (exactTimestampPattern.test(raw)) {
    const resolved = new Date(raw).toISOString();
    if (validFrom !== resolved || validTo !== null) {
      fail("memory_fact_temporal_invalid");
    }
    return {
      deferred: false,
      evidence: {
        expression: raw,
        resolvedInstant: resolved,
        resolverVersion: MEMORY_FACT_TEMPORAL_RESOLVER_VERSION,
        timeZone: input.timeZone
      },
      raw,
      validFrom,
      validTo
    };
  }
  if (validFrom !== null || validTo !== null) fail("memory_fact_temporal_invalid");
  return {
    deferred: true,
    evidence: {
      expression: raw,
      reason: "relative_or_date_only_requires_later_resolution",
      resolverVersion: MEMORY_FACT_TEMPORAL_RESOLVER_VERSION,
      sourceCreatedAt: input.messages
        .filter((message) => text.includes(message.text) || message.text.includes(raw!))
        .map((message) => message.createdAt),
      timeZone: input.timeZone
    },
    raw,
    validFrom: null,
    validTo: null
  };
}

function validateModality(
  modality: MemoryExtractedCandidate["modality"],
  text: string
): void {
  if (considerationPattern.test(text) && modality !== "CONSIDERATION") {
    fail("memory_fact_modality_invalid");
  }
  if (planPattern.test(text) && modality !== "PLAN") {
    fail("memory_fact_modality_invalid");
  }
  if (
    !planPattern.test(text) && intentionPattern.test(text) &&
    modality !== "INTENTION" && modality !== "CONSIDERATION"
  ) fail("memory_fact_modality_invalid");
}

function decodeCandidate(
  value: unknown,
  input: MemoryFactExtractionInput
): MemoryExtractedCandidate {
  if (!isRecord(value) || !hasExactKeys(value, exactCandidateKeys)) fail();
  const evidence = decodeEvidence(value.evidence, input);
  const sourceText = evidenceText(input, evidence);
  const displayText = exactString(value.display_text, 2_000);
  if (!evidence.some((item) => {
    const message = input.messages.find((candidate) => candidate.id === item.messageId)!;
    return message.text.slice(item.startOffset, item.endOffset) === displayText;
  })) fail("memory_fact_output_ungrounded");
  if (typeof value.language !== "string" || !languageCodes.has(value.language) ||
    detectMemoryTextLanguage(displayText) !== value.language) {
    fail("memory_fact_language_invalid");
  }
  const canonicalKey = exactString(value.canonical_key, 256, canonicalKeyPattern);
  const category = exactString(value.category, 64, categoryPattern);
  if (typeof value.modality !== "string" || !modalities.has(value.modality)) fail();
  const modality = value.modality as MemoryExtractedCandidate["modality"];
  validateModality(modality, sourceText);
  if (value.directness !== "DIRECT" || value.sensitivity !== "NORMAL") {
    fail("memory_fact_sensitivity_or_directness_invalid");
  }
  if (!memoryFactCandidateSensitivityAllowed(sourceText, category, displayText)) {
    fail("memory_fact_sensitive_output_rejected");
  }
  const explicitNegation = negationPattern.test(
    displayText.replace(misleadingNegationPattern, " ")
  );
  if (typeof value.negated !== "boolean" || value.negated !== explicitNegation) {
    fail("memory_fact_negation_invalid");
  }
  const proposedValue = value.structured_value;
  let encodedValue: string;
  try {
    encodedValue = memoryStableJson(proposedValue);
  } catch {
    return fail("memory_fact_structured_value_invalid");
  }
  if (!encodedValue || encodedValue.length > 8_192) {
    fail("memory_fact_structured_value_invalid");
  }
  const normalizedSource = normalizeMemorySearchText(sourceText);
  if (structuredValueStrings(proposedValue).some((entry) =>
    !normalizedSource.includes(normalizeMemorySearchText(String(entry))))) {
    fail("memory_fact_output_ungrounded");
  }
  const scope = decodeScope(value.scope, input, sourceText);
  const temporal = decodeTemporal(
    value.raw_temporal_expression,
    value.valid_from,
    value.valid_to,
    sourceText,
    input
  );
  const importance = score(value.importance);
  const confidence = score(value.confidence);
  if (typeof value.state !== "string" ||
    !["PENDING", "DEFERRED"].includes(value.state)) fail();
  const proposedReason = value.reason_code === null
    ? null
    : exactString(value.reason_code, 64);
  const requiredReason = temporal.deferred
    ? "temporal_unresolved"
    : scope.deferred
      ? "scope_ambiguous"
      : confidence < 0.7
        ? "low_confidence"
        : null;
  const state = requiredReason === null ? "PENDING" : "DEFERRED";
  if (value.state !== state || proposedReason !== requiredReason) {
    fail("memory_fact_candidate_state_invalid");
  }
  const withoutId: Omit<MemoryExtractedCandidate, "id"> = {
    canonicalKey,
    category,
    confidence,
    directness: "DIRECT",
    displayText,
    evidence,
    importance,
    languageCode: value.language as MemoryExtractedCandidate["languageCode"],
    modality,
    negated: value.negated,
    proposedValue,
    rawTemporalExpression: temporal.raw,
    reasonCode: requiredReason,
    scope: scope.scope,
    sensitivity: "NORMAL",
    state,
    temporalResolutionEvidence: temporal.evidence,
    validFrom: temporal.validFrom,
    validTo: temporal.validTo
  };
  return { ...withoutId, id: memoryFactCandidateId(input, withoutId) };
}

export function decodeMemoryFactExtraction(
  calls: readonly ModelToolCall[] | undefined,
  input: MemoryFactExtractionInput
): MemoryFactExtractionPlan {
  if (
    !calls || calls.length !== 1 ||
    calls[0]?.name !== MEMORY_FACT_EXTRACTION_TOOL_NAME ||
    !isRecord(calls[0].arguments) ||
    !hasExactKeys(calls[0].arguments, ["candidates"]) ||
    !Array.isArray(calls[0].arguments.candidates) ||
    calls[0].arguments.candidates.length > MEMORY_FACT_MAX_OUTPUT_CANDIDATES
  ) fail();
  const candidates = calls[0].arguments.candidates.map((candidate) =>
    decodeCandidate(candidate, input));
  if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) {
    fail("memory_fact_duplicate_candidate");
  }
  return {
    candidates,
    input,
    outputHash: memoryFactExtractionOutputHash(input, candidates)
  };
}
