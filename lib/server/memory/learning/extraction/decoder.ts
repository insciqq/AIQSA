import type { ModelToolCall } from "../../../tools/types";
import { decodeMemoryUsefulness } from "../../../../domain/memory/usefulness";
import { MEMORY_SUPPORTING_OBSERVATION_CONFIDENCE } from
  "../../../../contracts/memory";
import {
  memoryExplicitStatementContainsSecret,
  memoryValueContainsRecognizedSecret
} from "../../explicit/safety";
import { memorySha256 } from "../../persistence/lexical";
import {
  MemoryIdentityError,
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
  MEMORY_FACT_MAX_ACCEPTED_CANDIDATES,
  MEMORY_FACT_MAX_EVIDENCE_CHARACTERS,
  MEMORY_FACT_MAX_PACKET_CANDIDATES,
  MEMORY_FACT_MAX_RAW_OBSERVATIONS,
  memoryFactCandidateId,
  memoryFactExtractionOutputHash,
  memoryFactNormalizedValue,
  memoryFactPageBoundaryAfter,
  memoryFactTargetSourceHash,
  memoryFactTargetTextOffset,
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
  assertMemoryIdentityWritable,
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
const subjectScopes = new Set([
  "CURRENT_USER", "USER_RELATIONSHIP_CONTEXT", "THIRD_PARTY", "ASSISTANT", "UNKNOWN"
]);
const polarities = new Set(["AFFIRMED", "NEGATED", "CORRECTION", "RETRACTION", "UNKNOWN"]);
const temporalPerspectives = new Set([
  "CURRENT", "FORMER", "FUTURE", "EVENT", "INTERVAL", "UNKNOWN"
]);
const changeIntents = new Set([
  "NONE", "STATE_CHANGE", "CORRECTION", "RETRACTION", "REOPEN", "UNKNOWN"
]);
const memoryDirectives = new Set(["NONE", "EXPLICIT_REMEMBER", "UNKNOWN"]);

const legacyObservationKeys = [
  "candidate_ref", "confidence_band", "dependency_refs", "entities", "evidence",
  "future_useful", "identity", "memory_type", "reason_code", "semantic_frame",
  "sensitivity", "statement", "temporal", "temporary", "value"
].sort();
const observationKeys = [...legacyObservationKeys, "usefulness"].sort();
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
  if (error instanceof MemoryIdentityError) {
    return error.code === "memory_fact_state_unsupported"
      ? "REJECT_STATE_UNSUPPORTED"
      : "REJECT_IDENTITY_INVALID";
  }
  if (error instanceof Error && error.message === "memory_fact_temporal_invalid") {
    return "REJECT_TEMPORAL_UNSUPPORTED";
  }
  if (!(error instanceof MemoryFactDecodeError)) return "REJECT_UNSUPPORTED";
  if (error.code === "memory_fact_evidence_ambiguous" ||
    error.code === "memory_fact_semantic_unknown" ||
    error.code === "memory_fact_sensitivity_ambiguous") return "REJECT_AMBIGUOUS";
  if (error.code === "memory_fact_evidence_invalid") return "REJECT_EVIDENCE_INVALID";
  if (error.code === "memory_fact_evidence_not_in_target") {
    return "REJECT_EVIDENCE_NOT_IN_TARGET";
  }
  if (error.code === "memory_fact_subject_unsupported" ||
    error.code === "memory_fact_unsupported") return "REJECT_FRAME_INELIGIBLE";
  if (error.code === "memory_fact_not_useful") return "REJECT_NOT_USEFUL";
  if (error.code === "memory_fact_entity_unsupported") return "REJECT_ENTITY_UNSUPPORTED";
  if (error.code === "memory_fact_dependency_unsupported") {
    return "REJECT_DEPENDENCY_UNSUPPORTED";
  }
  if (error.code === "memory_fact_temporal_invalid") {
    return "REJECT_TEMPORAL_UNSUPPORTED";
  }
  if (error.code === "memory_fact_product_identity_unsupported") {
    return "REJECT_PRODUCT_IDENTITY_UNSUPPORTED";
  }
  if (error.code === "memory_fact_residence_identity_unsupported") {
    return "REJECT_RESIDENCE_IDENTITY_UNSUPPORTED";
  }
  if (error.code === "memory_fact_expiration_evidence_invalid") {
    return "REJECT_TEMPORARY";
  }
  if (error.code === "memory_fact_source_stale") return "REJECT_STALE_SOURCE";
  if (error.code === "memory_fact_confidence_low") return "REJECT_LOW_CONFIDENCE";
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

/** Resolves page-local exact text and records it at full-text offsets with
 * the full-text hash, the identity every later evidence proof rechecks. */
function exactEvidence(
  input: MemoryFactExtractionInput,
  ref: MemoryExactTextRef
): MemoryExtractedCandidate["evidence"] {
  const source = targetSource(input);
  const span = projectMemoryExactTextRef(source.text, ref);
  if (!span) fail("memory_fact_evidence_not_in_target");
  if ((source.redactionSpans ?? []).some((redacted) =>
    span.startOffset < redacted.endOffset && span.endOffset > redacted.startOffset)) {
    fail("memory_fact_secret");
  }
  const offset = memoryFactTargetTextOffset(input);
  return [{
    endOffset: offset + span.endOffset,
    messageId: source.id,
    quote: span.text,
    sourceTextHash: memoryFactTargetSourceHash(input, source),
    startOffset: offset + span.startOffset
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
  contextRefs: readonly string[];
  entities: readonly MemoryFactCandidateEntity[];
  entityAnnotationReviewRequired: boolean;
  supportsByType: ReadonlyMap<string, ReadonlySet<string>>;
}>;

function parseEntities(
  value: unknown,
  input: MemoryFactExtractionInput,
  quote: string,
  frame: MemorySemanticFrame,
  identity: MemoryIdentityProposal,
  allowUnresolvedAnnotations: boolean
): ParsedEntities {
  if (!Array.isArray(value) || value.length > 6) fail();
  const parsed: MemoryFactCandidateEntity[] = [];
  const contextRefs = new Set<string>();
  let entityAnnotationReviewRequired = false;
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
    if (proposedType === "PERSON" && role !== "SUBJECT") {
      fail("memory_fact_entity_unsupported");
    }
    const proposedLabel = nullableString(entity.canonical_label, 512);
    const mentionKind = enumValue<MemoryFactCandidateEntity["mentionKind"]>(
      entity.mention_kind,
      mentionKinds
    );
    const contextRef = nullableString(entity.context_entity_ref, 128);
    const context = contextRef === null ? null : input.contextRefs.find(
      (candidate) => candidate.ref === contextRef
    ) ?? fail("memory_fact_dependency_unsupported");
    if (context) contextRefs.add(context.ref);
    const directSelfAnnotation = proposedType === "PERSON_SELF" &&
      (frame.subjectScope === "CURRENT_USER" || frame.subjectScope === "UNKNOWN") &&
      (role === "SUBJECT" || (
        identity.subject.entityType === "PERSON_SELF" &&
        identity.predicateKey === null
      ));
    if (proposedType === "PERSON_SELF" && !directSelfAnnotation) {
      fail("memory_fact_entity_unsupported");
    }

    let sourceSupported = true;
    const entitySupports: string[] = [];
    const exactAnnotation = (raw: unknown, maxLength: number): string | null => {
      const ref = decodeMemoryExactTextRef(raw, maxLength);
      if (!ref) fail("memory_fact_entity_unsupported");
      const span = projectMemoryExactTextRef(quote, ref);
      if (!span) {
        sourceSupported = false;
        return null;
      }
      return span.text;
    };
    const mention = entity.mention === null ? null : exactAnnotation(entity.mention, 512);
    if (mention !== null) entitySupports.push(mention);
    if ((mentionKind === "NAMED" || mentionKind === "NOMINAL") &&
      mention === null) sourceSupported = false;
    if (mentionKind === "ELLIPSIS" && entity.mention !== null) {
      fail("memory_fact_entity_unsupported");
    }
    if ((mentionKind === "PRONOMINAL" || mentionKind === "ELLIPSIS") &&
      context === null && !directSelfAnnotation) {
      fail("memory_fact_dependency_unsupported");
    }

    const aliases = entity.aliases.map((rawAlias) => exactAnnotation(rawAlias, 256))
      .filter((alias): alias is string => alias !== null);
    entitySupports.push(...aliases);
    if (entity.aliases.length > 0 && mentionKind !== "NAMED" && mentionKind !== "NOMINAL") {
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
        contextRefs.add(ref);
      } else {
        exactAnnotation(support.source, 512);
      }
      entitySupports.push(supportValue);
      if (key === "brand" || key === "model") qualifiers[key] = supportValue;
    }

    if (!sourceSupported) {
      if (!allowUnresolvedAnnotations ||
        (mentionKind !== "NAMED" && mentionKind !== "NOMINAL")) {
        fail("memory_fact_entity_unsupported");
      }
      // Entity navigation is optional for a proposition. Keep every validated
      // source dependency, discard the unsupported annotation as a whole, and
      // require semantic authority before the underlying statement can persist.
      entityAnnotationReviewRequired = true;
      continue;
    }
    for (const text of entitySupports) addSupport(proposedType, text);
    const entityType = memoryEntityType(proposedType);
    if (!entityType || proposedType === "PERSON_SELF") continue;
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
  return {
    contextRefs: [...contextRefs], entities: parsed,
    entityAnnotationReviewRequired, supportsByType: supports
  };
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
      // A profession or role without a named employer lacks the organization
      // dimension required by the mutable SLOT but remains a valid open-world
      // direct-user proposition.
      return { ...identity, dimensionKey: null };
    }
  } else if (identity.predicateKey === "goal_status" ||
    identity.predicateKey === "project_status") {
    const expected = identity.predicateKey === "goal_status" ? "GOAL" : "PROJECT";
    if (!supported(supports, [expected], identity.subject.canonicalLabel)) {
      // Missing entity authority prevents a mutable SLOT, not a separately
      // entailed proposition. Discard every ungrounded identity dimension;
      // the original SLOT proposal still requires semantic adjudication.
      return {
        dimensionKey: null,
        mode: "PROPOSITION",
        predicateKey: null,
        subject: {
          canonicalLabel: null,
          entityType: "NONE",
          qualifiers: { brand: null, model: null }
        }
      };
    }
  }
  return identity;
}

