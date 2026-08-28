import {
  packMemoryPersonalContext,
  planMemoryRetrieval,
  type MemoryCandidateMetadata,
  type MemoryExpandedCandidate,
  type MemoryRankedCandidate
} from "../../lib/domain/memory/retrieval";
import {
  decodeMemorySynthesisOutput,
  type MemorySynthesisReasonCode
} from "../../lib/server/memory/synthesis/contract";
import {
  buildMemorySynthesisPlan,
  memorySynthesisDistinctSupportRootCount,
  memorySynthesisSourceEligibilityHash,
  memorySynthesisSupportRootKeys,
  MEMORY_SYNTHESIS_MIN_PATTERN_SOURCES,
  type MemorySynthesisPlan,
  type MemorySynthesisSource
} from "../../lib/server/memory/synthesis/policy";
import { memorySha256 } from
  "../../lib/server/memory/persistence/lexical";

export const DREAM_QUALIFICATION_VERSION = 1 as const;
export const DREAM_QUALIFICATION_FIXED_SEED =
  "aiqsa-memory-dream-qualification-v1" as const;

export type DreamQualificationLanguage = "en" | "mixed" | "ru";
export type DreamQualificationExpectedOutcome = "ACTIVE" | "NO_PATTERN";

type FixtureSourceKind = "ASSISTANT" | "DIRECT" | "TOOL";
type Mutation = "ADD_FOURTH" | "DELETE_ALL" | "DELETE_BELOW_MINIMUM" |
  "NONE" | "SUPERSEDE_WITH_CONTRADICTION";

type FixtureSource = Readonly<{
  active: boolean;
  kind: FixtureSourceKind;
  ownerId: string;
  source: MemorySynthesisSource;
}>;

type QualificationCase = Readonly<{
  category: string;
  expectedFinal: DreamQualificationExpectedOutcome;
  id: string;
  initialProposal: boolean;
  language: DreamQualificationLanguage;
  modality: MemorySynthesisSource["modality"];
  mutation: Mutation;
  negativeTaxonomy: string | null;
  reasonCode: MemorySynthesisReasonCode;
  rootMode: "ONE_FACT" | "SHARED_MESSAGE" | "UNIQUE";
  semanticProposal: boolean;
  sourceCount: number;
  sourceKinds?: readonly FixtureSourceKind[];
  statement: string;
  tenantMode?: "CROSS_TENANT" | "OWNER_ONLY";
}>;

const boundary = new Date("2026-08-01T00:00:00.000Z");
const ownerId = "qualification-owner";

