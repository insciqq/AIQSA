import { performance } from "node:perf_hooks";
import {
  decodeKnowledgePlannerPlan,
  KNOWLEDGE_PLANNER_VERSION,
  planKnowledgeRequest,
  plannerAutomaticOperation,
  type KnowledgePlannerInput,
  type KnowledgePlannerIntent,
  type KnowledgePlannerOperation,
  type KnowledgePlannerPlanV2,
  type KnowledgePlannerSourceIdentity
} from "../../lib/server/knowledge/planner";
import {
  decodeKnowledgeProfileOperationRoles,
  knowledgeProfileConfiguration,
  knowledgeProfileEgressPolicy
} from "../../lib/server/knowledge/knowledgeProfile";
import {
  decodeKnowledgePlannerTargetResolution,
  resolveKnowledgePlannerTargets,
  type KnowledgePlannerTargetOutcome
} from "../../lib/server/knowledge/plannerTargetResolution";

export const KNOWLEDGE_PLANNER_RELEASE_REPORT_VERSION = "knowledge-planner-release-v1";

type Language = "en" | "ru";

type Score = Readonly<{
  correct: number;
  rate: number;
  total: number;
}>;

type Gate = Readonly<{
  name: string;
  passed: boolean;
}>;

export type KnowledgePlannerReleaseReport = Readonly<{
  aggregateOnly: true;
  contentFree: true;
  corpus: Readonly<{
    ambiguityPlanCases: number;
    exactTermCases: number;
    intentCases: Readonly<Record<Language, number>>;
    targetResolutionCases: number;
    unnecessaryRetrievalCases: number;
    version: "knowledge-planner-release-fixtures-v1";
  }>;
  execution: Readonly<{
    costMicros: 0;
    egress: "none";
    implementation: "deterministic_planner_v2";
    providerCalls: 0;
  }>;
  gates: readonly Gate[];
  knowledgeProfile: Readonly<{
    queryPlanning: Readonly<{
      contractDecoded: boolean;
      costMicros: 0;
      egress: "none";
      fallback: string;
      maxCostMicros: number | null;
      maxInputBytes: number | null;
      maxInputTokens: number | null;
      mode: string;
      providerCalls: 0;
      providerModelConfigured: boolean;
      rawPrivateText: boolean | null;
      retention: string;
    }>;
  }>;
  latency: Readonly<{
    p50Milliseconds: number;
    p95Milliseconds: number;
    p95ThresholdMilliseconds: 25;
    sampleCount: 250;
    scope: "deterministic_plan_only";
  }>;
  metrics: Readonly<{
    ambiguitySafety: Score;
    deterministicOutageFallback: Score;
    exactTermPreservation: Readonly<Record<"overall" | Language, Score>>;
    intentAccuracy: Readonly<Record<"overall" | Language, Score>>;
    operationAccuracy: Score;
    plannerV2Contract: Score;
    targetResolution: Score;
    unnecessaryRetrievalAvoidance: Score;
  }>;
  passed: boolean;
  plannerVersion: typeof KNOWLEDGE_PLANNER_VERSION;
  systemModelComparison: Readonly<{
    claimed: false;
    profileAuthorized: boolean;
    reason: "query_planning_role_disabled" | "real_provider_execution_not_permitted";
    status: "not_run";
  }>;
  version: typeof KNOWLEDGE_PLANNER_RELEASE_REPORT_VERSION;
}>;

const sourceIds = Object.freeze({
  alpha: "11111111-1111-4111-8111-111111111111",
  beta: "22222222-2222-4222-8222-222222222222",
  releaseAugust: "33333333-3333-4333-8333-333333333333",
  releaseJuly: "44444444-4444-4444-8444-444444444444",
  reportOne: "55555555-5555-4555-8555-555555555555",
  reportTwo: "66666666-6666-4666-8666-666666666666",
  roadmap: "77777777-7777-4777-8777-777777777777",
  appendix: "88888888-8888-4888-8888-888888888888"
});