function parseDependencies(input: Readonly<{
  entities: readonly MemoryFactCandidateEntity[];
  frame: MemorySemanticFrame;
  proposal: unknown;
  requiredRefs: readonly string[];
  temporal: MemoryTemporalProposal;
}>, source: MemoryFactExtractionInput): readonly MemoryFactCandidateDependency[] {
  if (!Array.isArray(input.proposal) || input.proposal.length > 3) fail();
  const proposedRefs = input.proposal.map((dependency) => boundedString(dependency, 128));
  if (new Set(proposedRefs).size !== proposedRefs.length) fail();
  // Every structural context reference is already validated. Derive the full
  // source dependency set instead of requiring the model to repeat each ref.
  const refs = [...new Set([...proposedRefs, ...input.requiredRefs])].sort();
  if (refs.length > 3) {
    fail("memory_fact_dependency_unsupported");
  }
  const correction = input.frame.polarity === "CORRECTION" ||
    input.frame.changeIntent === "CORRECTION";
  const coreference = input.entities.some((entity) =>
    entity.mentionKind === "PRONOMINAL" || entity.mentionKind === "ELLIPSIS");
  const coreferenceRefs = new Set(input.entities.flatMap((entity) =>
    (entity.mentionKind === "PRONOMINAL" || entity.mentionKind === "ELLIPSIS") &&
      entity.contextRef !== null ? [entity.contextRef] : []));
  // Structural subject/qualifier context supports the candidate without
  // proposing another correction target, even if the provider repeats that
  // ref in its declarations. Preserve it while keeping the correction source
  // singular; without a separate source, retain the structural fallback.
  const separateCorrectionRefs = proposedRefs.filter((ref) =>
    !input.requiredRefs.includes(ref));
  const correctionRefs = correction
    ? separateCorrectionRefs.length > 0
      ? separateCorrectionRefs
      : proposedRefs.length > 0 ? proposedRefs : input.requiredRefs
    : [];
  // A declared message source is not another possible pronoun antecedent.
  // Keep exactly one structural antecedent while retaining all source fences.
  // A correction may also be fully grounded in the direct target.
  if ((coreference && coreferenceRefs.size !== 1) || correctionRefs.length > 1) {
    fail("memory_fact_dependency_unsupported");
  }
  return refs.map((ref) => {
    const context = source.contextRefs.find((candidate) => candidate.ref === ref);
    if (!context) fail("memory_fact_dependency_unsupported");
    const dependencyKind: MemoryFactCandidateDependency["dependencyKind"] =
      correctionRefs.includes(ref)
      ? "CORRECTION_TARGET"
      : coreferenceRefs.has(ref)
        ? "COREFERENCE_ANTECEDENT"
        : correction
          ? "RELATION_CONTEXT"
          : input.temporal.rawExpression !== null
            ? "TEMPORAL_CONTEXT"
            : "RELATION_CONTEXT";
    return { dependencyKind, ref, source: context.source };
  });
}

