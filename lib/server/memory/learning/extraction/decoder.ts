import { memorySha256 } from "../../persistence/lexical";
import { memoryExplicitStatementContainsSecret } from "../../explicit/safety";
import type { ModelToolCall } from "../../../tools/types";
import {
  MEMORY_FACT_DURABLE_CATEGORIES,
  MEMORY_FACT_MAX_ACCEPTED_CANDIDATES,
  MEMORY_FACT_MAX_PACKET_CANDIDATES,
  memoryFactCandidateId,
  memoryFactExtractionOutputHash,
  type MemoryExtractedCandidate,
  type MemoryFactExtractionInput,
  type MemoryFactExtractionPlan
} from "./contract";
import { MEMORY_FACT_EXTRACTION_TOOL_NAME } from "./prompt";

const controlSyntax = /[\u0000-\u001f\u007f]/u;

const v1CandidateKeys = [
  "category",
  "confidence_band",
  "correction",
  "future_useful",
  "quote",
  "reason_code",
  "response_preference",
  "sensitivity",
  "statement",
  "temporary"
].sort();
const v1ConfidenceBands = new Set(["HIGH", "MEDIUM", "LOW"]);
const v1Sensitivities = new Set(["NORMAL", "SENSITIVE", "SECRET", "UNCERTAIN"]);

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

function v1RejectionCode(error: unknown):
  "REJECT_AMBIGUOUS" | "REJECT_DUPLICATE" | "REJECT_LOW_CONFIDENCE" | "REJECT_SECRET" |
  "REJECT_STALE_SOURCE" | "REJECT_TEMPORARY" |
  "REJECT_UNSUPPORTED" {
  if (!(error instanceof MemoryFactDecodeError)) return "REJECT_UNSUPPORTED";
  if (error.code === "memory_fact_evidence_ambiguous") return "REJECT_AMBIGUOUS";
  if (error.code === "memory_fact_source_stale") return "REJECT_STALE_SOURCE";
  if (error.code === "memory_fact_confidence_low") return "REJECT_LOW_CONFIDENCE";
  if (error.code === "memory_fact_temporary") return "REJECT_TEMPORARY";
  if (error.code === "memory_fact_secret") return "REJECT_SECRET";
  return "REJECT_UNSUPPORTED";
}

function v1CandidateModality(category: string): MemoryExtractedCandidate["modality"] {
  if (category === "preferences" || category === "communication_preference") {
    return "PREFERENCE";
  }
  if (category === "constraints_routines" || category === "constraint") {
    return "CONSTRAINT";
  }
  if (category === "goals" || category === "goal") return "INTENTION";
  if (category === "work" || category === "professional_role") return "WORKFLOW";
  return "STATE";
}

function decodeV1Candidate(
  value: unknown,
  input: MemoryFactExtractionInput
): MemoryExtractedCandidate {
  if (!isRecord(value) || !hasExactKeys(value, v1CandidateKeys)) fail();
  if (input.messages.length !== 1) fail("memory_fact_source_stale");
  const source = input.messages[0];
  if (!source) fail("memory_fact_source_stale");
  const statement = boundedString(value.statement, 2_000);
  const quote = boundedString(value.quote, 2_000);
  if (
    memoryExplicitStatementContainsSecret(statement) ||
    memoryExplicitStatementContainsSecret(quote)
  ) fail("memory_fact_secret");
  const category = boundedString(value.category, 64);
  if (!(MEMORY_FACT_DURABLE_CATEGORIES as readonly string[]).includes(category)) {
    fail("memory_fact_category_unsupported");
  }
  if (typeof value.confidence_band !== "string" ||
    !v1ConfidenceBands.has(value.confidence_band)) fail();
  if (value.confidence_band !== "HIGH") fail("memory_fact_confidence_low");
  if (typeof value.temporary !== "boolean") fail();
  if (value.temporary) fail("memory_fact_temporary");
  if (typeof value.future_useful !== "boolean" || !value.future_useful) {
    fail("memory_fact_unsupported");
  }
  if (typeof value.correction !== "boolean") fail();
  if (typeof value.sensitivity !== "string" ||
    !v1Sensitivities.has(value.sensitivity)) fail();
  if (value.sensitivity === "SECRET") fail("memory_fact_secret");
  if (value.sensitivity === "UNCERTAIN") fail("memory_fact_unsupported");
  if (value.response_preference !== null) {
    const responsePreference = boundedString(value.response_preference, 512);
    if (memoryExplicitStatementContainsSecret(responsePreference)) {
      fail("memory_fact_secret");
    }
  }
  boundedString(value.reason_code, 64);

  // String offsets are UTF-16 code-unit offsets in JavaScript.  The server,
  // not the model, resolves them and records the source hash.  A repeated
  // quote is deliberately ambiguous and is rejected independently.
  const startOffset = source.text.indexOf(quote);
  if (startOffset < 0) fail("memory_fact_evidence_invalid");
  if (source.text.indexOf(quote, startOffset + quote.length) >= 0) {
    fail("memory_fact_evidence_ambiguous");
  }
  const endOffset = startOffset + quote.length;
  const sourceTextHash = memorySha256(source.text);
  const evidence = [{
    endOffset,
    messageId: source.id,
    quote,
    sourceTextHash,
    startOffset
  }];
  const responsePreference = value.response_preference as string | null;
  const base = {
    category,
    confidence: 1,
    confidenceBand: "HIGH" as const,
    correction: value.correction,
    coreEligible: responsePreference !== null,
    coreSalience: responsePreference !== null ? "HIGH" as const : "NONE" as const,
    directness: "DIRECT" as const,
    displayText: statement,
    evidence,
    futureUseful: true,
    importance: 0.5,
    languageCode: source.languageCode,
    modality: v1CandidateModality(category),
    negated: false as const,
    proposedValue: responsePreference === null
      ? { correction: value.correction, statement }
      : { correction: value.correction, responsePreference, statement },
    quote,
    rawTemporalExpression: null,
    reasonCode: null,
    responsePreference,
    scope: { targetId: null, type: "GLOBAL_USER" as const },
    sensitivity: "NORMAL" as const,
    state: "PENDING" as const,
    statement,
    temporary: false,
    temporalResolutionEvidence: null,
    validFrom: null,
    validTo: null
  };
  const canonicalKey = `auto.${memorySha256({
    category,
    domain: "aiqsa.memory.personal-v1",
    statement
  })}`;
  const withoutId: Omit<MemoryExtractedCandidate, "id"> = {
    ...base,
    canonicalKey
  };
  return { ...withoutId, id: memoryFactCandidateId(input, withoutId) };
}

