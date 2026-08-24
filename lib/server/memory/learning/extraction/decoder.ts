import type { ModelToolCall } from "../../../tools/types";
import { memoryExplicitStatementContainsSecret } from "../../explicit/safety";
import { memorySha256 } from "../../persistence/lexical";
import {
  memoryEvidenceLooksNonAuthoritative,
  memoryProductStatusEvidenceIsExplicit,
  resolveMemoryIdentity,
  type MemoryIdentityEntityType,
  type MemoryIdentityProposal,
  type MemoryValueProposal
} from "../identity/registry";
import {
  resolveMemoryTemporal,
  type MemoryTemporalProposal
} from "../temporal/resolver";
import {
  MEMORY_FACT_DURABLE_CATEGORIES,
  MEMORY_FACT_MAX_ACCEPTED_CANDIDATES,
  MEMORY_FACT_MAX_PACKET_CANDIDATES,
  memoryFactCandidateId,
  memoryFactExtractionOutputHash,
  memoryFactNormalizedValue,
  type MemoryExtractedCandidate,
  type MemoryFactCandidateRejection,
  type MemoryFactCandidateDependency,
  type MemoryFactCandidateEntity,
  type MemoryFactExtractionInput,
  type MemoryFactExtractionPlan
} from "./contract";
import {
  memoryEntityAliasIsPronoun,
  memoryEntityType
} from "../entities/normalization";
import { memoryPropositionCanonicalKey } from "../identity/normalization";
import { MEMORY_FACT_EXTRACTION_TOOL_NAME } from "./prompt";

const controlSyntax = /[\u0000-\u001f\u007f]/u;
const confidenceBands = new Set(["HIGH", "MEDIUM", "LOW"]);
const sensitivities = new Set(["NORMAL", "SENSITIVE", "SECRET", "UNCERTAIN"]);
const memoryTypes = new Set([
  "STATE", "PREFERENCE", "CONSTRAINT", "CONSIDERATION", "INTENTION", "PLAN",
  "EVENT", "HABIT", "WORKFLOW"
]);
const identityEntityTypes = new Set([
  "NONE", "PERSON_SELF", "PRODUCT", "DEVICE", "SERVICE", "GOAL", "PROJECT"
]);
const entityTypes = new Set([
  "PERSON_SELF", "PERSON", "ORGANIZATION", "PLACE", "PRODUCT", "DEVICE",
  "SERVICE", "GOAL", "PROJECT", "OTHER"
]);
const entityRoles = new Set(["SUBJECT", "OBJECT", "MENTION"]);

const legacyCandidateKeys = [
  "category", "confidence_band", "correction", "future_useful", "quote",
  "reason_code", "response_preference", "sensitivity", "statement", "temporary"
].sort();
const observationKeys = [
  "confidence_band", "correction", "dependency_refs", "entities",
  "future_useful", "identity", "memory_type", "quote", "reason_code",
  "sensitivity", "statement", "temporal", "temporary", "value"
].sort();
const identityKeys = ["dimension_key", "mode", "predicate_key", "subject"].sort();
const subjectKeys = ["canonical_label", "entity_type", "qualifiers"].sort();
const qualifierKeys = ["brand", "model"].sort();
const valueKeys = [
  "frequency", "kind", "limit", "place", "role", "schedule", "state",
  "strength", "value"
].sort();
const temporalKeys = [
  "expected_at", "expires_at", "occurred_at", "raw_expression", "valid_from",
  "valid_to"
].sort();
const entityKeys = [
  "aliases", "canonical_label", "context_entity_ref", "entity_type",
  "mention", "role"
].sort();

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

function requiredBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") fail();
  return value;
}