function frameCanEnterPacket(
  frame: MemorySemanticFrame,
  memoryType: string,
  temporary: boolean
): boolean {
  if (frame.subjectScope !== "CURRENT_USER" &&
    frame.subjectScope !== "USER_RELATIONSHIP_CONTEXT" &&
    frame.subjectScope !== "UNKNOWN") {
    return false;
  }
  if (frame.assertionStatus !== "ASSERTED" && frame.assertionStatus !== "UNKNOWN") {
    return false;
  }
  const durablePreferenceCommand = frame.speechAct === "COMMAND" &&
    frame.memoryDirective === "NONE" && frame.assertionStatus === "ASSERTED" &&
    frame.subjectScope === "CURRENT_USER" && frame.changeIntent === "NONE" &&
    frame.polarity === "AFFIRMED" && memoryType === "PREFERENCE" && !temporary;
  if (frame.speechAct !== "ASSERTION" && frame.speechAct !== "UNKNOWN" && !(
    frame.speechAct === "COMMAND" && frame.memoryDirective === "EXPLICIT_REMEMBER"
  ) && !durablePreferenceCommand) return false;
  return frame.polarity === "AFFIRMED" || frame.polarity === "CORRECTION" ||
    frame.polarity === "NEGATED" || frame.polarity === "RETRACTION" ||
    frame.polarity === "UNKNOWN";
}