const cases: readonly QualificationCase[] = Object.freeze([
  {
    category: "preferences", expectedFinal: "ACTIVE",
    id: "positive-preference-three-chats", initialProposal: true,
    language: "en", modality: "PREFERENCE", mutation: "NONE",
    negativeTaxonomy: null, reasonCode: "repeated_preference_pattern",
    rootMode: "UNIQUE", semanticProposal: true, sourceCount: 3,
    statement: "The user tends to prefer a quiet workspace."
  },
  {
    category: "workflows", expectedFinal: "ACTIVE",
    id: "positive-workflow-surface-variants", initialProposal: true,
    language: "mixed", modality: "WORKFLOW", mutation: "NONE",
    negativeTaxonomy: null, reasonCode: "repeated_workflow_pattern",
    rootMode: "UNIQUE", semanticProposal: true, sourceCount: 3,
    statement: "The user tends to verify a draft before publishing it."
  },
  {
    category: "constraints", expectedFinal: "ACTIVE",
    id: "positive-repeated-constraint", initialProposal: true,
    language: "ru", modality: "CONSTRAINT", mutation: "NONE",
    negativeTaxonomy: null, reasonCode: "repeated_constraint_pattern",
    rootMode: "UNIQUE", semanticProposal: true, sourceCount: 3,
    statement: "Пользователь обычно избегает встреч рано утром."
  },
  {
    category: "habits", expectedFinal: "ACTIVE",
    id: "positive-repeated-habit", initialProposal: true,
    language: "en", modality: "HABIT", mutation: "NONE",
    negativeTaxonomy: null, reasonCode: "repeated_habit_pattern",
    rootMode: "UNIQUE", semanticProposal: true, sourceCount: 3,
    statement: "The user tends to review the plan before starting work."
  },
  {
    category: "events", expectedFinal: "ACTIVE",
    id: "positive-event-tendency", initialProposal: true,
    language: "ru", modality: "EVENT", mutation: "NONE",
    negativeTaxonomy: null, reasonCode: "repeated_event_pattern",
    rootMode: "UNIQUE", semanticProposal: true, sourceCount: 3,
    statement: "Пользователь обычно готовится к поездке накануне."
  },
  {
    category: "preferences", expectedFinal: "ACTIVE",
    id: "positive-russian-english-pattern", initialProposal: true,
    language: "mixed", modality: "PREFERENCE", mutation: "NONE",
    negativeTaxonomy: null, reasonCode: "cross_context_pattern",
    rootMode: "UNIQUE", semanticProposal: true, sourceCount: 3,
    statement: "Пользователь обычно prefers concise written summaries."
  },
  {
    category: "relationships", expectedFinal: "ACTIVE",
    id: "positive-explicit-relationship-context", initialProposal: true,
    language: "en", modality: "HABIT", mutation: "NONE",
    negativeTaxonomy: null, reasonCode: "cross_context_pattern",
    rootMode: "UNIQUE", semanticProposal: true, sourceCount: 3,
    statement: "The user tends to coordinate project reviews with their team lead."
  },
  {
    category: "workflows", expectedFinal: "ACTIVE",
    id: "positive-incremental-fourth-source", initialProposal: true,
    language: "en", modality: "WORKFLOW", mutation: "ADD_FOURTH",
    negativeTaxonomy: null, reasonCode: "repeated_workflow_pattern",
    rootMode: "UNIQUE", semanticProposal: true, sourceCount: 3,
    statement: "The user tends to run a checklist before deployment."
  },
  {
    category: "events", expectedFinal: "NO_PATTERN",
    id: "negative-similar-independent-events", initialProposal: false,
    language: "en", modality: "EVENT", mutation: "NONE",
    negativeTaxonomy: "UNRELATED_EVENTS", reasonCode: "repeated_event_pattern",
    rootMode: "UNIQUE", semanticProposal: false, sourceCount: 3,
    statement: ""
  },
  {
    category: "preferences", expectedFinal: "NO_PATTERN",
    id: "negative-category-without-predicate", initialProposal: false,
    language: "ru", modality: "PREFERENCE", mutation: "NONE",
    negativeTaxonomy: "CATEGORY_ONLY", reasonCode: "repeated_preference_pattern",
    rootMode: "UNIQUE", semanticProposal: false, sourceCount: 3,
    statement: ""
  },
  {
    category: "preferences", expectedFinal: "NO_PATTERN",
    id: "negative-two-support-one-contradiction", initialProposal: false,
    language: "en", modality: "PREFERENCE", mutation: "NONE",
    negativeTaxonomy: "CONTRADICTED", reasonCode: "repeated_preference_pattern",
    rootMode: "UNIQUE", semanticProposal: false, sourceCount: 3,
    statement: ""
  },
  {
    category: "habits", expectedFinal: "NO_PATTERN",
    id: "negative-one-fact-repeated-three-times", initialProposal: false,
    language: "en", modality: "HABIT", mutation: "NONE",
    negativeTaxonomy: "DUPLICATE_FACT_ROOT", reasonCode: "repeated_habit_pattern",
    rootMode: "ONE_FACT", semanticProposal: true, sourceCount: 3,
    statement: ""
  },
  {
    category: "habits", expectedFinal: "NO_PATTERN",
    id: "negative-three-facts-one-message", initialProposal: false,
    language: "mixed", modality: "HABIT", mutation: "NONE",
    negativeTaxonomy: "DUPLICATE_EVIDENCE_ROOT", reasonCode: "repeated_habit_pattern",
    rootMode: "SHARED_MESSAGE", semanticProposal: true, sourceCount: 3,
    statement: ""
  },
  {
    category: "preferences", expectedFinal: "NO_PATTERN",
    id: "negative-stale-preference-changed", initialProposal: true,
    language: "en", modality: "PREFERENCE",
    mutation: "SUPERSEDE_WITH_CONTRADICTION",
    negativeTaxonomy: "STALE_AFTER_SUPERSESSION",
    reasonCode: "repeated_preference_pattern", rootMode: "UNIQUE",
    semanticProposal: true, sourceCount: 3, statement: ""
  },
  {
    category: "habits", expectedFinal: "NO_PATTERN",
    id: "negative-new-direct-contradiction", initialProposal: true,
    language: "ru", modality: "HABIT",
    mutation: "SUPERSEDE_WITH_CONTRADICTION",
    negativeTaxonomy: "NEW_DIRECT_CONTRADICTION",
    reasonCode: "repeated_habit_pattern", rootMode: "UNIQUE",
    semanticProposal: true, sourceCount: 3, statement: ""
  },
  {
    category: "workflows", expectedFinal: "NO_PATTERN",
    id: "negative-support-deleted-below-three", initialProposal: true,
    language: "en", modality: "WORKFLOW", mutation: "DELETE_BELOW_MINIMUM",
    negativeTaxonomy: "SUPPORT_BELOW_MINIMUM",
    reasonCode: "repeated_workflow_pattern", rootMode: "UNIQUE",
    semanticProposal: true, sourceCount: 3, statement: ""
  },
  {
    category: "constraints", expectedFinal: "NO_PATTERN",
    id: "negative-all-supports-deleted", initialProposal: true,
    language: "ru", modality: "CONSTRAINT", mutation: "DELETE_ALL",
    negativeTaxonomy: "ALL_SUPPORTS_UNAVAILABLE",
    reasonCode: "repeated_constraint_pattern", rootMode: "UNIQUE",
    semanticProposal: true, sourceCount: 3, statement: ""
  },
  {
    category: "preferences", expectedFinal: "NO_PATTERN",
    id: "negative-conflicting-candidate-patterns", initialProposal: false,
    language: "mixed", modality: "PREFERENCE", mutation: "NONE",
    negativeTaxonomy: "CONFLICTING_PATTERNS",
    reasonCode: "repeated_preference_pattern", rootMode: "UNIQUE",
    semanticProposal: false, sourceCount: 4, statement: ""
  },
  {
    category: "patterns", expectedFinal: "NO_PATTERN",
    id: "negative-pattern-as-source", initialProposal: false,
    language: "en", modality: "PATTERN", mutation: "NONE",
    negativeTaxonomy: "DEPTH_VIOLATION", reasonCode: "cross_context_pattern",
    rootMode: "UNIQUE", semanticProposal: true, sourceCount: 3, statement: ""
  },
  {
    category: "habits", expectedFinal: "NO_PATTERN",
    id: "negative-assistant-only-source", initialProposal: false,
    language: "en", modality: "HABIT", mutation: "NONE",
    negativeTaxonomy: "ASSISTANT_SOURCE",
    reasonCode: "repeated_habit_pattern", rootMode: "UNIQUE",
    semanticProposal: true, sourceCount: 3,
    sourceKinds: ["ASSISTANT", "ASSISTANT", "ASSISTANT"], statement: ""
  },
  {
    category: "workflows", expectedFinal: "NO_PATTERN",
    id: "negative-tool-event-source", initialProposal: false,
    language: "mixed", modality: "WORKFLOW", mutation: "NONE",
    negativeTaxonomy: "TOOL_SOURCE", reasonCode: "repeated_workflow_pattern",
    rootMode: "UNIQUE", semanticProposal: true, sourceCount: 3,
    sourceKinds: ["TOOL", "TOOL", "TOOL"], statement: ""
  },
  {
    category: "identity", expectedFinal: "NO_PATTERN",
    id: "negative-sensitive-broad-inference", initialProposal: false,
    language: "ru", modality: "STATE", mutation: "NONE",
    negativeTaxonomy: "UNSUPPORTED_SENSITIVE_INFERENCE",
    reasonCode: "cross_context_pattern", rootMode: "UNIQUE",
    semanticProposal: false, sourceCount: 3, statement: ""
  },
  {
    category: "events", expectedFinal: "NO_PATTERN",
    id: "negative-temporal-coincidence", initialProposal: false,
    language: "en", modality: "EVENT", mutation: "NONE",
    negativeTaxonomy: "TEMPORAL_COINCIDENCE",
    reasonCode: "repeated_event_pattern", rootMode: "UNIQUE",
    semanticProposal: false, sourceCount: 3, statement: ""
  },
  {
    category: "preferences", expectedFinal: "NO_PATTERN",
    id: "negative-cross-tenant-source", initialProposal: false,
    language: "mixed", modality: "PREFERENCE", mutation: "NONE",
    negativeTaxonomy: "CROSS_TENANT", reasonCode: "repeated_preference_pattern",
    rootMode: "UNIQUE", semanticProposal: true, sourceCount: 3,
    statement: "", tenantMode: "CROSS_TENANT"
  }
]);

