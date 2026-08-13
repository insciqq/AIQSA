import { memorySha256, memoryStableJson } from "../../persistence/lexical";
import type { ModelToolCall } from "../../../tools/types";
import {
  MEMORY_FACT_MAX_EVIDENCE_PER_CANDIDATE,
  MEMORY_FACT_MAX_OUTPUT_CANDIDATES,
  memoryFactCandidateId,
  memoryFactExtractionOutputHash,
  type MemoryExtractedCandidate,
  type MemoryFactCandidateEvidence,
  type MemoryFactCandidateScope,
  type MemoryFactExtractionInput,
  type MemoryFactExtractionPlan
} from "./contract";
import { MEMORY_FACT_EXTRACTION_TOOL_NAME } from "./prompt";

const exactCandidateKeys = [
  "core_eligible", "core_salience", "directness", "display_text", "evidence",
  "language", "modality", "raw_temporal_expression", "scope", "sensitivity",
  "structured_value", "valid_from", "valid_to"
].sort();
const exactEvidenceKeys = ["end_offset", "message_id", "start_offset"].sort();
const exactScopeKeys = ["target_id", "type"].sort();
const modalities = new Set([
  "CONSIDERATION", "CONSTRAINT", "EVENT", "HABIT", "INTENTION", "PLAN",
  "PREFERENCE", "STATE", "WORKFLOW"
]);
const coreSaliences = new Set(["HIGH", "MEDIUM", "LOW", "NONE"]);
const isoTimestampSyntax =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
const controlSyntax = /[\u0000-\u001f\u007f]/u;

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

function boundedString(value: unknown, maxLength: number): string {
  if (
    typeof value !== "string" || value.trim() !== value || !value ||
    value.length > maxLength || controlSyntax.test(value)
  ) fail();
  return value;
}

function nullableString(value: unknown, maxLength: number): string | null {
  return value === null ? null : boundedString(value, maxLength);
}

function boundedJson(value: unknown, depth = 0): void {
  if (depth > 6) fail("memory_fact_structured_value_invalid");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (!value || value.length > 2_000 || controlSyntax.test(value)) {
      fail("memory_fact_structured_value_invalid");
    }
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("memory_fact_structured_value_invalid");
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 32) fail("memory_fact_structured_value_invalid");
    for (const entry of value) boundedJson(entry, depth + 1);
    return;
  }
  if (!isRecord(value) || Object.keys(value).length > 32) {
    fail("memory_fact_structured_value_invalid");
  }
  for (const [key, entry] of Object.entries(value)) {
    if (!key || key.length > 64 || controlSyntax.test(key)) {
      fail("memory_fact_structured_value_invalid");
    }
    boundedJson(entry, depth + 1);
  }
}

function decodeStructuredValue(value: unknown): unknown {
  const encoded = boundedString(value, 8_192);
  let decoded: unknown;
  try {
    decoded = JSON.parse(encoded) as unknown;
  } catch {
    return fail("memory_fact_structured_value_invalid");
  }
  boundedJson(decoded);
  if (memoryStableJson(decoded).length > 8_192) {
    fail("memory_fact_structured_value_invalid");
  }
  return decoded;
}

function languageTag(value: unknown): string {
  const tag = boundedString(value, 35);
  if (tag === "und") return tag;
  try {
    new Intl.Locale(tag);
    return tag;
  } catch {
    return fail("memory_fact_language_invalid");
  }
}

function timestamp(value: unknown): string | null {
  if (value === null) return null;
  const text = boundedString(value, 64);
  if (!isoTimestampSyntax.test(text)) fail("memory_fact_temporal_invalid");
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) fail("memory_fact_temporal_invalid");
  return date.toISOString();
}