function groundedRelationshipSubject(
  entities: readonly MemoryFactCandidateEntity[]
): boolean {
  return entities.some((entity) => entity.role === "SUBJECT" && (
      ((entity.mentionKind === "NAMED" || entity.mentionKind === "NOMINAL") &&
        entity.mention !== null) ||
      ((entity.mentionKind === "PRONOMINAL" || entity.mentionKind === "ELLIPSIS") &&
        entity.contextRef !== null && entity.contextEntityId !== null)
    ));
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
  input: MemoryFactExtractionInput,
  retained = false
): MemoryExtractedCandidate {
  if (!isRecord(value) || !hasExactKeys(
    value,
    retained ? legacyObservationKeys : observationKeys
  )) fail();
  const source = targetSource(input);
  const candidateRef = boundedString(value.candidate_ref, 64);
  if (!boundedMachineToken.test(candidateRef)) fail();
  const statement = boundedString(value.statement, 2_000);
  const evidenceRef = decodeMemoryExactTextRef(
    value.evidence,
    MEMORY_FACT_MAX_EVIDENCE_CHARACTERS
  ) ?? fail("memory_fact_evidence_invalid");
  const evidence = exactEvidence(input, evidenceRef);
  const quote = evidence[0]!.quote!;
  if (memoryExplicitStatementContainsSecret(source.text) ||
    memoryExplicitStatementContainsSecret(statement) ||
    memoryExplicitStatementContainsSecret(quote)) fail("memory_fact_secret");
  const frame = parseSemanticFrame(value.semantic_frame);
  const temporary = requiredBoolean(value.temporary);
  const memoryType = boundedString(value.memory_type, 32);
  if (!frameCanEnterPacket(frame, memoryType, temporary)) {
    fail("memory_fact_subject_unsupported");
  }
  const confidenceBand = enumValue<NonNullable<
    MemoryExtractedCandidate["confidenceBand"]
  >>(value.confidence_band, confidenceBands, 16);
  if (confidenceBand === "LOW") fail("memory_fact_confidence_low");
  if (frame.speechAct === "COMMAND" && frame.memoryDirective === "NONE" &&
    confidenceBand !== "HIGH") fail("memory_fact_confidence_low");
  const sensitivity = enumValue(value.sensitivity, sensitivities, 16);
  if (sensitivity === "SECRET") fail("memory_fact_secret");
  // Direct personal testimony remains eligible independently of topic
  // sensitivity. Exact-source admission and local secret checks still apply.
  if (sensitivity !== "NORMAL" && sensitivity !== "SENSITIVE") {
    fail("memory_fact_sensitivity_ambiguous");
  }
  if (!requiredBoolean(value.future_useful)) fail("memory_fact_not_useful");
  if (value.usefulness === "TRANSIENT") fail("memory_fact_not_useful");
  const usefulness = value.usefulness === undefined
    ? undefined
    : decodeMemoryUsefulness(value.usefulness) ?? fail();
  boundedString(value.reason_code, 64);
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
    rawIdentity,
    confidenceBand === "HIGH" && rawIdentity.mode === "PROPOSITION"
  );
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
    requiredRefs: parsedEntities.contextRefs,
    temporal: temporalProposal
  }, input);
  const temporal = resolveMemoryTemporal({
    observedAt: new Date(source.createdAt),
    proposal: temporalProposal,
    timeZone: input.timeZone
  });
  if (temporalProposal.expirationIntent === "EXPLICIT" &&
    temporal.expiresAt === null) fail("memory_fact_expiration_evidence_invalid");
  // Limited relevance is not a deletion instruction. Future usefulness has
  // already been checked; only a grounded explicit TTL can set expiresAt.
  const identityInput = {
    identity: identityProposal,
    memoryType,
    semanticFrame: frame,
    statement,
    value: valueProposal
  } as const;
  const unicodeIdentity = resolveMemoryIdentity(identityInput, "UNICODE_V2");
  const resolvedIdentity = unicodeIdentity;
  // A negative assertion keeps its full statement meaning. A positive SLOT
  // value (for example owned) cannot represent the negation of that value.
  if (frame.polarity === "NEGATED" && resolvedIdentity.identityKind !== "PROPOSITION") {
    fail("memory_fact_unsupported");
  }
  const correction = frame.polarity === "CORRECTION" ||
    frame.changeIntent === "CORRECTION";
  if (confidenceBand === "MEDIUM" && (
    frame.speechAct !== "ASSERTION" || frame.assertionStatus !== "ASSERTED" ||
    (frame.subjectScope !== "CURRENT_USER" &&
      frame.subjectScope !== "USER_RELATIONSHIP_CONTEXT") ||
    frame.polarity !== "AFFIRMED" ||
    frame.changeIntent !== "NONE" || frame.memoryDirective !== "NONE" ||
    frame.temporalPerspective === "UNKNOWN" || correction ||
    resolvedIdentity.identityKind !== "PROPOSITION"
  )) fail("memory_fact_unsupported");
  if (parsedEntities.entities.some(({ entityType }) => entityType === "PERSON") &&
    resolvedIdentity.identityKind !== "PROPOSITION") {
    fail("memory_fact_entity_unsupported");
  }
  if (frame.subjectScope === "USER_RELATIONSHIP_CONTEXT" && (
    rawIdentity.mode !== "PROPOSITION" ||
    resolvedIdentity.identityKind !== "PROPOSITION" ||
    !groundedRelationshipSubject(parsedEntities.entities)
  )) fail("memory_fact_entity_unsupported");
  const supportingInput = {
    expectedAt: temporal.expectedAt,
    occurredAt: temporal.occurredAt,
    statement,
    validFrom: temporal.validFrom,
    validTo: temporal.validTo
  } as const;
  const unicodeSupportingCanonicalKey = confidenceBand === "MEDIUM"
    ? memorySupportingPropositionCanonicalKey({
        ...supportingInput
      }, "UNICODE_V2") ?? fail()
    : null;
  const unicodeSupportingStatement = confidenceBand === "MEDIUM"
    ? normalizeMemoryProposition(statement, "UNICODE_V2") ?? fail()
    : null;
  const supportingValue = (normalizedStatement: string) => ({
    authority: "supporting",
    normalizedStatement,
    schema: "supporting-observation-v1"
  });
  const unicodeProposedValue = unicodeSupportingStatement === null
    ? unicodeIdentity.structuredValue
    : supportingValue(unicodeSupportingStatement);
  const withoutId: Omit<MemoryExtractedCandidate, "id"> = {
    candidateRef,
    canonicalKey: unicodeSupportingCanonicalKey ?? unicodeIdentity.canonicalKey,
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
    ...(parsedEntities.entityAnnotationReviewRequired ? { entityAnnotationReviewRequired: true } : {}),
    evidence,
    expectedAt: temporal.expectedAt,
    expirationIntent: temporalProposal.expirationIntent,
    expiresAt: temporal.expiresAt,
    futureUseful: true,
    ...(usefulness === undefined ? {} : { usefulness }),
    identityProfile: input.identityProfile,
    identityKind: resolvedIdentity.identityKind,
    identityVersion: resolvedIdentity.identityVersion,
    importance: confidenceBand === "MEDIUM" ? 0.4 : 0.65,
    languageCode: source.languageCode,
    modality: modality(memoryType),
    negated: false,
    occurredAt: temporal.occurredAt,
    predicateKey: resolvedIdentity.predicateKey,
    proposedIdentityKind: rawIdentity.mode,
    proposedValue: unicodeProposedValue,
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
    unicodeCanonicalKey:
      unicodeSupportingCanonicalKey ?? unicodeIdentity.canonicalKey,
    unicodeProposedValue,
    validFrom: temporal.validFrom,
    validTo: temporal.validTo
  };
  return { ...withoutId, id: memoryFactCandidateId(input, withoutId) };
}