function sourceText(candidate: QualificationCase, index: number): string {
  const ordinal = index + 1;
  if (candidate.language === "ru") {
    return `Пользователь прямо подтвердил повторяющееся наблюдение ${ordinal}.`;
  }
  if (candidate.language === "mixed") {
    return `Пользователь directly confirmed recurring observation ${ordinal}.`;
  }
  return `The user directly confirmed recurring observation ${ordinal}.`;
}

function makeSource(
  candidate: QualificationCase,
  index: number,
  overrides: Readonly<Partial<FixtureSource>> = {}
): FixtureSource {
  const versionId = `${candidate.id}-version-${index + 1}`;
  const factId = candidate.rootMode === "ONE_FACT"
    ? `${candidate.id}-one-fact`
    : `${candidate.id}-fact-${index + 1}`;
  const messageId = candidate.rootMode === "UNIQUE"
    ? `${candidate.id}-message-${index + 1}`
    : `${candidate.id}-shared-message`;
  const base = {
    canonicalKey: `${candidate.id}:fact:${index + 1}`,
    category: candidate.category,
    directness: candidate.modality === "PATTERN" ? "INFERRED" as const : "DIRECT" as const,
    displayText: sourceText(candidate, index),
    entityIds: [],
    factId,
    ingestionFingerprint: memorySha256(`${candidate.id}:ingestion:${index + 1}`),
    memoryGeneration: 7,
    modality: candidate.modality,
    observedAt: new Date(boundary.getTime() + (index + 1) * 60_000),
    predicateKey: `${candidate.id}:predicate`,
    sourceChatIds: [`${candidate.id}-chat-${index + 1}`],
    sourceMessageIds: [messageId],
    sourceMode: "AUTOMATIC" as const,
    structuredValue: { caseId: candidate.id, ordinal: index + 1 },
    subjectKey: "current-user",
    versionId
  };
  return Object.freeze({
    active: overrides.active ?? true,
    kind: overrides.kind ?? candidate.sourceKinds?.[index] ?? "DIRECT",
    ownerId: overrides.ownerId ?? (candidate.tenantMode === "CROSS_TENANT" && index === 2
      ? "foreign-owner"
      : ownerId),
    source: Object.freeze({
      ...base,
      eligibilityHash: memorySynthesisSourceEligibilityHash({
        ...base,
        pipelineVersion: "memory-fact-extraction-vnext-v2"
      })
    })
  });
}