function rejectionCode(error: unknown): MemoryFactCandidateRejection["reasonCode"] {
  if (!(error instanceof MemoryFactDecodeError)) return "REJECT_UNSUPPORTED";
  if (error.code === "memory_fact_evidence_ambiguous") return "REJECT_AMBIGUOUS";
  if (error.code === "memory_fact_source_stale") return "REJECT_STALE_SOURCE";
  if (error.code === "memory_fact_confidence_low") return "REJECT_LOW_CONFIDENCE";
  if (error.code === "memory_fact_temporary") return "REJECT_TEMPORARY";
  if (error.code === "memory_fact_secret") return "REJECT_SECRET";
  return "REJECT_UNSUPPORTED";
}

function targetSource(input: MemoryFactExtractionInput) {
  const eligible = input.messages.filter((message) => message.evidenceEligible);
  const source = eligible.length === 1 &&
    eligible[0]?.id === input.source.sourceMessageId &&
    eligible[0].role === "user"
    ? eligible[0]
    : null;
  if (!source) fail("memory_fact_source_stale");
  return source;
}

function exactEvidence(
  input: MemoryFactExtractionInput,
  quote: string
): MemoryExtractedCandidate["evidence"] {
  const source = targetSource(input);
  const startOffset = source.text.indexOf(quote);
  if (startOffset < 0) fail("memory_fact_evidence_invalid");
  if (source.text.indexOf(quote, startOffset + quote.length) >= 0) {
    fail("memory_fact_evidence_ambiguous");
  }
  return [{
    endOffset: startOffset + quote.length,
    messageId: source.id,
    quote,
    sourceTextHash: memorySha256(source.text),
    startOffset
  }];
}

function modality(value: string): MemoryExtractedCandidate["modality"] {
  if (!memoryTypes.has(value)) fail();
  return value as MemoryExtractedCandidate["modality"];
}

function parseIdentity(value: unknown): MemoryIdentityProposal {
  if (!isRecord(value) || !hasExactKeys(value, identityKeys)) fail();
  if (!isRecord(value.subject) || !hasExactKeys(value.subject, subjectKeys) ||
    !isRecord(value.subject.qualifiers) ||
    !hasExactKeys(value.subject.qualifiers, qualifierKeys)) fail();
  const mode = boundedString(value.mode, 16);
  if (mode !== "SLOT" && mode !== "PROPOSITION") fail();
  const entityType = boundedString(value.subject.entity_type, 32);
  if (!identityEntityTypes.has(entityType)) fail();
  const predicateKey = nullableString(value.predicate_key, 64);
  return {
    dimensionKey: nullableString(value.dimension_key, 512),
    mode,
    predicateKey,
    subject: {
      canonicalLabel: nullableString(value.subject.canonical_label, 512),
      entityType: entityType as MemoryIdentityEntityType,
      qualifiers: {
        brand: nullableString(value.subject.qualifiers.brand, 256),
        model: nullableString(value.subject.qualifiers.model, 256)
      }
    }
  };
}

function parseValue(value: unknown): MemoryValueProposal {
  if (!isRecord(value) || !hasExactKeys(value, valueKeys)) fail();
  return {
    frequency: nullableString(value.frequency, 512),
    kind: nullableString(value.kind, 64),
    limit: nullableString(value.limit, 512),
    place: nullableString(value.place, 512),
    role: nullableString(value.role, 512),
    schedule: nullableString(value.schedule, 512),
    state: nullableString(value.state, 64),
    strength: nullableString(value.strength, 64),
    value: nullableString(value.value, 512)
  };
}

function parseTemporal(value: unknown): MemoryTemporalProposal {
  if (!isRecord(value) || !hasExactKeys(value, temporalKeys)) fail();
  return {
    expectedAt: nullableString(value.expected_at, 64),
    expiresAt: nullableString(value.expires_at, 64),
    occurredAt: nullableString(value.occurred_at, 64),
    rawExpression: nullableString(value.raw_expression, 512),
    validFrom: nullableString(value.valid_from, 64),
    validTo: nullableString(value.valid_to, 64)
  };
}

