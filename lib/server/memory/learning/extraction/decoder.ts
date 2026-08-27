import type { ModelToolCall } from "../../../tools/types";
import { MEMORY_SUPPORTING_OBSERVATION_CONFIDENCE } from
  "../../../../contracts/memory";
import {
  memoryExplicitStatementContainsSecret,
  memoryValueContainsRecognizedSecret
} from "../../explicit/safety";
import { memorySha256 } from "../../persistence/lexical";
import {
  resolveMemoryIdentity,
  type MemoryIdentityEntityType,
  type MemoryIdentityProposal,
  type MemoryValueProposal
} from "../identity/registry";
import {
  resolveMemoryTemporal,
  type MemoryTemporalProposal,
  type ResolvedMemoryTemporal
} from "../temporal/resolver";
import { memoryLocalDateTimeParts } from
  "../../../../domain/memory/temporal/calendar";
import {
  MEMORY_FACT_DURABLE_CATEGORIES,
  MEMORY_FACT_MAX_ACCEPTED_CANDIDATES,
  MEMORY_FACT_MAX_PACKET_CANDIDATES,
  memoryFactCandidateId,
  memoryFactExtractionOutputHash,
  memoryFactNormalizedValue,
  type MemoryExactTextRef,
  type MemoryExtractedCandidate,
  type MemoryFactCandidateDependency,
  type MemoryFactCandidateEntity,
  type MemoryFactCandidateRejection,
  type MemoryFactExtractionInput,
  type MemoryFactExtractionPlan,
  type MemorySemanticFrame,
  type MemoryTemporalNormalization,
  type MemoryTemporalPointNormalization
} from "./contract";
import {
  memoryEntityType,
  memoryEntityTypeFamily
} from "../entities/normalization";
import {
  memoryPropositionCanonicalKey,
  memorySupportingPropositionCanonicalKey,
  normalizeMemoryProposition
} from "../identity/normalization";
import {
  decodeMemoryExactTextRef,
  projectMemoryExactTextRef
} from "./exactText";
import { MEMORY_FACT_EXTRACTION_TOOL_NAME } from "./prompt";

const controlSyntax = /[\u0000-\u001f\u007f]/u;
const boundedMachineToken = /^[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,63}$/u;
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
const mentionKinds = new Set([
  "NAMED", "NOMINAL", "PRONOMINAL", "ELLIPSIS", "UNKNOWN"
]);
const speechActs = new Set(["ASSERTION", "COMMAND", "QUESTION", "OTHER", "UNKNOWN"]);
const assertionStatuses = new Set([
  "ASSERTED", "CONDITIONAL", "HYPOTHETICAL", "QUOTED", "UNKNOWN"
]);
const subjectScopes = new Set(["CURRENT_USER", "THIRD_PARTY", "ASSISTANT", "UNKNOWN"]);
const polarities = new Set(["AFFIRMED", "NEGATED", "CORRECTION", "RETRACTION", "UNKNOWN"]);
const temporalPerspectives = new Set([
  "CURRENT", "FORMER", "FUTURE", "EVENT", "INTERVAL", "UNKNOWN"
]);
const changeIntents = new Set([
  "NONE", "STATE_CHANGE", "CORRECTION", "RETRACTION", "REOPEN", "UNKNOWN"
]);
const memoryDirectives = new Set(["NONE", "EXPLICIT_REMEMBER", "UNKNOWN"]);

const legacyCandidateKeys = [
  "category", "confidence_band", "correction", "future_useful", "quote",
  "reason_code", "response_preference", "sensitivity", "statement", "temporary"
].sort();
const observationKeys = [
  "candidate_ref", "confidence_band", "dependency_refs", "entities", "evidence",
  "future_useful", "identity", "memory_type", "reason_code", "semantic_frame",
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
  "expiration_intent", "normalization", "perspective", "raw_expression"
].sort();
const entityKeys = [
  "aliases", "canonical_label", "context_entity_ref", "entity_type", "mention",
  "mention_kind", "qualifier_supports", "role"
].sort();
const semanticFrameKeys = [
  "assertion_status", "change_intent", "memory_directive", "polarity",
  "speech_act", "subject_scope", "temporal_perspective"
].sort();
const qualifierSupportKeys = ["key", "source", "value"].sort();

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
  if (typeof value !== "string" || value.trim() !== value || !value ||
    value.length > maxLength || controlSyntax.test(value)) fail();
  return value;
}