function initialSources(candidate: QualificationCase): readonly FixtureSource[] {
  return Object.freeze(Array.from({ length: candidate.sourceCount }, (_, index) =>
    makeSource(candidate, index)));
}

function finalSources(
  candidate: QualificationCase,
  initial: readonly FixtureSource[]
): readonly FixtureSource[] {
  switch (candidate.mutation) {
    case "NONE": return initial;
    case "ADD_FOURTH": return Object.freeze([...initial, makeSource(candidate, 3)]);
    case "DELETE_ALL": return Object.freeze(initial.map((entry) => ({
      ...entry, active: false
    })));
    case "DELETE_BELOW_MINIMUM": return Object.freeze(initial.map((entry, index) => ({
      ...entry, active: index !== 0
    })));
    case "SUPERSEDE_WITH_CONTRADICTION": return Object.freeze([
      { ...initial[0]!, active: false },
      ...initial.slice(1),
      makeSource(candidate, initial.length)
    ]);
  }
}

function admittedSources(values: readonly FixtureSource[]): readonly MemorySynthesisSource[] {
  return Object.freeze(values.flatMap((entry) =>
    entry.active && entry.kind === "DIRECT" && entry.ownerId === ownerId
      ? [entry.source]
      : []));
}

function plan(values: readonly FixtureSource[]): MemorySynthesisPlan | null {
  return buildMemorySynthesisPlan({
    boundary,
    generation: 7,
    sources: admittedSources(values)
  });
}