function parseEntities(
  value: unknown,
  input: MemoryFactExtractionInput,
  quote: string,
  identity: MemoryIdentityProposal
): readonly MemoryFactCandidateEntity[] {
  if (!Array.isArray(value) || value.length > 6) fail();
  const parsed: MemoryFactCandidateEntity[] = [];
  for (const entity of value) {
    if (!isRecord(entity) || !hasExactKeys(entity, entityKeys) ||
      !Array.isArray(entity.aliases) || entity.aliases.length > 4) fail();
    const role = boundedString(entity.role, 16);
    const proposedType = boundedString(entity.entity_type, 32);
    const mention = boundedString(entity.mention, 512);
    if (!entityRoles.has(role) || !entityTypes.has(proposedType) ||
      !quote.includes(mention)) fail();
    const contextRef = nullableString(entity.context_entity_ref, 128);
    const context = contextRef === null
      ? null
      : input.contextRefs.find((candidate) => candidate.ref === contextRef) ?? fail(
          "memory_fact_dependency_unsupported"
        );
    const entityType = memoryEntityType(proposedType);
    if (!entityType || proposedType === "PERSON_SELF") continue;
    const proposedLabel = nullableString(entity.canonical_label, 512);
    const canonicalLabel = context?.displayName ?? proposedLabel;
    if (!canonicalLabel) fail("memory_fact_entity_unsupported");
    const aliases = entity.aliases.map((alias) => boundedString(alias, 256));
    if (aliases.some(memoryEntityAliasIsPronoun)) {
      fail("memory_fact_entity_unsupported");
    }
    parsed.push({
      aliases,
      canonicalLabel,
      contextEntityId: context?.entityId ?? null,
      contextRef,
      entityType,
      mention,
      qualifiers: role === "SUBJECT"
        ? {
            brand: identity.subject.qualifiers.brand,
            model: identity.subject.qualifiers.model
          }
        : {},
      role: role as MemoryFactCandidateEntity["role"]
    });
  }
  return parsed;
}

function parseDependencies(input: Readonly<{
  correction: boolean;
  entities: readonly MemoryFactCandidateEntity[];
  proposal: unknown;
  quote: string;
  temporal: MemoryTemporalProposal;
}>, source: MemoryFactExtractionInput): readonly MemoryFactCandidateDependency[] {
  const value = input.proposal;
  if (!Array.isArray(value) || value.length > 3) fail();
  const refs = value.map((dependency) => boundedString(dependency, 128));
  if (new Set(refs).size !== refs.length) fail();
  const contextualEntityRefs = new Set(input.entities.flatMap((entity) =>
    entity.contextRef ? [entity.contextRef] : []));
  if ([...contextualEntityRefs].some((ref) => !refs.includes(ref))) {
    fail("memory_fact_dependency_unsupported");
  }
  const coreference = contextualEntityRefs.size > 0 || input.entities.some(
    (entity) => memoryEntityAliasIsPronoun(entity.mention)
  );
  if ((input.correction || coreference) && refs.length !== 1) {
    fail("memory_fact_dependency_unsupported");
  }
  return refs.map((ref) => {
    const context = source.contextRefs.find((candidate) => candidate.ref === ref);
    if (!context) fail("memory_fact_dependency_unsupported");
    const dependencyKind: MemoryFactCandidateDependency["dependencyKind"] =
      input.correction
        ? "CORRECTION_TARGET"
        : coreference
          ? "COREFERENCE_ANTECEDENT"
          : input.temporal.rawExpression !== null
            ? "TEMPORAL_CONTEXT"
            : "RELATION_CONTEXT";
    return { dependencyKind, ref, source: context.source };
  });
}