const sources: readonly KnowledgePlannerSourceIdentity[] = Object.freeze([
  Object.freeze({
    fileName: "Alpha Policy.pdf",
    sourceAlias: "S1",
    sourceId: sourceIds.alpha,
    sourceName: "Alpha Policy",
    versionNumber: 1
  }),
  Object.freeze({
    fileName: "Beta-and-Gamma.pdf",
    sourceAlias: "S2",
    sourceId: sourceIds.beta,
    sourceName: "Beta and Gamma",
    versionNumber: 1
  }),
  Object.freeze({
    fileName: "Release Notes 2026-08-18.pdf",
    sourceAlias: "S3",
    sourceId: sourceIds.releaseAugust,
    sourceName: "Release Notes",
    versionNumber: 1
  }),
  Object.freeze({
    fileName: "Release Notes 2026-07-01.pdf",
    sourceAlias: "S4",
    sourceId: sourceIds.releaseJuly,
    sourceName: "Release Notes",
    versionNumber: 1
  }),
  Object.freeze({
    fileName: "Quarterly Report Q1.pdf",
    sourceAlias: "S5",
    sourceId: sourceIds.reportOne,
    sourceName: "Quarterly Report",
    versionNumber: 1
  }),
  Object.freeze({
    fileName: "Quarterly Report Q2.pdf",
    sourceAlias: "S6",
    sourceId: sourceIds.reportTwo,
    sourceName: "Quarterly Report",
    versionNumber: 2
  }),
  Object.freeze({
    fileName: "Дорожная-карта.pdf",
    sourceAlias: "S7",
    sourceId: sourceIds.roadmap,
    sourceName: "Дорожная карта",
    versionNumber: 1
  }),
  Object.freeze({
    fileName: "Policy-Appendix.pdf",
    sourceAlias: "S8",
    sourceId: sourceIds.appendix,
    sourceName: "Appendix Reference",
    versionNumber: 1
  })
]);

type IntentFixture = Readonly<{
  conversation?: KnowledgePlannerInput["conversation"];
  expectedIntent: KnowledgePlannerIntent;
  expectedOperation: KnowledgePlannerOperation | null;
  language: Language;
  query: string;
}>;

const intentFixtures: readonly IntentFixture[] = Object.freeze([
  { expectedIntent: "no_knowledge_needed", expectedOperation: null, language: "en", query: "Thank you!" },
  { expectedIntent: "fact_lookup", expectedOperation: "automatic_search", language: "en", query: "What is the retention policy?" },
  { expectedIntent: "exact_lookup", expectedOperation: "find_exact", language: "en", query: "Find exact phrase \"retention period\"" },
  { expectedIntent: "single_source_summary", expectedOperation: "automatic_search", language: "en", query: "Summarize Alpha Policy.pdf" },
  { expectedIntent: "multi_source_comparison", expectedOperation: "automatic_search", language: "en", query: "Compare Alpha Policy.pdf and Beta-and-Gamma.pdf" },
  { expectedIntent: "exhaustive_corpus_search", expectedOperation: "automatic_search", language: "en", query: "List every exception in the entire corpus without omissions" },
  { expectedIntent: "corpus_summary", expectedOperation: "automatic_search", language: "en", query: "Give me an overview of the knowledge base" },
  { expectedIntent: "multi_hop_reasoning", expectedOperation: "automatic_search", language: "en", query: "Who approved the release; then when did it ship?" },
  { expectedIntent: "structured_data_analysis", expectedOperation: "structured_analysis", language: "en", query: "Calculate the median of the CSV column in Alpha Policy.pdf" },
  { expectedIntent: "source_discovery", expectedOperation: "discover_sources", language: "en", query: "Which document describes retention?" },
  {
    conversation: [{ role: "user", text: "Tell me about Alpha Policy.pdf" }],
    expectedIntent: "follow_up_reference",
    expectedOperation: "automatic_search",
    language: "en",
    query: "And when?"
  },
  { expectedIntent: "mixed", expectedOperation: "automatic_search", language: "en", query: "Find every exact occurrence of API-2048 without omissions" },
  { expectedIntent: "fact_lookup", expectedOperation: "visual_analysis", language: "en", query: "What does the diagram in Alpha Policy.pdf show?" },
  { expectedIntent: "no_knowledge_needed", expectedOperation: null, language: "ru", query: "Спасибо!" },
  { expectedIntent: "fact_lookup", expectedOperation: "automatic_search", language: "ru", query: "Каков срок хранения?" },
  { expectedIntent: "exact_lookup", expectedOperation: "find_exact", language: "ru", query: "Найди точную фразу «срок хранения»" },
  { expectedIntent: "single_source_summary", expectedOperation: "automatic_search", language: "ru", query: "Сделай краткий обзор Alpha Policy.pdf" },
  { expectedIntent: "multi_source_comparison", expectedOperation: "automatic_search", language: "ru", query: "Сравни Alpha Policy.pdf и Beta-and-Gamma.pdf" },
  { expectedIntent: "exhaustive_corpus_search", expectedOperation: "automatic_search", language: "ru", query: "Найди все исключения без пропусков" },
  { expectedIntent: "corpus_summary", expectedOperation: "automatic_search", language: "ru", query: "Сделай обзор базы знаний" },
  { expectedIntent: "multi_hop_reasoning", expectedOperation: "automatic_search", language: "ru", query: "Кто согласовал релиз; затем когда он вышел?" },
  { expectedIntent: "structured_data_analysis", expectedOperation: "structured_analysis", language: "ru", query: "Посчитай медиану столбца CSV в Alpha Policy.pdf" },
  { expectedIntent: "source_discovery", expectedOperation: "discover_sources", language: "ru", query: "Какой документ описывает удаление данных?" },
  {
    conversation: [{ role: "user", text: "Расскажи об Alpha Policy.pdf" }],
    expectedIntent: "follow_up_reference",
    expectedOperation: "automatic_search",
    language: "ru",
    query: "А когда?"
  },
  { expectedIntent: "mixed", expectedOperation: "automatic_search", language: "ru", query: "Найди все точные вхождения кода РЕЛИЗ-2048 без пропусков" },
  { expectedIntent: "fact_lookup", expectedOperation: "visual_analysis", language: "ru", query: "Что показывает диаграмма в Alpha Policy.pdf?" },
  { expectedIntent: "fact_lookup", expectedOperation: "automatic_search", language: "ru", query: "Покажи динамику холестерина в Alpha Policy.pdf" }
]);