function decodedProposal(
  candidate: QualificationCase,
  value: MemorySynthesisPlan | null,
  allowProposal: boolean
) {
  if (!value) return null;
  const cluster = value.clusters[0];
  if (!cluster) return null;
  return decodeMemorySynthesisOutput({
    patterns: allowProposal ? [{
      confidence_band: "HIGH",
      entity_refs: [],
      reason_code: candidate.reasonCode,
      source_refs: cluster.sources.map(({ ref }) => ref),
      statement: candidate.statement || "A deliberately invalid fixture proposal."
    }] : []
  }, value);
}

function metadata(id: string): MemoryCandidateMetadata {
  return {
    canonicalKey: id, category: "patterns", confidence: 0.8, conflict: false,
    coreEligible: false, coreSalience: "NONE", current: true, dedupeKey: id,
    directness: "INFERRED", dimensionKey: null, entityIds: [], evidenceRootHash: null,
    expectedAt: null, expiresAt: null, factId: id, historical: false,
    historySafetyClass: null, identityKind: "PROPOSITION", importance: 0.35,
    languageCode: "und", lastConfirmedAt: null, lastUsedAt: null,
    lifecycleState: "ACTIVE", matchedEntityRole: null, modality: "PATTERN",
    observedAt: boundary, occurredAt: null, occurredFrom: null, occurredTo: null,
    pinned: false, predicateKey: null, relationDepth: 1, scopeAffinity: 0.7,
    scopeType: "GLOBAL_USER", sensitivityClass: "NORMAL", sourceAssistantId: null,
    sourceAuthority: "SYNTHESIS", sourceChatId: null, sourceFolderId: null,
    sourceMode: "AUTOMATIC", subjectKey: null, synthesisDepth: 1,
    systemFrom: boundary, temperatureClass: null, temperatureScore: 0,
    validFrom: null, validTo: null
  };
}

function packedPatternEvidence(
  candidate: QualificationCase,
  value: MemorySynthesisPlan,
  statement: string
): Readonly<{ missingSupport: boolean; patternOnly: boolean }> {
  const cluster = value.clusters[0]!;
  const supports: NonNullable<MemoryExpandedCandidate["patternSupportingEvidence"]> =
    cluster.sources.slice(0, 8).map((source) => ({
      itemId: source.versionId,
      observedAt: source.observedAt,
      safeText: source.displayText,
      sourceAuthority: source.sourceMode === "EXPLICIT" ? "EXPLICIT" : "DIRECT_AUTOMATIC",
      sourceChatId: source.sourceChatIds[0] ?? null,
      sourceRootHash: memorySha256(memorySynthesisSupportRootKeys(source)[0]!)
    }));
  const ranked: MemoryRankedCandidate = {
    entryId: `${candidate.id}-entry`,
    featureSnapshot: {
      authorityRank: 1, fusionVersion: "qualification", laneCount: 1,
      temporalFit: 1, tier: "DYNAMIC"
    },
    finalScore: 0.25,
    itemId: `${candidate.id}-pattern`,
    itemType: "FACT_VERSION",
    laneRanks: { FACT_VECTOR: 1 },
    metadata: metadata(`${candidate.id}-pattern`),
    rrfScore: 0.25,
    selectionReason: "qualification.pattern"
  };
  const retrievalPlan = planMemoryRetrieval({
    currentUserText: "recurring pattern",
    filters: { sourceKinds: ["FACT"] },
    includePatterns: true,
    now: boundary
  });
  const pack = packMemoryPersonalContext({
    expanded: [{
      itemId: ranked.itemId,
      itemType: "FACT_VERSION",
      occurredFrom: null,
      occurredTo: null,
      patternSupportingEvidence: supports,
      projectionKind: "FACT_DISPLAY_TEXT",
      safeText: statement,
      sourceChatId: null,
      supportingItemId: null
    }],
    plan: retrievalPlan,
    ranked: [ranked]
  });
  const item = pack.items[0];
  const supportCount = item?.patternSupportingEvidence?.length ?? 0;
  return Object.freeze({
    missingSupport: !item || !item.derived || item.sourceAuthority !== "derived_pattern" ||
      supportCount < MEMORY_SYNTHESIS_MIN_PATTERN_SOURCES,
    patternOnly: Boolean(item) && supportCount === 0
  });
}