function nullableString(value: unknown, maxLength: number): string | null {
  return value === null ? null : boundedString(value, maxLength);
}

function requiredBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") fail();
  return value;
}

function enumValue<T extends string>(
  value: unknown,
  values: ReadonlySet<string>,
  maxLength = 32
): T {
  const decoded = boundedString(value, maxLength);
  if (!values.has(decoded)) fail();
  return decoded as T;
}

function rejectionCode(error: unknown): MemoryFactCandidateRejection["reasonCode"] {
  if (!(error instanceof MemoryFactDecodeError)) return "REJECT_UNSUPPORTED";
  if (error.code === "memory_fact_evidence_ambiguous" ||
    error.code === "memory_fact_semantic_unknown") return "REJECT_AMBIGUOUS";
  if (error.code === "memory_fact_source_stale") return "REJECT_STALE_SOURCE";
  if (error.code === "memory_fact_confidence_low") return "REJECT_LOW_CONFIDENCE";
  if (error.code === "memory_fact_temporary") return "REJECT_TEMPORARY";
  if (error.code === "memory_fact_secret") return "REJECT_SECRET";
  return "REJECT_UNSUPPORTED";
}

function targetSource(input: MemoryFactExtractionInput) {
  const eligible = input.messages.filter((message) => message.evidenceEligible);
  const source = eligible.length === 1 &&
    eligible[0]?.id === input.source.sourceMessageId && eligible[0].role === "user"
    ? eligible[0]
    : null;
  if (!source) fail("memory_fact_source_stale");
  return source;
}

function exactEvidence(
  input: MemoryFactExtractionInput,
  ref: MemoryExactTextRef
): MemoryExtractedCandidate["evidence"] {
  const source = targetSource(input);
  const span = projectMemoryExactTextRef(source.text, ref);
  if (!span) fail("memory_fact_evidence_invalid");
  if ((source.redactionSpans ?? []).some((redacted) =>
    span.startOffset < redacted.endOffset && span.endOffset > redacted.startOffset)) {
    fail("memory_fact_secret");
  }
  return [{
    endOffset: span.endOffset,
    messageId: source.id,
    quote: span.text,
    sourceTextHash: memorySha256(source.text),
    startOffset: span.startOffset
  }];
}

function modality(value: string): MemoryExtractedCandidate["modality"] {
  if (!memoryTypes.has(value)) fail();
  return value as MemoryExtractedCandidate["modality"];
}

function parseSemanticFrame(value: unknown): MemorySemanticFrame {
  if (!isRecord(value) || !hasExactKeys(value, semanticFrameKeys)) fail();
  return {
    assertionStatus: enumValue(value.assertion_status, assertionStatuses),
    changeIntent: enumValue(value.change_intent, changeIntents),
    memoryDirective: enumValue(value.memory_directive, memoryDirectives),
    polarity: enumValue(value.polarity, polarities),
    speechAct: enumValue(value.speech_act, speechActs),
    subjectScope: enumValue(value.subject_scope, subjectScopes),
    temporalPerspective: enumValue(value.temporal_perspective, temporalPerspectives)
  };
}