function decodeObservation(
  value: unknown,
  input: MemoryFactExtractionInput
): MemoryExtractedCandidate {
  if (!isRecord(value) || !hasExactKeys(value, observationKeys)) fail();
  const source = targetSource(input);
  const statement = boundedString(value.statement, 2_000);
  const quote = boundedString(value.quote, 2_000);
  if (memoryExplicitStatementContainsSecret(source.text) ||
    memoryExplicitStatementContainsSecret(statement) ||
    memoryExplicitStatementContainsSecret(quote)) fail("memory_fact_secret");
  if (memoryEvidenceLooksNonAuthoritative(source.text, quote)) {
    fail("memory_fact_subject_unsupported");
  }
  const confidenceBand = boundedString(value.confidence_band, 16);
  if (!confidenceBands.has(confidenceBand)) fail();
  if (confidenceBand !== "HIGH") fail("memory_fact_confidence_low");
  const sensitivity = boundedString(value.sensitivity, 16);
  if (!sensitivities.has(sensitivity)) fail();
  if (sensitivity === "SECRET") fail("memory_fact_secret");
  if (sensitivity !== "NORMAL") fail("memory_fact_unsupported");
  if (!requiredBoolean(value.future_useful)) fail("memory_fact_unsupported");
  const correction = requiredBoolean(value.correction);
  const temporary = requiredBoolean(value.temporary);
  boundedString(value.reason_code, 64);
  const memoryType = boundedString(value.memory_type, 32);
  const identityProposal = parseIdentity(value.identity);
  const valueProposal = parseValue(value.value);
  let entities = parseEntities(value.entities, input, quote, identityProposal);
  const subjectEntityType = memoryEntityType(identityProposal.subject.entityType);
  const subjectLabel = identityProposal.subject.qualifiers.model ??
    identityProposal.subject.canonicalLabel;
  if (
    entities.every((entity) => entity.role !== "SUBJECT") &&
    subjectEntityType !== null && subjectLabel !== null &&
    quote.toLocaleLowerCase("und").includes(subjectLabel.toLocaleLowerCase("und"))
  ) {
    entities = [...entities, {
      aliases: [],
      canonicalLabel: subjectLabel,
      contextEntityId: null,
      contextRef: null,
      entityType: subjectEntityType,
      mention: subjectLabel,
      qualifiers: {
        brand: identityProposal.subject.qualifiers.brand,
        model: identityProposal.subject.qualifiers.model
      },
      role: "SUBJECT"
    }];
  }
  const temporalProposal = parseTemporal(value.temporal);
  const dependencies = parseDependencies({
    correction,
    entities,
    proposal: value.dependency_refs,
    quote,
    temporal: temporalProposal
  }, input);
  const temporal = resolveMemoryTemporal({
    observedAt: new Date(source.createdAt),
    proposal: temporalProposal,
    // Temporal semantics belong to this observation's exact evidence, not to
    // an unrelated clause elsewhere in the same user message. This also
    // makes the TTL fence self-contained before offsets are persisted.
    sourceText: quote,
    timeZone: input.timeZone
  });
  if (temporal.expiresAt !== null &&
    (temporal.rawExpression === null || !quote.includes(temporal.rawExpression))) {
    fail("memory_fact_expiration_evidence_invalid");
  }
  if (temporary && temporal.expiresAt === null) fail("memory_fact_temporary");
  if (
    identityProposal.mode === "SLOT" &&
    identityProposal.predicateKey === "product_status" &&
    (valueProposal.state === null ||
      !memoryProductStatusEvidenceIsExplicit(valueProposal.state, quote))
  ) {
    fail("memory_fact_ownership_unsupported");
  }
  const contextIdentity = entities.find((entity) =>
    entity.role === "SUBJECT" && entity.contextRef !== null);
  const contextSource = contextIdentity?.contextRef
    ? input.contextRefs.find((candidate) =>
        candidate.ref === contextIdentity.contextRef)
    : null;
  const resolvedIdentity = resolveMemoryIdentity({
    identity: identityProposal,
    memoryType,
    sourceText: contextSource?.text ?? quote,
    statement,
    value: valueProposal
  });
  const evidence = exactEvidence(input, quote);
  const withoutId: Omit<MemoryExtractedCandidate, "id"> = {
    canonicalKey: resolvedIdentity.canonicalKey,
    category: resolvedIdentity.category,
    confidence: 1,
    confidenceBand: "HIGH",
    correction,
    coreEligible: false,
    coreSalience: "NONE",
    dimensionKey: resolvedIdentity.dimensionKey,
    directness: "DIRECT",
    displayText: statement,
    dependencies,
    entities,
    evidence,
    expectedAt: temporal.expectedAt,
    expiresAt: temporal.expiresAt,
    futureUseful: true,
    identityKind: resolvedIdentity.identityKind,
    identityVersion: resolvedIdentity.identityVersion,
    importance: 0.65,
    languageCode: source.languageCode,
    modality: modality(memoryType),
    negated: false,
    occurredAt: temporal.occurredAt,
    predicateKey: resolvedIdentity.predicateKey,
    proposedValue: resolvedIdentity.structuredValue,
    quote,
    rawTemporalExpression: temporal.rawExpression,
    reasonCode: null,
    responsePreference: null,
    scope: { targetId: null, type: "GLOBAL_USER" },
    sensitivity: "NORMAL",
    state: "PENDING",
    statement,
    subjectKey: resolvedIdentity.subjectKey,
    temporary,
    temporalResolutionEvidence: temporal.resolutionEvidence,
    validFrom: temporal.validFrom,
    validTo: temporal.validTo
  };
  return { ...withoutId, id: memoryFactCandidateId(input, withoutId) };
}