type EvidencePosition = Readonly<{
  end: number;
  ordinal: number;
  start: number;
}>;

type PacketSelection = Readonly<{
  coverageEnd?: number;
  rejected: ReadonlyMap<number, MemoryFactCandidateRejection["reasonCode"]>;
}>;

/** Full-text position of a raw observation's exact evidence, resolved without
 * decoding the observation; null when it does not resolve (and so fails). */
function rawEvidencePosition(
  value: unknown,
  text: string,
  offset: number,
  ordinal: number
): EvidencePosition | null {
  if (!isRecord(value)) return null;
  const ref = decodeMemoryExactTextRef(value.evidence, MEMORY_FACT_MAX_EVIDENCE_CHARACTERS);
  const span = ref ? projectMemoryExactTextRef(text, ref) : null;
  return span
    ? { end: offset + span.endOffset, ordinal, start: offset + span.startOffset }
    : null;
}

/**
 * Partitions one packet by where each observation's evidence starts. Evidence
 * starting after the page core belongs to the next page. A full packet may
 * have stopped early (the provider is asked for source order and at most one
 * packet), so it admits only observations that start before the first one it
 * cannot admit, or before its last one, and the next page resumes there. When
 * a full packet shares one evidence start, it admits one packet from that
 * start and resumes after the shared span; observations beyond that packet
 * are rejected as overflow instead of failing the whole output.
 */