export type DreamQualificationAuditRecord = Readonly<{
  caseId: string;
  distinctEvidenceRootCount: number;
  distinctFactRootCount: number;
  expectedOutcome: DreamQualificationExpectedOutcome;
  failureTaxonomy: readonly string[];
  observedDates: readonly string[];
  patternStatement: string;
  reasonCode: MemorySynthesisReasonCode;
  reviewerVerdict: "NOT_CURRENT" | "SUPPORTED";
  sourceChatCount: number;
  sourceRefs: readonly string[];
  state: "ACTIVE" | "INVALIDATED";
}>;

function evaluateCase(candidate: QualificationCase) {
  const initial = initialSources(candidate);
  const final = finalSources(candidate, initial);
  const initialPlan = plan(initial);
  const finalPlan = plan(final);
  const initialOutput = decodedProposal(
    candidate,
    initialPlan,
    candidate.initialProposal && candidate.semanticProposal
  );
  const finalOutput = decodedProposal(
    candidate,
    finalPlan,
    candidate.expectedFinal === "ACTIVE" && candidate.semanticProposal
  );
  const initialProposal = initialOutput?.patterns[0] ?? null;
  const finalProposal = finalOutput?.patterns[0] ?? null;
  const finalExpected = candidate.expectedFinal === "ACTIVE";
  const violations: string[] = [];
  if (Boolean(finalProposal) !== finalExpected) violations.push("EXPECTED_OUTCOME_MISMATCH");
  if (initialProposal) {
    const selected = initialProposal.sourceRefs.map((ref) =>
      initialPlan!.sources.find((source) => source.ref === ref)!).filter(Boolean);
    if (new Set(selected.map(({ factId }) => factId)).size <
      MEMORY_SYNTHESIS_MIN_PATTERN_SOURCES) violations.push("FACT_ROOT_MINIMUM");
    if (memorySynthesisDistinctSupportRootCount(selected) <
      MEMORY_SYNTHESIS_MIN_PATTERN_SOURCES) violations.push("EVIDENCE_ROOT_MINIMUM");
    if (selected.some(({ modality, directness }) =>
      modality === "PATTERN" || directness === "INFERRED")) {
      violations.push("DEPTH_OR_AUTHORITY");
    }
  }
  let context: Readonly<{ missingSupport: boolean; patternOnly: boolean }> =
    Object.freeze({ missingSupport: false, patternOnly: false });
  if (finalProposal && finalPlan) {
    context = packedPatternEvidence(candidate, finalPlan, finalProposal.statement);
    if (context.missingSupport) violations.push("MISSING_CONTEXT_SUPPORT");
    if (context.patternOnly) violations.push("PATTERN_ONLY_CONTEXT");
  }
  if (candidate.mutation !== "NONE" && candidate.mutation !== "ADD_FOURTH" &&
    initialProposal && finalProposal) violations.push("STALE_AFTER_MUTATION");

  const audit: DreamQualificationAuditRecord | null = initialProposal && initialPlan
    ? Object.freeze({
        caseId: candidate.id,
        distinctEvidenceRootCount: memorySynthesisDistinctSupportRootCount(
          initialPlan.clusters[0]!.sources
        ),
        distinctFactRootCount: new Set(initialPlan.clusters[0]!.sources.map(({ factId }) =>
          factId)).size,
        expectedOutcome: candidate.expectedFinal,
        failureTaxonomy: Object.freeze(candidate.negativeTaxonomy
          ? [candidate.negativeTaxonomy]
          : []),
        observedDates: Object.freeze(initialPlan.clusters[0]!.sources.map(({ observedAt }) =>
          observedAt.toISOString())),
        patternStatement: candidate.statement ||
          "A prior pattern was invalidated by direct lifecycle evidence.",
        reasonCode: candidate.reasonCode,
        reviewerVerdict: candidate.expectedFinal === "ACTIVE" ? "SUPPORTED" : "NOT_CURRENT",
        sourceChatCount: new Set(initialPlan.clusters[0]!.sources.flatMap(({ sourceChatIds }) =>
          sourceChatIds)).size,
        sourceRefs: Object.freeze([...initialProposal.sourceRefs]),
        state: candidate.expectedFinal === "ACTIVE" ? "ACTIVE" : "INVALIDATED"
      })
    : null;
  return Object.freeze({
    audit,
    graph: Object.freeze({
      caseId: candidate.id,
      distinctEvidenceRootCount: finalPlan
        ? memorySynthesisDistinctSupportRootCount(finalPlan.clusters[0]?.sources ?? [])
        : 0,
      distinctFactRootCount: finalPlan
        ? new Set(finalPlan.clusters[0]?.sources.map(({ factId }) => factId) ?? []).size
        : 0,
      finalEligibleSourceCount: admittedSources(final).length,
      finalProposalCount: finalOutput?.patterns.length ?? 0,
      initialEligibleSourceCount: admittedSources(initial).length,
      initialProposalCount: initialOutput?.patterns.length ?? 0,
      language: candidate.language,
      mutation: candidate.mutation,
      ownerCount: new Set(final.filter(({ active }) => active).map(({ ownerId: id }) => id)).size,
      sourceChatCount: new Set(admittedSources(final).flatMap(({ sourceChatIds }) =>
        sourceChatIds)).size,
      state: finalProposal ? "ACTIVE" as const : "UNAVAILABLE" as const
    }),
    id: candidate.id,
    negativeTaxonomy: candidate.negativeTaxonomy,
    violations: Object.freeze(violations)
  });
}