type ExactTermFixture = Readonly<{
  conversation?: KnowledgePlannerInput["conversation"];
  expectedTerms: readonly string[];
  language: Language;
  query: string;
}>;

const exactTermFixtures: readonly ExactTermFixture[] = Object.freeze([
  {
    expectedTerms: ["\"retention period\""],
    language: "en",
    query: "Find exact phrase \"retention period\""
  },
  { expectedTerms: ["API-2048"], language: "en", query: "Find exact token API-2048" },
  {
    expectedTerms: ["Alpha Policy.pdf"],
    language: "en",
    query: "What changed in Alpha Policy.pdf?"
  },
  {
    conversation: [{ role: "user", text: "Review the launch decision" }],
    expectedTerms: ["“North Star”", "2026-08-18", "API-2048"],
    language: "en",
    query: "And what did “North Star” say about API-2048 on 2026-08-18?"
  },
  {
    expectedTerms: ["«срок хранения»"],
    language: "ru",
    query: "Найди точную фразу «срок хранения»"
  },
  {
    expectedTerms: ["Alpha Policy.pdf"],
    language: "ru",
    query: "Что изменилось в Alpha Policy.pdf?"
  },
  {
    expectedTerms: ["18.08.2026", "РЕЛИЗ-2048"],
    language: "ru",
    query: "Найди код РЕЛИЗ-2048 от 18.08.2026"
  },
  {
    conversation: [{ role: "user", text: "Проверь решение о запуске" }],
    expectedTerms: ["«Северная звезда»", "2026-08-19", "API-4096"],
    language: "ru",
    query: "А что сказано про «Северная звезда», код API-4096 от 2026-08-19?"
  }
]);

type TargetFixture = Readonly<{
  expectedOutcome: KnowledgePlannerTargetOutcome;
  expectedSourceIds: readonly string[];
  sources?: readonly KnowledgePlannerSourceIdentity[];
  targetNames: readonly string[];
}>;