function packetSelection(
  raw: readonly unknown[],
  input: MemoryFactExtractionInput
): PacketSelection {
  let source: MemoryFactExtractionInput["messages"][number];
  try {
    source = targetSource(input);
  } catch {
    // Every observation is then rejected by its own decode.
    return { rejected: new Map() };
  }
  const offset = memoryFactTargetTextOffset(input);
  const coreEnd = input.targetPage?.coreEnd ?? source.text.length;
  const rejected = new Map<number, MemoryFactCandidateRejection["reasonCode"]>();
  const inCore: EvidencePosition[] = [];
  let reachedBeyondCore = false;
  raw.forEach((value, ordinal) => {
    const position = rawEvidencePosition(value, source.text, offset, ordinal);
    if (!position) return;
    if (position.start >= coreEnd) {
      rejected.set(ordinal, "REJECT_OUTSIDE_PAGE");
      reachedBeyondCore = true;
      return;
    }
    inCore.push(position);
  });
  const packet = MEMORY_FACT_MAX_PACKET_CANDIDATES;
  if (raw.length < packet || inCore.length === 0 ||
    (inCore.length <= packet && reachedBeyondCore)) return { rejected };

  const sorted = [...inCore].sort((left, right) =>
    left.start - right.start || left.ordinal - right.ordinal);
  let cut = sorted[Math.min(packet, sorted.length - 1)]!.start;
  let admitted = sorted.filter(({ start }) => start < cut);
  if (admitted.length === 0) {
    const first = sorted[0]!.start;
    const shared = sorted.filter(({ start }) => start === first);
    const nextStart = sorted.find(({ start }) => start > first)?.start;
    const sharedEnd = Math.max(...shared.map(({ end }) => end));
    admitted = shared.slice(0, packet);
    cut = nextStart === undefined ? sharedEnd : Math.min(sharedEnd, nextStart);
  }
  const admittedOrdinals = new Set(admitted.map(({ ordinal }) => ordinal));
  for (const position of sorted) {
    if (!admittedOrdinals.has(position.ordinal)) {
      rejected.set(position.ordinal, "REJECT_PACKET_OVERFLOW");
    }
  }
  return {
    coverageEnd: offset + memoryFactPageBoundaryAfter(source.text, cut - offset),
    rejected
  };
}