function decodeEvidence(
  value: unknown,
  input: MemoryFactExtractionInput
): MemoryFactCandidateEvidence[] {
  if (
    !Array.isArray(value) || value.length < 1 ||
    value.length > MEMORY_FACT_MAX_EVIDENCE_PER_CANDIDATE
  ) fail();
  const seenMessages = new Set<string>();
  return value.map((entry) => {
    if (!isRecord(entry) || !hasExactKeys(entry, exactEvidenceKeys)) fail();
    const messageId = boundedString(entry.message_id, 256);
    if (seenMessages.has(messageId)) fail("memory_fact_evidence_ambiguous");
    seenMessages.add(messageId);
    if (!Number.isSafeInteger(entry.start_offset) ||
      !Number.isSafeInteger(entry.end_offset)) fail("memory_fact_evidence_invalid");
    const startOffset = Number(entry.start_offset);
    const endOffset = Number(entry.end_offset);
    const message = input.messages.find((candidate) => candidate.id === messageId);
    if (
      !message || startOffset < 0 || endOffset <= startOffset ||
      endOffset > message.text.length
    ) fail("memory_fact_evidence_invalid");
    return {
      endOffset,
      messageId,
      sourceTextHash: memorySha256(message.text),
      startOffset
    };
  });
}

function decodeScope(
  value: unknown,
  input: MemoryFactExtractionInput
): MemoryFactCandidateScope {
  if (!isRecord(value) || !hasExactKeys(value, exactScopeKeys)) fail();
  const type = boundedString(value.type, 32);
  const targetId = value.target_id === null
    ? null
    : boundedString(value.target_id, 256);
  if (type === "GLOBAL_USER" && targetId === null) {
    return { targetId: null, type };
  }
  if (type === "CHAT" && targetId === input.source.chatId) {
    return { targetId, type };
  }
  if (type === "FOLDER" && input.folderId !== null && targetId === input.folderId) {
    return { targetId, type };
  }
  return fail("memory_fact_scope_invalid");
}

function decodeCandidate(
  value: unknown,
  input: MemoryFactExtractionInput
): MemoryExtractedCandidate {
  if (!isRecord(value) || !hasExactKeys(value, exactCandidateKeys)) fail();
  const evidence = decodeEvidence(value.evidence, input);
  const displayText = boundedString(value.display_text, 2_000);
  const proposedValue = decodeStructuredValue(value.structured_value);
  if (typeof value.modality !== "string" || !modalities.has(value.modality)) fail();
  if (value.directness !== "DIRECT" && value.directness !== "PARAPHRASED") {
    fail("memory_fact_directness_invalid");
  }
  if (value.sensitivity !== "NORMAL") fail("memory_fact_sensitivity_invalid");
  if (typeof value.core_eligible !== "boolean" ||
    typeof value.core_salience !== "string" ||
    !coreSaliences.has(value.core_salience)) fail("memory_fact_core_invalid");
  if (
    (value.core_eligible && value.core_salience === "NONE") ||
    (!value.core_eligible && value.core_salience !== "NONE")
  ) fail("memory_fact_core_invalid");
  const validFrom = timestamp(value.valid_from);
  const validTo = timestamp(value.valid_to);
  if (validFrom && validTo && validFrom > validTo) {
    fail("memory_fact_temporal_invalid");
  }
  const base = {
    category: "memory",
    confidence: 0.5,
    coreEligible: value.core_eligible,
    coreSalience: value.core_salience as MemoryExtractedCandidate["coreSalience"],
    directness: value.directness as MemoryExtractedCandidate["directness"],
    displayText,
    evidence,
    importance: 0.5,
    languageCode: languageTag(value.language),
    modality: value.modality as MemoryExtractedCandidate["modality"],
    negated: false as const,
    proposedValue,
    rawTemporalExpression: nullableString(value.raw_temporal_expression, 512),
    reasonCode: null,
    scope: decodeScope(value.scope, input),
    sensitivity: "NORMAL" as const,
    state: "PENDING" as const,
    temporalResolutionEvidence: null,
    validFrom,
    validTo
  };
  const candidateId = memoryFactCandidateId(input, {
    ...base,
    canonicalKey: "auto.pending"
  });
  const withoutId: Omit<MemoryExtractedCandidate, "id"> = {
    ...base,
    canonicalKey: `auto.${candidateId}`
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
    !hasExactKeys(calls[0].arguments, ["candidates", "decision"]) ||
    !Array.isArray(calls[0].arguments.candidates) ||
    calls[0].arguments.candidates.length > MEMORY_FACT_MAX_OUTPUT_CANDIDATES ||
    (calls[0].arguments.decision !== "STORE" &&
      calls[0].arguments.decision !== "ABSTAIN")
  ) fail();
  const store = calls[0].arguments.decision === "STORE";
  if (store !== (calls[0].arguments.candidates.length > 0)) {
    fail("memory_fact_decision_invalid");
  }
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