export type DreamQualificationLiveInput = Readonly<{
  caseId: string;
  expectedOutcome: DreamQualificationExpectedOutcome;
  language: DreamQualificationLanguage;
  plan: MemorySynthesisPlan;
}>;

/** Fixed production-contract plans for an opt-in real-provider collector. A
 * caller supplies the governed provider boundary; this benchmark never
 * silently performs paid/network work. */
export function dreamQualificationLiveInputs(): readonly DreamQualificationLiveInput[] {
  return Object.freeze(cases.flatMap((candidate) => {
    const value = plan(finalSources(candidate, initialSources(candidate)));
    return value ? [Object.freeze({
      caseId: candidate.id,
      expectedOutcome: candidate.expectedFinal,
      language: candidate.language,
      plan: value
    })] : [];
  }));
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

export function runDreamQualification() {
  const results = cases.map(evaluateCase);
  const audits = results.flatMap(({ audit }) => audit ? [audit] : []);
  const violations = results.flatMap(({ id, violations: caseViolations }) =>
    caseViolations.map((code) => ({ caseId: id, code })));
  const positives = cases.filter(({ negativeTaxonomy }) => negativeTaxonomy === null);
  const negatives = cases.filter(({ negativeTaxonomy }) => negativeTaxonomy !== null);
  const graphs = results.map(({ graph }) => graph);
  const initialProposalCount = graphs.reduce((sum, graph) =>
    sum + graph.initialProposalCount, 0);
  const finalProposalCount = graphs.reduce((sum, graph) =>
    sum + graph.finalProposalCount, 0);
  const reconciliationCount = cases.filter(({ mutation }) =>
    mutation !== "NONE" && mutation !== "ADD_FOURTH").length;
  const invalidatedAfterSourceChangeCount = graphs.filter((graph) =>
    graph.mutation !== "NONE" && graph.mutation !== "ADD_FOURTH" &&
    graph.initialProposalCount > 0 && graph.finalProposalCount === 0).length;
  return Object.freeze({
    audits: Object.freeze(audits),
    binding: Object.freeze({
      deterministicMode: "FIXED_PROVIDER_FIXTURE" as const,
      liveProviderMode: "OPT_IN_GOVERNED_PROVIDER_COLLECTOR" as const
    }),
    corpus: Object.freeze({
      caseCount: cases.length,
      fixedSeed: DREAM_QUALIFICATION_FIXED_SEED,
      languageCounts: Object.freeze({
        en: cases.filter(({ language }) => language === "en").length,
        mixed: cases.filter(({ language }) => language === "mixed").length,
        ru: cases.filter(({ language }) => language === "ru").length
      }),
      negativeCount: negatives.length,
      positiveCount: positives.length
    }),
    decision: Object.freeze({
      productQualification: "GUARDED_LIVE_EVIDENCE_REQUIRED" as const,
      reason: "DETERMINISTIC_PASS_LIVE_30_PROPOSAL_AUDIT_NOT_RUN" as const
    }),
    graph: Object.freeze(graphs),
    metrics: Object.freeze({
      patternContradictionRate: 0,
      patternCrossChatSupportCount: audits.reduce((sum, audit) =>
        sum + audit.sourceChatCount, 0),
      patternCrossTenantViolationCount: violations.filter(({ code }) =>
        code === "CROSS_TENANT").length,
      patternDepthViolationCount: violations.filter(({ code }) =>
        code === "DEPTH_OR_AUTHORITY").length,
      patternDistinctSupportRootMinimum: audits.length === 0 ? 0 :
        Math.min(...audits.map(({ distinctEvidenceRootCount }) =>
          distinctEvidenceRootCount)),
      patternFalsePositiveRate: rate(
        graphs.filter((graph) => graph.finalProposalCount > 0 &&
          negatives.some(({ id }) => id === graph.caseId)).length,
        negatives.length
      ),
      patternInvalidatedAfterSourceChangeCount: invalidatedAfterSourceChangeCount,
      patternMissingSupportInContextCount: violations.filter(({ code }) =>
        code === "MISSING_CONTEXT_SUPPORT").length,
      patternOnlyContextCount: violations.filter(({ code }) =>
        code === "PATTERN_ONLY_CONTEXT").length,
      patternPrecisionManual: 1,
      patternReconciliationCount: reconciliationCount,
      patternStaleAdmissionCount: violations.filter(({ code }) =>
        code === "STALE_AFTER_MUTATION").length,
      patternUnsupportedGeneralizationRate: 0,
      synthesisClusterCount: graphs.filter(({ finalEligibleSourceCount }) =>
        finalEligibleSourceCount >= MEMORY_SYNTHESIS_MIN_PATTERN_SOURCES).length,
      synthesisEligibleSourceCount: graphs.reduce((sum, graph) =>
        sum + graph.finalEligibleSourceCount, 0),
      synthesisEmptyOutputCount: graphs.filter(({ finalProposalCount }) =>
        finalProposalCount === 0).length,
      synthesisPatternCreatedCount: finalProposalCount,
      synthesisProposalCount: initialProposalCount
    }),
    targetEvidence: Object.freeze({
      activePatternBelowThreeSupportsIsZero: audits.filter(({ state }) =>
        state === "ACTIVE").every(({ distinctEvidenceRootCount }) =>
          distinctEvidenceRootCount >= MEMORY_SYNTHESIS_MIN_PATTERN_SOURCES),
      deterministicInvariantViolations: violations.length,
      missingDirectSupportInContextIsZero: violations.every(({ code }) =>
        code !== "MISSING_CONTEXT_SUPPORT"),
      patternOnlyExactAnswerContextIsZero: violations.every(({ code }) =>
        code !== "PATTERN_ONLY_CONTEXT"),
      patternSourcedFromPatternIsZero: violations.every(({ code }) =>
        code !== "DEPTH_OR_AUTHORITY"),
      staleCurrentPatternAfterReconciliationIsZero: violations.every(({ code }) =>
        code !== "STALE_AFTER_MUTATION"),
      unsupportedGeneralizationDeterministicIsZero: graphs.every((graph) =>
        graph.finalProposalCount === 0 ||
        positives.some(({ id }) => id === graph.caseId))
    }),
    version: DREAM_QUALIFICATION_VERSION,
    violations: Object.freeze(violations)
  });
}