function packetPlan(
  raw: readonly unknown[],
  input: MemoryFactExtractionInput,
  decode: (value: unknown, input: MemoryFactExtractionInput) => MemoryExtractedCandidate
): MemoryFactExtractionPlan {
  const selection = packetSelection(raw, input);
  const decoded: Array<{ candidate: MemoryExtractedCandidate; candidateOrdinal: number }> = [];
  const rejections: MemoryFactCandidateRejection[] = [...selection.rejected]
    .map(([candidateOrdinal, reasonCode]) => ({ candidateOrdinal, reasonCode }));
  const candidateRefs = new Set<string>();
  raw.forEach((value, candidateOrdinal) => {
    if (selection.rejected.has(candidateOrdinal)) return;
    try {
      const candidate = decode(value, input);
      if (candidateRefs.has(candidate.candidateRef)) {
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
  // Unreachable after packet selection; kept as the admission bound.
  for (const item of values.slice(MEMORY_FACT_MAX_ACCEPTED_CANDIDATES)) {
    rejections.push({
      candidateOrdinal: item.candidateOrdinal,
      reasonCode: "REJECT_PACKET_OVERFLOW"
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
    ...(selection.coverageEnd === undefined
      ? {}
      : { coverageEnd: selection.coverageEnd }),
    input,
    outputHash: memoryFactExtractionOutputHash(
      input,
      candidates,
      candidateOrdinals,
      rejections,
      selection.coverageEnd
    ),
    rejections
  };
}

/** Executable vNext strict packet. Candidate defects and observations beyond
 * one packet are isolated per ordinal; malformed call count/name/top-level
 * shape, or more observations than receipts can record, fails the output. */
export function decodeMemoryFactExtraction(
  calls: readonly ModelToolCall[] | undefined,
  input: MemoryFactExtractionInput,
  options: Readonly<{ retainedContract?: boolean }> = {}
): MemoryFactExtractionPlan {
  assertMemoryIdentityWritable(input.identityProfile);
  const retained = options.retainedContract === true;
  if (!calls || calls.length !== 1 ||
    (calls[0]?.name !== MEMORY_FACT_EXTRACTION_TOOL_NAME &&
      !(retained && calls[0]?.name === "submit_memory_fact_observations_v5")) ||
    !isRecord(calls[0].arguments) ||
    !hasExactKeys(calls[0].arguments, ["observations"]) ||
    !Array.isArray(calls[0].arguments.observations) ||
    calls[0].arguments.observations.length > MEMORY_FACT_MAX_RAW_OBSERVATIONS) fail();
  return packetPlan(
    calls[0].arguments.observations,
    input,
    (value, source) => decodeObservation(value, source, retained)
  );
}