function packetPlan(
  raw: readonly unknown[],
  input: MemoryFactExtractionInput,
  decode: (value: unknown, input: MemoryFactExtractionInput) =>
    MemoryExtractedCandidate
): MemoryFactExtractionPlan {
  const decoded: Array<{
    candidate: MemoryExtractedCandidate;
    candidateOrdinal: number;
  }> = [];
  const rejections: MemoryFactCandidateRejection[] = [];
  raw.forEach((value, candidateOrdinal) => {
    try {
      decoded.push({ candidate: decode(value, input), candidateOrdinal });
    } catch (error) {
      rejections.push({ candidateOrdinal, reasonCode: rejectionCode(error) });
    }
  });
  const unique = new Map<string, (typeof decoded)[number]>();
  for (const item of decoded) {
    const evidence = item.candidate.evidence[0];
    const dedupeKey = memorySha256({
      canonicalKey: item.candidate.canonicalKey,
      evidence: evidence ? {
        endOffset: evidence.endOffset,
        messageId: evidence.messageId,
        sourceTextHash: evidence.sourceTextHash,
        startOffset: evidence.startOffset
      } : null,
      normalizedValue: memoryFactNormalizedValue(item.candidate)
    });
    if (unique.has(dedupeKey)) {
      rejections.push({
        candidateOrdinal: item.candidateOrdinal,
        reasonCode: "REJECT_DUPLICATE"
      });
    } else {
      unique.set(dedupeKey, item);
    }
  }
  const values = [...unique.values()];
  for (const item of values.slice(MEMORY_FACT_MAX_ACCEPTED_CANDIDATES)) {
    rejections.push({
      candidateOrdinal: item.candidateOrdinal,
      reasonCode: "REJECT_UNSUPPORTED"
    });
  }
  const candidates = values
    .slice(0, MEMORY_FACT_MAX_ACCEPTED_CANDIDATES)
    .map(({ candidate }) => candidate);
  return {
    candidates,
    input,
    outputHash: memoryFactExtractionOutputHash(input, candidates),
    rejections
  };
}