/** Strict v1 decoder. Invalid candidates are isolated so a bad sibling does
 * not discard valid candidates from the same packet. */
export function decodeMemoryFactExtractionV1(
  calls: readonly ModelToolCall[] | undefined,
  input: MemoryFactExtractionInput
): MemoryFactExtractionPlan {
  if (
    !calls || calls.length !== 1 ||
    calls[0]?.name !== MEMORY_FACT_EXTRACTION_TOOL_NAME ||
    !isRecord(calls[0].arguments) ||
    !hasExactKeys(calls[0].arguments, ["candidates"]) ||
    !Array.isArray(calls[0].arguments.candidates) ||
    calls[0].arguments.candidates.length > MEMORY_FACT_MAX_PACKET_CANDIDATES
  ) fail();
  const raw = calls[0].arguments.candidates;
  const candidates: Array<{
    candidate: MemoryExtractedCandidate;
    candidateOrdinal: number;
  }> = [];
  const rejections: Array<{
    candidateOrdinal: number;
    reasonCode: "REJECT_AMBIGUOUS" | "REJECT_DUPLICATE" | "REJECT_LOW_CONFIDENCE" | "REJECT_SECRET" |
      "REJECT_STALE_SOURCE" | "REJECT_TEMPORARY" |
      "REJECT_UNSUPPORTED";
  }> = [];
  raw.forEach((value, candidateOrdinal) => {
    try {
      candidates.push({
        candidate: decodeV1Candidate(value, input),
        candidateOrdinal
      });
    } catch (error) {
      rejections.push({ candidateOrdinal, reasonCode: v1RejectionCode(error) });
    }
  });
  const unique = new Map<string, {
    candidate: MemoryExtractedCandidate;
    candidateOrdinal: number;
  }>();
  for (const decoded of candidates) {
    if (unique.has(decoded.candidate.id)) {
      rejections.push({
        candidateOrdinal: decoded.candidateOrdinal,
        reasonCode: "REJECT_DUPLICATE"
      });
      continue;
    }
    unique.set(decoded.candidate.id, decoded);
  }
  const uniqueValues = [...unique.values()];
  if (uniqueValues.length > MEMORY_FACT_MAX_ACCEPTED_CANDIDATES) {
    for (let ordinal = MEMORY_FACT_MAX_ACCEPTED_CANDIDATES;
      ordinal < uniqueValues.length;
      ordinal += 1) {
      rejections.push({
        candidateOrdinal: uniqueValues[ordinal]!.candidateOrdinal,
        reasonCode: "REJECT_UNSUPPORTED"
      });
    }
  }
  const accepted = uniqueValues
    .slice(0, MEMORY_FACT_MAX_ACCEPTED_CANDIDATES)
    .map(({ candidate }) => candidate);
  return {
    candidates: accepted,
    input,
    outputHash: memoryFactExtractionOutputHash(input, accepted),
    rejections
  };
}

/** Only the Personal Memory v1 strict packet is executable. Retired packet
 * shapes fail closed instead of replaying obsolete model-authored fields. */
export function decodeMemoryFactExtraction(
  calls: readonly ModelToolCall[] | undefined,
  input: MemoryFactExtractionInput
): MemoryFactExtractionPlan {
  return decodeMemoryFactExtractionV1(calls, input);
}