function parseIdentity(value: unknown): MemoryIdentityProposal {
  if (!isRecord(value) || !hasExactKeys(value, identityKeys)) fail();
  if (!isRecord(value.subject) || !hasExactKeys(value.subject, subjectKeys) ||
    !isRecord(value.subject.qualifiers) ||
    !hasExactKeys(value.subject.qualifiers, qualifierKeys)) fail();
  const mode = boundedString(value.mode, 16);
  if (mode !== "SLOT" && mode !== "PROPOSITION") fail();
  const entityType = enumValue<MemoryIdentityEntityType>(
    value.subject.entity_type,
    identityEntityTypes
  );
  return {
    dimensionKey: nullableString(value.dimension_key, 512),
    mode,
    predicateKey: nullableString(value.predicate_key, 64),
    subject: {
      canonicalLabel: nullableString(value.subject.canonical_label, 512),
      entityType,
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

function parsePointNormalization(value: unknown): MemoryTemporalPointNormalization {
  if (!isRecord(value) || typeof value.kind !== "string") fail();
  if (value.kind === "NONE" && hasExactKeys(value, ["kind"])) return { kind: "NONE" };
  if (value.kind === "ABSOLUTE" &&
    hasExactKeys(value, ["kind", "local_date", "local_time", "zone"])) {
    return {
      kind: "ABSOLUTE",
      localDate: boundedString(value.local_date, 10),
      localTime: nullableString(value.local_time, 8),
      zone: nullableString(value.zone, 64)
    };
  }
  if (value.kind === "CALENDAR_OFFSET" &&
    hasExactKeys(value, ["amount", "kind", "unit"]) &&
    Number.isSafeInteger(value.amount) && Number(value.amount) >= -10_000 &&
    Number(value.amount) <= 10_000 &&
    typeof value.unit === "string" &&
    ["DAY", "WEEK", "MONTH", "YEAR"].includes(value.unit)) {
    return {
      amount: Number(value.amount),
      kind: "CALENDAR_OFFSET",
      unit: value.unit as "DAY" | "WEEK" | "MONTH" | "YEAR"
    };
  }
  if (value.kind === "RELATIVE_WEEKDAY" &&
    hasExactKeys(value, ["direction", "kind", "weekday"]) &&
    Number.isSafeInteger(value.weekday) && Number(value.weekday) >= 1 &&
    Number(value.weekday) <= 7 && typeof value.direction === "string" &&
    ["PREVIOUS", "CURRENT", "NEXT"].includes(value.direction)) {
    return {
      direction: value.direction as "PREVIOUS" | "CURRENT" | "NEXT",
      kind: "RELATIVE_WEEKDAY",
      weekday: Number(value.weekday) as 1 | 2 | 3 | 4 | 5 | 6 | 7
    };
  }
  fail();
}

function parseNormalization(value: unknown): MemoryTemporalNormalization {
  if (isRecord(value) && value.kind === "INTERVAL" &&
    hasExactKeys(value, ["end", "kind", "start"])) {
    return {
      end: parsePointNormalization(value.end),
      kind: "INTERVAL",
      start: parsePointNormalization(value.start)
    };
  }
  return parsePointNormalization(value);
}

function parseTemporal(
  value: unknown,
  quote: string,
  frame: MemorySemanticFrame
): MemoryTemporalProposal {
  if (!isRecord(value) || !hasExactKeys(value, temporalKeys)) fail();
  const perspective = enumValue<MemoryTemporalProposal["perspective"]>(
    value.perspective,
    temporalPerspectives
  );
  if (perspective !== frame.temporalPerspective) fail();
  let rawExpression: string | null = null;
  if (value.raw_expression !== null) {
    const ref = decodeMemoryExactTextRef(value.raw_expression, 512);
    const span = ref ? projectMemoryExactTextRef(quote, ref) : null;
    if (!span) fail("memory_fact_temporal_invalid");
    rawExpression = span.text;
  }
  const expirationIntent = enumValue<MemoryTemporalProposal["expirationIntent"]>(
    value.expiration_intent,
    new Set(["EXPLICIT", "NONE", "UNKNOWN"])
  );
  const normalization = parseNormalization(value.normalization);
  if (normalization.kind !== "NONE" && rawExpression === null) {
    fail("memory_fact_temporal_invalid");
  }
  return { expirationIntent, normalization, perspective, rawExpression };
}

type ParsedEntities = Readonly<{
  entities: readonly MemoryFactCandidateEntity[];
  supportsByType: ReadonlyMap<string, ReadonlySet<string>>;
}>;

function parseEntities(
  value: unknown,
  input: MemoryFactExtractionInput,
  quote: string,
  frame: MemorySemanticFrame,
  identity: MemoryIdentityProposal
): ParsedEntities {
  if (!Array.isArray(value) || value.length > 6) fail();
  const parsed: MemoryFactCandidateEntity[] = [];
  const supports = new Map<string, Set<string>>();
  const addSupport = (entityType: string, text: string) => {
    const current = supports.get(entityType) ?? new Set<string>();
    current.add(text);
    supports.set(entityType, current);
  };
  for (const entity of value) {
    if (!isRecord(entity) || !hasExactKeys(entity, entityKeys) ||
      !Array.isArray(entity.aliases) || entity.aliases.length > 4 ||
      !Array.isArray(entity.qualifier_supports) ||
      entity.qualifier_supports.length > 4) fail();
    const role = enumValue<MemoryFactCandidateEntity["role"]>(entity.role, entityRoles);
    const proposedType = enumValue(entity.entity_type, entityTypes);
    const mentionKind = enumValue<MemoryFactCandidateEntity["mentionKind"]>(
      entity.mention_kind,
      mentionKinds
    );
    const contextRef = nullableString(entity.context_entity_ref, 128);
    const context = contextRef === null ? null : input.contextRefs.find(
      (candidate) => candidate.ref === contextRef
    ) ?? fail("memory_fact_dependency_unsupported");
    const directSelfAnnotation = proposedType === "PERSON_SELF" &&
      (frame.subjectScope === "CURRENT_USER" || frame.subjectScope === "UNKNOWN") &&
      (role === "SUBJECT" || (
        identity.subject.entityType === "PERSON_SELF" &&
        identity.predicateKey === null
      ));
    if (proposedType === "PERSON_SELF" && !directSelfAnnotation) {
      fail("memory_fact_entity_unsupported");
    }

    let mention: string | null = null;
    if (entity.mention !== null) {
      const ref = decodeMemoryExactTextRef(entity.mention, 512);
      const span = ref ? projectMemoryExactTextRef(quote, ref) : null;
      if (!span) fail("memory_fact_entity_unsupported");
      mention = span.text;
      addSupport(proposedType, span.text);
    }
    if ((mentionKind === "NAMED" || mentionKind === "NOMINAL") &&
      mention === null) fail("memory_fact_entity_unsupported");
    if (mentionKind === "ELLIPSIS" && mention !== null) {
      fail("memory_fact_entity_unsupported");
    }
    if ((mentionKind === "PRONOMINAL" || mentionKind === "ELLIPSIS") &&
      context === null && !directSelfAnnotation) {
      fail("memory_fact_dependency_unsupported");
    }

    const aliases = entity.aliases.map((rawAlias) => {
      const ref = decodeMemoryExactTextRef(rawAlias, 256);
      const span = ref ? projectMemoryExactTextRef(quote, ref) : null;
      if (!span) fail("memory_fact_entity_unsupported");
      addSupport(proposedType, span.text);
      return span.text;
    });
    if (aliases.length > 0 && mentionKind !== "NAMED" && mentionKind !== "NOMINAL") {
      fail("memory_fact_entity_unsupported");
    }

    const qualifiers: Record<string, string | null> = {};
    for (const support of entity.qualifier_supports) {
      if (!isRecord(support) || !hasExactKeys(support, qualifierSupportKeys)) fail();
      const key = boundedString(support.key, 64);
      const supportValue = boundedString(support.value, 256);
      if (!isRecord(support.source)) fail();
      if (hasExactKeys(support.source, ["context_ref"])) {
        const ref = boundedString(support.source.context_ref, 128);
        if (!input.contextRefs.some((candidate) => candidate.ref === ref)) {
          fail("memory_fact_dependency_unsupported");
        }
      } else {
        const ref = decodeMemoryExactTextRef(support.source, 512);
        if (!ref || !projectMemoryExactTextRef(quote, ref)) {
          fail("memory_fact_entity_unsupported");
        }
      }
      addSupport(proposedType, supportValue);
      if (key === "brand" || key === "model") qualifiers[key] = supportValue;
    }

    const entityType = memoryEntityType(proposedType);
    if (!entityType || proposedType === "PERSON_SELF") continue;
    const proposedLabel = nullableString(entity.canonical_label, 512);
    const canonicalLabel = context?.displayName ?? proposedLabel ?? mention;
    if (!canonicalLabel) fail("memory_fact_entity_unsupported");
    parsed.push({
      aliases,
      canonicalLabel,
      contextEntityId: context?.entityId ?? null,
      contextRef,
      entityType,
      mention,
      mentionKind,
      qualifiers,
      role
    });
  }
  return { entities: parsed, supportsByType: supports };
}

function supported(
  supports: ReadonlyMap<string, ReadonlySet<string>>,
  types: readonly string[],
  value: string | null
): boolean {
  return value !== null && types.some((type) => supports.get(type)?.has(value));
}

function groundIdentity(
  identity: MemoryIdentityProposal,
  value: MemoryValueProposal,
  supports: ReadonlyMap<string, ReadonlySet<string>>,
  input: MemoryFactExtractionInput,
  entities: readonly MemoryFactCandidateEntity[]
): MemoryIdentityProposal {
  if (identity.mode !== "SLOT") return identity;
  if (identity.predicateKey === "product_status") {
    const type = identity.subject.entityType;
    const label = identity.subject.qualifiers.model ?? identity.subject.canonicalLabel;
    const expectedFamily = memoryEntityTypeFamily(type);
    const contextSupported = entities.some((entity) =>
      entity.role === "SUBJECT" && entity.contextEntityId !== null &&
      memoryEntityTypeFamily(entity.entityType) === expectedFamily &&
      input.contextRefs.some((context) =>
        context.entityId === entity.contextEntityId &&
        memoryEntityTypeFamily(context.entityType ?? "") === expectedFamily));
    if (!supported(supports, ["PRODUCT", "DEVICE", "SERVICE"], label) &&
      !contextSupported) fail("memory_fact_product_identity_unsupported");
  } else if (identity.predicateKey === "residence") {
    if (!supported(supports, ["PLACE"], value.place)) {
      fail("memory_fact_residence_identity_unsupported");
    }
  } else if (identity.predicateKey === "employment_status") {
    if (!supported(supports, ["ORGANIZATION"], identity.dimensionKey)) {
      fail("memory_fact_employment_identity_unsupported");
    }
  } else if (identity.predicateKey === "goal_status" ||
    identity.predicateKey === "project_status") {
    const expected = identity.predicateKey === "goal_status" ? "GOAL" : "PROJECT";
    if (!supported(supports, [expected], identity.subject.canonicalLabel)) {
      fail("memory_fact_subject_identity_unsupported");
    }
  }
  return identity;
}

function parseDependencies(input: Readonly<{
  entities: readonly MemoryFactCandidateEntity[];
  frame: MemorySemanticFrame;
  proposal: unknown;
  temporal: MemoryTemporalProposal;
}>, source: MemoryFactExtractionInput): readonly MemoryFactCandidateDependency[] {
  if (!Array.isArray(input.proposal) || input.proposal.length > 3) fail();
  const refs = input.proposal.map((dependency) => boundedString(dependency, 128));
  if (new Set(refs).size !== refs.length) fail();
  const contextualEntityRefs = new Set(input.entities.flatMap((entity) =>
    entity.contextRef ? [entity.contextRef] : []));
  if ([...contextualEntityRefs].some((ref) => !refs.includes(ref))) {
    fail("memory_fact_dependency_unsupported");
  }
  const correction = input.frame.polarity === "CORRECTION" ||
    input.frame.changeIntent === "CORRECTION";
  const coreference = input.entities.some((entity) =>
    entity.mentionKind === "PRONOMINAL" || entity.mentionKind === "ELLIPSIS");
  if ((correction || coreference) && refs.length !== 1) {
    fail("memory_fact_dependency_unsupported");
  }
  return refs.map((ref) => {
    const context = source.contextRefs.find((candidate) => candidate.ref === ref);
    if (!context) fail("memory_fact_dependency_unsupported");
    const dependencyKind: MemoryFactCandidateDependency["dependencyKind"] = correction
      ? "CORRECTION_TARGET"
      : coreference
        ? "COREFERENCE_ANTECEDENT"
        : input.temporal.rawExpression !== null
          ? "TEMPORAL_CONTEXT"
          : "RELATION_CONTEXT";
    return { dependencyKind, ref, source: context.source };
  });
}

function frameCanEnterPacket(frame: MemorySemanticFrame): boolean {
  if (frame.subjectScope !== "CURRENT_USER" && frame.subjectScope !== "UNKNOWN") {
    return false;
  }
  if (frame.assertionStatus !== "ASSERTED" && frame.assertionStatus !== "UNKNOWN") {
    return false;
  }
  if (frame.speechAct !== "ASSERTION" && frame.speechAct !== "UNKNOWN" && !(
    frame.speechAct === "COMMAND" && frame.memoryDirective === "EXPLICIT_REMEMBER"
  )) return false;
  return frame.polarity === "AFFIRMED" || frame.polarity === "CORRECTION" ||
    frame.polarity === "UNKNOWN";
}

function resolvedLocalDate(instant: string, timeZone: string): string {
  const parts = memoryLocalDateTimeParts(new Date(instant), timeZone);
  return `${String(parts.year).padStart(4, "0")}-` +
    `${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function temporalDisplayText(
  statement: string,
  temporal: ResolvedMemoryTemporal,
  timeZone: string
): string {
  if (temporal.rawExpression === null) return statement;
  const fields = [
    temporal.occurredAt ? `event_date=${resolvedLocalDate(temporal.occurredAt, timeZone)}` : null,
    temporal.expectedAt ? `expected_date=${resolvedLocalDate(temporal.expectedAt, timeZone)}` : null,
    temporal.validFrom ? `valid_from=${resolvedLocalDate(temporal.validFrom, timeZone)}` : null,
    temporal.validTo ? `valid_to=${resolvedLocalDate(temporal.validTo, timeZone)}` : null
  ].filter((value): value is string => value !== null);
  if (fields.length === 0) return statement;
  const rendered = `${statement} [${fields.join("; ")}]`;
  return rendered.length <= 2_000 ? rendered : statement;
}

function decodeObservation(
  value: unknown,
  input: MemoryFactExtractionInput
): MemoryExtractedCandidate {
  if (!isRecord(value) || !hasExactKeys(value, observationKeys)) fail();
  const source = targetSource(input);
  const candidateRef = boundedString(value.candidate_ref, 64);
  if (!boundedMachineToken.test(candidateRef)) fail();
  const statement = boundedString(value.statement, 2_000);
  const evidenceRef = decodeMemoryExactTextRef(value.evidence, 2_000) ?? fail();
  const evidence = exactEvidence(input, evidenceRef);
  const quote = evidence[0]!.quote!;
  if (memoryExplicitStatementContainsSecret(source.text) ||
    memoryExplicitStatementContainsSecret(statement) ||
    memoryExplicitStatementContainsSecret(quote)) fail("memory_fact_secret");
  const frame = parseSemanticFrame(value.semantic_frame);
  if (!frameCanEnterPacket(frame)) fail("memory_fact_subject_unsupported");
  if (frame.polarity === "RETRACTION" || frame.changeIntent === "RETRACTION") {
    fail("memory_fact_retraction_requires_relation");
  }
  const confidenceBand = enumValue<NonNullable<
    MemoryExtractedCandidate["confidenceBand"]
  >>(value.confidence_band, confidenceBands, 16);
  if (confidenceBand === "LOW") fail("memory_fact_confidence_low");
  const sensitivity = enumValue(value.sensitivity, sensitivities, 16);
  if (sensitivity === "SECRET") fail("memory_fact_secret");
  if (sensitivity !== "NORMAL") fail("memory_fact_unsupported");
  if (!requiredBoolean(value.future_useful)) fail("memory_fact_unsupported");
  const temporary = requiredBoolean(value.temporary);
  boundedString(value.reason_code, 64);
  const memoryType = boundedString(value.memory_type, 32);
  const rawIdentity = parseIdentity(value.identity);
  const valueProposal = parseValue(value.value);
  if (memoryValueContainsRecognizedSecret(valueProposal)) {
    fail("memory_fact_secret");
  }
  const parsedEntities = parseEntities(
    value.entities,
    input,
    quote,
    frame,
    rawIdentity
  );
  if (parsedEntities.entities.some(({ entityType, role }) =>
    entityType === "PERSON" && role !== "SUBJECT")) {
    fail("memory_fact_entity_unsupported");
  }
  const effectiveIdentity: MemoryIdentityProposal = confidenceBand === "MEDIUM"
    ? {
        dimensionKey: null,
        mode: "PROPOSITION",
        predicateKey: null,
        subject: {
          canonicalLabel: null,
          entityType: "NONE",
          qualifiers: { brand: null, model: null }
        }
      }
    : rawIdentity;
  const identityProposal = groundIdentity(
    effectiveIdentity,
    valueProposal,
    parsedEntities.supportsByType,
    input,
    parsedEntities.entities
  );
  const temporalProposal = parseTemporal(value.temporal, quote, frame);
  const dependencies = parseDependencies({
    entities: parsedEntities.entities,
    frame,
    proposal: value.dependency_refs,
    temporal: temporalProposal
  }, input);
  const temporal = resolveMemoryTemporal({
    observedAt: new Date(source.createdAt),
    proposal: temporalProposal,
    timeZone: input.timeZone
  });
  if (temporalProposal.expirationIntent === "EXPLICIT" &&
    temporal.expiresAt === null) fail("memory_fact_expiration_evidence_invalid");
  if (temporary && temporal.expiresAt === null) fail("memory_fact_temporary");
  const resolvedIdentity = resolveMemoryIdentity({
    identity: identityProposal,
    memoryType,
    semanticFrame: frame,
    statement,
    value: valueProposal
  });
  const correction = frame.polarity === "CORRECTION" ||
    frame.changeIntent === "CORRECTION";
  if (confidenceBand === "MEDIUM" && (
    frame.speechAct !== "ASSERTION" || frame.assertionStatus !== "ASSERTED" ||
    frame.subjectScope !== "CURRENT_USER" || frame.polarity !== "AFFIRMED" ||
    frame.changeIntent !== "NONE" || frame.memoryDirective !== "NONE" ||
    frame.temporalPerspective === "UNKNOWN" || correction ||
    resolvedIdentity.identityKind !== "PROPOSITION"
  )) fail("memory_fact_unsupported");
  if (correction && !dependencies.some(({ dependencyKind }) =>
    dependencyKind === "CORRECTION_TARGET")) fail("memory_fact_dependency_unsupported");
  if (parsedEntities.entities.some(({ entityType }) => entityType === "PERSON") &&
    resolvedIdentity.identityKind !== "PROPOSITION") {
    fail("memory_fact_entity_unsupported");
  }
  const supportingCanonicalKey = confidenceBand === "MEDIUM"
    ? memorySupportingPropositionCanonicalKey({
        expectedAt: temporal.expectedAt,
        occurredAt: temporal.occurredAt,
        statement,
        validFrom: temporal.validFrom,
        validTo: temporal.validTo
      }) ?? fail()
    : null;
  const supportingStatement = confidenceBand === "MEDIUM"
    ? normalizeMemoryProposition(statement) ?? fail()
    : null;
  const withoutId: Omit<MemoryExtractedCandidate, "id"> = {
    candidateRef,
    canonicalKey: supportingCanonicalKey ?? resolvedIdentity.canonicalKey,
    category: resolvedIdentity.category,
    confidence: confidenceBand === "MEDIUM"
      ? MEMORY_SUPPORTING_OBSERVATION_CONFIDENCE
      : 1,
    confidenceBand,
    correction,
    coreEligible: false,
    coreSalience: "NONE",
    dimensionKey: resolvedIdentity.dimensionKey,
    directness: "DIRECT",
    displayText: temporalDisplayText(statement, temporal, input.timeZone),
    dependencies,
    entities: parsedEntities.entities,
    evidence,
    expectedAt: temporal.expectedAt,
    expirationIntent: temporalProposal.expirationIntent,
    expiresAt: temporal.expiresAt,
    futureUseful: true,
    identityKind: resolvedIdentity.identityKind,
    identityVersion: resolvedIdentity.identityVersion,
    importance: confidenceBand === "MEDIUM" ? 0.4 : 0.65,
    languageCode: source.languageCode,
    modality: modality(memoryType),
    negated: false,
    occurredAt: temporal.occurredAt,
    predicateKey: resolvedIdentity.predicateKey,
    proposedValue: supportingStatement === null
      ? resolvedIdentity.structuredValue
      : {
          authority: "supporting",
          normalizedStatement: supportingStatement,
          schema: "supporting-observation-v1"
        },
    quote,
    rawTemporalExpression: temporal.rawExpression,
    reasonCode: null,
    responsePreference: null,
    scope: { targetId: null, type: "GLOBAL_USER" },
    semanticFrame: frame,
    sensitivity: "NORMAL",
    state: "PENDING",
    statement,
    subjectKey: resolvedIdentity.subjectKey,
    temporary,
    temporalNormalization: temporalProposal.normalization,
    temporalResolutionEvidence: temporal.resolutionEvidence,
    validFrom: temporal.validFrom,
    validTo: temporal.validTo
  };
  return { ...withoutId, id: memoryFactCandidateId(input, withoutId) };
}

function packetPlan(
  raw: readonly unknown[],
  input: MemoryFactExtractionInput,
  decode: (value: unknown, input: MemoryFactExtractionInput) => MemoryExtractedCandidate,
  requireUniqueCandidateRefs = true
): MemoryFactExtractionPlan {
  const decoded: Array<{ candidate: MemoryExtractedCandidate; candidateOrdinal: number }> = [];
  const rejections: MemoryFactCandidateRejection[] = [];
  const candidateRefs = new Set<string>();
  raw.forEach((value, candidateOrdinal) => {
    try {
      const candidate = decode(value, input);
      if (requireUniqueCandidateRefs && candidateRefs.has(candidate.candidateRef)) {
        fail("memory_fact_candidate_ref_duplicate");
      }
      candidateRefs.add(candidate.candidateRef);
      decoded.push({ candidate, candidateOrdinal });
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
  const accepted = values.slice(0, MEMORY_FACT_MAX_ACCEPTED_CANDIDATES);
  const candidates = accepted.map(({ candidate }) => candidate);
  const candidateOrdinals = accepted.map(({ candidateOrdinal }) => candidateOrdinal);
  rejections.sort((left, right) =>
    left.candidateOrdinal - right.candidateOrdinal ||
    left.reasonCode.localeCompare(right.reasonCode));
  return {
    candidateOrdinals,
    candidates,
    input,
    outputHash: memoryFactExtractionOutputHash(
      input,
      candidates,
      candidateOrdinals,
      rejections
    ),
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
  const confidenceBand = enumValue(value.confidence_band, confidenceBands, 16);
  if (confidenceBand !== "HIGH") fail("memory_fact_confidence_low");
  if (requiredBoolean(value.temporary)) fail("memory_fact_temporary");
  if (!requiredBoolean(value.future_useful)) fail("memory_fact_unsupported");
  const correction = requiredBoolean(value.correction);
  const sensitivity = enumValue(value.sensitivity, sensitivities, 16);
  if (sensitivity === "SECRET") fail("memory_fact_secret");
  if (sensitivity !== "NORMAL") fail("memory_fact_unsupported");
  const responsePreference = nullableString(value.response_preference, 512);
  if (responsePreference && memoryExplicitStatementContainsSecret(responsePreference)) {
    fail("memory_fact_secret");
  }
  boundedString(value.reason_code, 64);
  const firstOccurrence = source.text.indexOf(quote);
  if (firstOccurrence >= 0 &&
    source.text.indexOf(quote, firstOccurrence + quote.length) >= 0) {
    fail("memory_fact_evidence_ambiguous");
  }
  const canonicalKey = memoryPropositionCanonicalKey(statement);
  if (!canonicalKey) fail();
  const evidence = exactEvidence(input, { occurrenceIndex: 0, text: quote });
  const semanticFrame: MemorySemanticFrame = {
    assertionStatus: "ASSERTED",
    changeIntent: correction ? "CORRECTION" : "NONE",
    memoryDirective: "NONE",
    polarity: correction ? "CORRECTION" : "AFFIRMED",
    speechAct: "ASSERTION",
    subjectScope: "CURRENT_USER",
    temporalPerspective: "CURRENT"
  };
  const withoutId: Omit<MemoryExtractedCandidate, "id"> = {
    candidateRef: "legacy-0",
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
    expirationIntent: "NONE",
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
    semanticFrame,
    sensitivity: "NORMAL",
    state: "PENDING",
    statement,
    subjectKey: null,
    temporary: false,
    temporalNormalization: { kind: "NONE" },
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
  if (!calls || calls.length !== 1 ||
    calls[0]?.name !== MEMORY_FACT_EXTRACTION_TOOL_NAME ||
    !isRecord(calls[0].arguments) ||
    !hasExactKeys(calls[0].arguments, ["candidates"]) ||
    !Array.isArray(calls[0].arguments.candidates) ||
    calls[0].arguments.candidates.length > MEMORY_FACT_MAX_PACKET_CANDIDATES) fail();
  return packetPlan(
    calls[0].arguments.candidates,
    input,
    decodeLegacyCandidate,
    false
  );
}

/** Executable vNext strict packet. Candidate defects are isolated; malformed
 * call count/name/top-level shape fails the complete provider output. */
export function decodeMemoryFactExtraction(
  calls: readonly ModelToolCall[] | undefined,
  input: MemoryFactExtractionInput
): MemoryFactExtractionPlan {
  if (!calls || calls.length !== 1 ||
    calls[0]?.name !== MEMORY_FACT_EXTRACTION_TOOL_NAME ||
    !isRecord(calls[0].arguments) ||
    !hasExactKeys(calls[0].arguments, ["observations"]) ||
    !Array.isArray(calls[0].arguments.observations) ||
    calls[0].arguments.observations.length > MEMORY_FACT_MAX_PACKET_CANDIDATES) fail();
  return packetPlan(calls[0].arguments.observations, input, decodeObservation);
}