function legacyModality(category: string): MemoryExtractedCandidate["modality"] {
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

function decodeLegacyCandidate(
  value: unknown,
  input: MemoryFactExtractionInput
): MemoryExtractedCandidate {
  if (!isRecord(value) || !hasExactKeys(value, legacyCandidateKeys)) fail();
  const source = targetSource(input);
  const statement = boundedString(value.statement, 2_000);
  const quote = boundedString(value.quote, 2_000);
  if (memoryExplicitStatementContainsSecret(statement) ||
    memoryExplicitStatementContainsSecret(quote)) fail("memory_fact_secret");
  const category = boundedString(value.category, 64);
  if (!(MEMORY_FACT_DURABLE_CATEGORIES as readonly string[]).includes(category)) {
    fail("memory_fact_category_unsupported");
  }
  const confidenceBand = boundedString(value.confidence_band, 16);
  if (!confidenceBands.has(confidenceBand)) fail();
  if (confidenceBand !== "HIGH") fail("memory_fact_confidence_low");
  if (requiredBoolean(value.temporary)) fail("memory_fact_temporary");
  if (!requiredBoolean(value.future_useful)) fail("memory_fact_unsupported");
  const correction = requiredBoolean(value.correction);
  const sensitivity = boundedString(value.sensitivity, 16);
  if (!sensitivities.has(sensitivity)) fail();
  if (sensitivity === "SECRET") fail("memory_fact_secret");
  if (sensitivity !== "NORMAL") fail("memory_fact_unsupported");
  const responsePreference = nullableString(value.response_preference, 512);
  if (responsePreference &&
    memoryExplicitStatementContainsSecret(responsePreference)) {
    fail("memory_fact_secret");
  }
  boundedString(value.reason_code, 64);
  const canonicalKey = memoryPropositionCanonicalKey(statement);
  if (!canonicalKey) fail();
  const evidence = exactEvidence(input, quote);
  const withoutId: Omit<MemoryExtractedCandidate, "id"> = {
    canonicalKey,
    category,
    confidence: 1,
    confidenceBand: "HIGH",
    correction,
    coreEligible: responsePreference !== null,
    coreSalience: responsePreference === null ? "NONE" : "HIGH",
    dimensionKey: null,
    directness: "DIRECT",
    displayText: statement,
    dependencies: [],
    entities: [],
    evidence,
    expectedAt: null,
    expiresAt: null,
    futureUseful: true,
    identityKind: "PROPOSITION",
    identityVersion: "proposition-v1",
    importance: 0.5,
    languageCode: source.languageCode,
    modality: legacyModality(category),
    negated: false,
    occurredAt: null,
    predicateKey: null,
    proposedValue: responsePreference === null
      ? { correction, statement }
      : { correction, responsePreference, statement },
    quote,
    rawTemporalExpression: null,
    reasonCode: null,
    responsePreference,
    scope: { targetId: null, type: "GLOBAL_USER" },
    sensitivity: "NORMAL",
    state: "PENDING",
    statement,
    subjectKey: null,
    temporary: false,
    temporalResolutionEvidence: null,
    validFrom: null,
    validTo: null
  };
  return { ...withoutId, id: memoryFactCandidateId(input, withoutId) };
}

/** Compatibility decoder retained only for already-recorded v1 tests and
 * archaeology. New executions never route through it. */
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
  return packetPlan(calls[0].arguments.candidates, input, decodeLegacyCandidate);
}

/** Executable vNext strict packet. Candidate defects are isolated; malformed
 * call count/name/top-level shape fails the complete provider output. */
export function decodeMemoryFactExtraction(
  calls: readonly ModelToolCall[] | undefined,
  input: MemoryFactExtractionInput
): MemoryFactExtractionPlan {
  if (
    !calls || calls.length !== 1 ||
    calls[0]?.name !== MEMORY_FACT_EXTRACTION_TOOL_NAME ||
    !isRecord(calls[0].arguments) ||
    !hasExactKeys(calls[0].arguments, ["observations"]) ||
    !Array.isArray(calls[0].arguments.observations) ||
    calls[0].arguments.observations.length > MEMORY_FACT_MAX_PACKET_CANDIDATES
  ) fail();
  return packetPlan(calls[0].arguments.observations, input, decodeObservation);
}