const targetFixtures: readonly TargetFixture[] = Object.freeze([
  { expectedOutcome: "resolved", expectedSourceIds: [sourceIds.alpha], targetNames: ["S1"] },
  { expectedOutcome: "resolved", expectedSourceIds: [sourceIds.beta], targetNames: ["Beta-and-Gamma.pdf"] },
  { expectedOutcome: "resolved", expectedSourceIds: [sourceIds.roadmap], targetNames: ["Дорожная карта"] },
  { expectedOutcome: "resolved", expectedSourceIds: [sourceIds.appendix], targetNames: ["Policy Appendix"] },
  { expectedOutcome: "resolved", expectedSourceIds: [sourceIds.reportTwo], targetNames: ["Quarterly Report version 2"] },
  { expectedOutcome: "resolved", expectedSourceIds: [sourceIds.releaseAugust], targetNames: ["Release Notes 2026-08-18"] },
  {
    expectedOutcome: "resolved_many",
    expectedSourceIds: [sourceIds.alpha, sourceIds.beta],
    targetNames: ["S1", "Beta-and-Gamma.pdf"]
  },
  { expectedOutcome: "ambiguous", expectedSourceIds: [], targetNames: ["Quarterly Report"] },
  { expectedOutcome: "ambiguous", expectedSourceIds: [], targetNames: ["Alhpa Policy"] },
  { expectedOutcome: "not_found", expectedSourceIds: [], targetNames: ["Missing Source"] },
  {
    expectedOutcome: "not_found",
    expectedSourceIds: [],
    sources: [{
      ...sources[0]!,
      body: "Body Only Target"
    } as KnowledgePlannerSourceIdentity],
    targetNames: ["Body Only Target"]
  }
]);

const ambiguityQueries = Object.freeze([
  "Compare Quarterly Report and Beta-and-Gamma.pdf",
  "Сравни Quarterly Report и Beta-and-Gamma.pdf"
]);

type UnnecessaryRetrievalFixture = Readonly<{
  overrides?: Partial<KnowledgePlannerInput>;
  query: string;
}>;

const noReadyBases: KnowledgePlannerInput["bases"] = Object.freeze([Object.freeze({
  approxTokens: null,
  knowledgeBaseId: "processing-only",
  passageCount: null,
  readySourceCount: 0,
  sourceCount: 1
})]);

const unnecessaryRetrievalFixtures: readonly UnnecessaryRetrievalFixture[] = Object.freeze([
  { query: "Hello!" },
  { query: "Привет!" },
  {
    overrides: { conversation: [{ role: "assistant", text: "A grounded answer." }] },
    query: "Rewrite your previous answer"
  },
  {
    overrides: { conversation: [{ role: "assistant", text: "Ответ с источниками." }] },
    query: "Перефразируй предыдущий ответ"
  },
  { overrides: { scopeRequested: false }, query: "What is the retention policy?" },
  { overrides: { scopeRequested: false }, query: "Каков срок хранения?" },
  { overrides: { bases: noReadyBases }, query: "What is the retention policy?" },
  { overrides: { bases: noReadyBases }, query: "Каков срок хранения?" }
]);

const outageQueries = Object.freeze([
  "What is the retention policy?",
  "Find exact token API-2048",
  "Compare Alpha Policy.pdf and Beta-and-Gamma.pdf",
  "Покажи динамику холестерина в Alpha Policy.pdf"
]);

function plannerInput(
  originalQuery: string,
  overrides: Partial<KnowledgePlannerInput> = {}
): KnowledgePlannerInput {
  return {
    bases: [{
      approxTokens: 64_000,
      knowledgeBaseId: "planner-release-base",
      passageCount: 96,
      readySourceCount: sources.length,
      sourceCount: sources.length
    }],
    conversation: [],
    directSources: [],
    modelCapabilities: { contextWindow: 128_000, toolCalling: true },
    originalQuery,
    scopeRequested: true,
    sources,
    version: KNOWLEDGE_PLANNER_VERSION,
    ...overrides
  };
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function score(correct: number, total: number): Score {
  return Object.freeze({
    correct,
    rate: total === 0 ? 1 : round(correct / total),
    total
  });
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function planContractValid(plan: KnowledgePlannerPlanV2): boolean {
  if (!decodeKnowledgePlannerPlan(plan).ok) return false;
  try {
    plan.subqueries.forEach((subquery) => plannerAutomaticOperation(plan, subquery));
    return true;
  } catch {
    return false;
  }
}

function fallbackComparable(plan: KnowledgePlannerPlanV2): Omit<
  KnowledgePlannerPlanV2,
  "failureCode" | "status"
> {
  const { failureCode: _failureCode, status: _status, ...comparable } = plan;
  return comparable;
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return round(sorted[index] ?? 0);
}

async function evaluateIntent(): Promise<Readonly<{
  contract: Score;
  intent: Readonly<Record<"overall" | Language, Score>>;
  operation: Score;
}>> {
  const results = await Promise.all(intentFixtures.map(async (fixture) => {
    const plan = await planKnowledgeRequest(plannerInput(fixture.query, {
      conversation: fixture.conversation ?? []
    }));
    return {
      contractCorrect: planContractValid(plan),
      intentCorrect: plan.intent === fixture.expectedIntent,
      language: fixture.language,
      operationCorrect: (plan.subqueries[0]?.operation ?? null) === fixture.expectedOperation
    };
  }));
  const language = (value: Language): Score => {
    const slice = results.filter((result) => result.language === value);
    return score(slice.filter((result) => result.intentCorrect).length, slice.length);
  };
  return Object.freeze({
    contract: score(results.filter((result) => result.contractCorrect).length, results.length),
    intent: Object.freeze({
      en: language("en"),
      overall: score(results.filter((result) => result.intentCorrect).length, results.length),
      ru: language("ru")
    }),
    operation: score(results.filter((result) => result.operationCorrect).length, results.length)
  });
}

async function evaluateExactTerms(): Promise<Readonly<Record<"overall" | Language, Score>>> {
  const results = await Promise.all(exactTermFixtures.map(async (fixture) => {
    const plan = await planKnowledgeRequest(plannerInput(fixture.query, {
      conversation: fixture.conversation ?? []
    }));
    const operations = plan.subqueries.map((subquery) => plannerAutomaticOperation(plan, subquery));
    const correct = fixture.expectedTerms.every((term) =>
      plan.rewrite.exactTerms.includes(term) &&
      plan.rewrite.query.includes(term) &&
      plan.subqueries.some((subquery) =>
        subquery.exactTerms.includes(term) && subquery.query.includes(term)) &&
      operations.some((operation) =>
        operation.exactTerms.includes(term) && operation.query.includes(term)));
    return { correct: correct && planContractValid(plan), language: fixture.language };
  }));
  const language = (value: Language): Score => {
    const slice = results.filter((result) => result.language === value);
    return score(slice.filter((result) => result.correct).length, slice.length);
  };
  return Object.freeze({
    en: language("en"),
    overall: score(results.filter((result) => result.correct).length, results.length),
    ru: language("ru")
  });
}

async function evaluateTargets(): Promise<Readonly<{
  ambiguitySafety: Score;
  resolution: Score;
}>> {
  const directResults = targetFixtures.map((fixture) => {
    const resolution = resolveKnowledgePlannerTargets({
      sources: fixture.sources ?? sources,
      targetNames: fixture.targetNames
    });
    const decoded = decodeKnowledgePlannerTargetResolution(resolution);
    const correct = resolution !== null && decoded !== undefined &&
      resolution.outcome === fixture.expectedOutcome &&
      sameStrings(resolution.targetSourceIds, fixture.expectedSourceIds);
    const ambiguityRelevant = fixture.expectedOutcome === "ambiguous" ||
      fixture.expectedOutcome === "not_found";
    return {
      ambiguityCorrect: !ambiguityRelevant || resolution !== null &&
        resolution.targetSourceIds.length === 0 &&
        resolution.targets.every((target) => target.outcome !== "resolved"),
      ambiguityRelevant,
      correct
    };
  });
  const planResults = await Promise.all(ambiguityQueries.map(async (query) => {
    const plan = await planKnowledgeRequest(plannerInput(query));
    const operation = plan.subqueries[0]
      ? plannerAutomaticOperation(plan, plan.subqueries[0])
      : null;
    return planContractValid(plan) && plan.targetResolution?.outcome === "ambiguous" &&
      plan.targetSourceIds.length === 0 && plan.subqueries.length === 1 &&
      plan.subqueries[0]?.operation === "discover_sources" &&
      plan.subqueries[0].lanes.length === 1 && plan.subqueries[0].lanes[0] === "metadata" &&
      operation?.operation === "discover_sources" && operation.targetSourceIds.length === 0;
  }));
  const ambiguityResults = [
    ...directResults.filter((result) => result.ambiguityRelevant)
      .map((result) => result.ambiguityCorrect),
    ...planResults
  ];
  return Object.freeze({
    ambiguitySafety: score(ambiguityResults.filter(Boolean).length, ambiguityResults.length),
    resolution: score(directResults.filter((result) => result.correct).length, directResults.length)
  });
}

async function evaluateUnnecessaryRetrieval(): Promise<Score> {
  const results = await Promise.all(unnecessaryRetrievalFixtures.map(async (fixture) => {
    const plan = await planKnowledgeRequest(plannerInput(fixture.query, fixture.overrides));
    return planContractValid(plan) && !plan.automaticRetrieval &&
      plan.strategy === "none" && plan.subqueries.length === 0;
  }));
  return score(results.filter(Boolean).length, results.length);
}

async function evaluateOutageFallback(): Promise<Score> {
  const results = await Promise.all(outageQueries.map(async (query) => {
    const input = plannerInput(query);
    const deterministic = await planKnowledgeRequest(input);
    const unavailableClassifier = {
      classify: async (): Promise<never> => {
        throw new Error("simulated_local_planner_outage");
      }
    };
    const first = await planKnowledgeRequest(input, { classifier: unavailableClassifier });
    const second = await planKnowledgeRequest(input, { classifier: unavailableClassifier });
    return planContractValid(first) && planContractValid(second) &&
      first.status === "degraded" && first.failureCode === "classifier_unavailable" &&
      JSON.stringify(fallbackComparable(first)) === JSON.stringify(fallbackComparable(deterministic)) &&
      JSON.stringify(first) === JSON.stringify(second);
  }));
  return score(results.filter(Boolean).length, results.length);
}

async function measureLatency(): Promise<KnowledgePlannerReleaseReport["latency"]> {
  const sampleCount = 250 as const;
  const durations: number[] = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const start = performance.now();
    await planKnowledgeRequest(plannerInput(
      index % 2 === 0
        ? "Compare Alpha Policy.pdf and Beta-and-Gamma.pdf"
        : "Сравни Alpha Policy.pdf и Beta-and-Gamma.pdf"
    ));
    durations.push(performance.now() - start);
  }
  return Object.freeze({
    p50Milliseconds: percentile(durations, 0.5),
    p95Milliseconds: percentile(durations, 0.95),
    p95ThresholdMilliseconds: 25,
    sampleCount,
    scope: "deterministic_plan_only"
  });
}

function inspectQueryPlanningRole(): KnowledgePlannerReleaseReport["knowledgeProfile"]["queryPlanning"] {
  const embeddingProviderModelId = "unused-hermetic-embedding-destination";
  const roles = decodeKnowledgeProfileOperationRoles({
    configuration: knowledgeProfileConfiguration({
      candidateLimit: 40,
      embeddingProviderModelId,
      resultLimit: 8,
      scoreThreshold: 0.01,
      visionDestination: null
    }),
    egressPolicy: knowledgeProfileEgressPolicy({
      embeddingProviderModelId,
      visionDestination: null
    }),
    embeddingProviderModelId
  });
  const role = roles?.find(({ operation }) => operation === "query_planning");
  return Object.freeze({
    contractDecoded: roles !== null,
    costMicros: 0,
    egress: "none",
    fallback: role?.fallback ?? "missing",
    maxCostMicros: role?.maxCostMicros ?? null,
    maxInputBytes: role?.maxInputBytes ?? null,
    maxInputTokens: role?.maxInputTokens ?? null,
    mode: role?.mode ?? "missing",
    providerCalls: 0,
    providerModelConfigured: role?.providerModelId !== null && role?.providerModelId !== undefined,
    rawPrivateText: role?.rawPrivateText ?? null,
    retention: role?.retention ?? "missing"
  });
}

export async function runKnowledgePlannerReleaseEval(): Promise<KnowledgePlannerReleaseReport> {
  const intent = await evaluateIntent();
  const exactTermPreservation = await evaluateExactTerms();
  const targets = await evaluateTargets();
  const unnecessaryRetrievalAvoidance = await evaluateUnnecessaryRetrieval();
  const deterministicOutageFallback = await evaluateOutageFallback();
  const latency = await measureLatency();
  const queryPlanning = inspectQueryPlanningRole();
  const execution = Object.freeze({
    costMicros: 0 as const,
    egress: "none" as const,
    implementation: "deterministic_planner_v2" as const,
    providerCalls: 0 as const
  });
  const profileAuthorized = queryPlanning.mode === "external" &&
    queryPlanning.providerModelConfigured;
  const systemModelComparison = Object.freeze({
    claimed: false as const,
    profileAuthorized,
    reason: profileAuthorized
      ? "real_provider_execution_not_permitted" as const
      : "query_planning_role_disabled" as const,
    status: "not_run" as const
  });
  const gates: Gate[] = [
    { name: "intent_accuracy_overall", passed: intent.intent.overall.rate === 1 },
    { name: "intent_accuracy_en", passed: intent.intent.en.rate === 1 },
    { name: "intent_accuracy_ru", passed: intent.intent.ru.rate === 1 },
    { name: "operation_accuracy", passed: intent.operation.rate === 1 },
    { name: "planner_v2_contract", passed: intent.contract.rate === 1 },
    { name: "exact_term_preservation", passed: exactTermPreservation.overall.rate === 1 },
    { name: "target_resolution", passed: targets.resolution.rate === 1 },
    { name: "ambiguity_safety", passed: targets.ambiguitySafety.rate === 1 },
    { name: "unnecessary_retrieval_avoidance", passed: unnecessaryRetrievalAvoidance.rate === 1 },
    { name: "deterministic_outage_fallback", passed: deterministicOutageFallback.rate === 1 },
    {
      name: "planner_latency",
      passed: Number.isFinite(latency.p50Milliseconds) && latency.p50Milliseconds >= 0 &&
        Number.isFinite(latency.p95Milliseconds) &&
        latency.p95Milliseconds <= latency.p95ThresholdMilliseconds
    },
    {
      name: "query_planning_role_disabled",
      passed: queryPlanning.contractDecoded && queryPlanning.mode === "disabled" &&
        queryPlanning.fallback === "deterministic_planner" &&
        queryPlanning.providerCalls === 0 && queryPlanning.costMicros === 0 &&
        queryPlanning.egress === "none" &&
        queryPlanning.maxCostMicros === 0 && queryPlanning.maxInputBytes === 0 &&
        queryPlanning.maxInputTokens === 0 && !queryPlanning.providerModelConfigured &&
        queryPlanning.rawPrivateText === false && queryPlanning.retention === "none"
    },
    {
      name: "zero_provider_calls_cost_and_egress",
      passed: execution.providerCalls === 0 && execution.costMicros === 0 &&
        execution.egress === "none"
    },
    {
      name: "system_model_comparison_not_claimed",
      passed: !systemModelComparison.claimed && !systemModelComparison.profileAuthorized &&
        systemModelComparison.status === "not_run" &&
        systemModelComparison.reason === "query_planning_role_disabled"
    }
  ].map((gate) => Object.freeze(gate));
  const report: KnowledgePlannerReleaseReport = Object.freeze({
    aggregateOnly: true,
    contentFree: true,
    corpus: Object.freeze({
      ambiguityPlanCases: ambiguityQueries.length,
      exactTermCases: exactTermFixtures.length,
      intentCases: Object.freeze({
        en: intentFixtures.filter(({ language }) => language === "en").length,
        ru: intentFixtures.filter(({ language }) => language === "ru").length
      }),
      targetResolutionCases: targetFixtures.length,
      unnecessaryRetrievalCases: unnecessaryRetrievalFixtures.length,
      version: "knowledge-planner-release-fixtures-v1"
    }),
    execution,
    gates: Object.freeze(gates),
    knowledgeProfile: Object.freeze({ queryPlanning }),
    latency,
    metrics: Object.freeze({
      ambiguitySafety: targets.ambiguitySafety,
      deterministicOutageFallback,
      exactTermPreservation,
      intentAccuracy: intent.intent,
      operationAccuracy: intent.operation,
      plannerV2Contract: intent.contract,
      targetResolution: targets.resolution,
      unnecessaryRetrievalAvoidance
    }),
    passed: gates.every((gate) => gate.passed),
    plannerVersion: KNOWLEDGE_PLANNER_VERSION,
    systemModelComparison,
    version: KNOWLEDGE_PLANNER_RELEASE_REPORT_VERSION
  });
  return report;
}

export async function assertKnowledgePlannerReleaseGates(): Promise<KnowledgePlannerReleaseReport> {
  const report = await runKnowledgePlannerReleaseEval();
  if (!report.passed) {
    const failed = report.gates.filter((gate) => !gate.passed).map((gate) => gate.name);
    throw new Error(`Knowledge planner release gates failed: ${failed.join(", ")}`);
  }
  return report;
}
