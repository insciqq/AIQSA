import {
  MEMORY_RETRIEVAL_MINIMUM_VECTOR_SCORE,
  MEMORY_RETRIEVAL_RRF_K,
  fuseMemoryRetrievalCandidates,
  planMemoryRetrieval,
  type MemoryCandidateMetadata,
  type MemoryLaneCandidate,
  type MemoryLaneResult,
  type MemoryRetrievalItemType,
  type MemoryRetrievalLane
} from "../../domain/memory/retrieval";
import type { MemoryEvaluationLanguage } from "./contracts";
import type {
  MemoryModality,
  MemoryScopeType,
  MemorySensitivityClass,
  MemorySourceMode
} from "../../contracts/memory";
import { memoryEvaluationSha256 } from "./canonical";
import {
  MEMORY_PHASE7_ABLATION_STAGES,
  type MemoryPhase7AblationStage,
  type MemoryPhase7BilingualScore,
  type MemoryPhase7LanguageScore
} from "./phase7";

export const MEMORY_PHASE7_ABLATION_EVALUATOR_VERSION =
  "memory-phase7-ablation-evaluator-v3";
export const MEMORY_PHASE7_ABLATION_TOP_K = 5;

export type MemoryPhase7AblationCandidateKind =
  | "EPISODE"
  | "FACT"
  | "HISTORY_CHUNK"
  | "RUN_SNAPSHOT";

export type MemoryPhase7AblationCandidate = Readonly<{
  category: string | null;
  current: boolean;
  explicit: boolean;
  key: string;
  kind: MemoryPhase7AblationCandidateKind;
  language: MemoryEvaluationLanguage;
  modality: MemoryModality | null;
  occurredFrom: string | null;
  occurredTo: string | null;
  scopeTargetId: string | null;
  scopeType: MemoryScopeType | null;
  sensitivity: MemorySensitivityClass | null;
  sourceChatId: string | null;
  sourceFixtureId: string;
  sourceFolderId: string | null;
  sourceMessageIds: readonly string[];
  sourceMode: MemorySourceMode | null;
  text: string;
  validFrom: string | null;
  validTo: string | null;
}>;

export type MemoryPhase7AblationCase = Readonly<{
  candidates: readonly MemoryPhase7AblationCandidate[];
  cohort: string;
  contextChatId: string;
  contextFolderId: string | null;
  criticalCohort: boolean;
  forbiddenMessageIds: readonly string[];
  key: string;
  language: MemoryEvaluationLanguage;
  lexicalTerms: readonly string[];
  queryText: string;
  recallExpected: boolean;
  relevantMessageIds: readonly string[];
  retrievalAllowed: boolean;
  sourceFixtureId: string;
  variant: number;
}>;

const scoringNow = new Date("2026-08-11T12:00:00.000Z");
const temporalCohorts = new Set([
  "expired-plan",
  "historical-run-snapshot",
  "relative-date-timezone",
  "temporal-correction",
  "temporary-vs-residence"
]);
const scopeCohorts = new Set([
  "cross-user-isolation",
  "scoped-project-preference",
  "scope-target-delete-no-global",
  "temporary-zero-memory"
]);

type RankedCandidate = Readonly<{
  candidate: MemoryPhase7AblationCandidate;
  score: number;
}>;

export type MemoryPhase7StageEvaluation = Readonly<{
  cases: number;
  irrelevantInjections: Readonly<Record<MemoryEvaluationLanguage, number>>;
  observations: readonly MemoryPhase7CaseObservation[];
  retrievalContamination: Readonly<Record<MemoryEvaluationLanguage, number>>;
  score: MemoryPhase7BilingualScore;
  selectedCandidates: number;
  stage: MemoryPhase7AblationStage;
}>;

export type MemoryPhase7CaseObservation = Readonly<{
  cohort: string;
  irrelevant: boolean;
  language: MemoryEvaluationLanguage;
  recallAt5: number | null;
  retrievalContaminated: boolean;
  scopeCorrect: boolean | null;
  temporalCorrect: boolean | null;
}>;

function pairKey(caseKey: string, candidateKey: string): string {
  return `${caseKey}\u0000${candidateKey}`;
}

function validVector(vector: readonly number[] | undefined): vector is readonly number[] {
  return Boolean(vector && vector.length > 0 && vector.every(Number.isFinite));
}

function cosine(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) {
    throw new Error("memory_phase7_ablation_vector_dimension_mismatch");
  }
  let value = 0;
  for (let index = 0; index < left.length; index += 1) {
    value += left[index]! * right[index]!;
  }
  return value;
}

function kindsForStage(
  stage: MemoryPhase7AblationStage
): ReadonlySet<MemoryPhase7AblationCandidateKind> {
  if (stage === "ACTIVE_BRANCH") return new Set();
  if (stage === "EXACT_CHUNK_FTS" || stage === "MULTILINGUAL_VECTOR_CHUNKS") {
    return new Set(["HISTORY_CHUNK"]);
  }
  if (stage === "EPISODES") return new Set(["EPISODE", "HISTORY_CHUNK"]);
  if (
    stage === "SEMANTIC_FACTS" || stage === "HYBRID_RRF" ||
    stage === "TEMPORAL_SCOPE_TEMPERATURE" ||
    stage === "MULTILINGUAL_RERANKER"
  ) return new Set(["EPISODE", "FACT", "HISTORY_CHUNK"]);
  return new Set(["EPISODE", "FACT", "HISTORY_CHUNK", "RUN_SNAPSHOT"]);
}

function usesVector(stage: MemoryPhase7AblationStage): boolean {
  return MEMORY_PHASE7_ABLATION_STAGES.indexOf(stage) >=
    MEMORY_PHASE7_ABLATION_STAGES.indexOf("MULTILINGUAL_VECTOR_CHUNKS");
}

function usesRrf(stage: MemoryPhase7AblationStage): boolean {
  return MEMORY_PHASE7_ABLATION_STAGES.indexOf(stage) >=
    MEMORY_PHASE7_ABLATION_STAGES.indexOf("HYBRID_RRF");
}

function usesProductionFeatures(stage: MemoryPhase7AblationStage): boolean {
  return MEMORY_PHASE7_ABLATION_STAGES.indexOf(stage) >=
    MEMORY_PHASE7_ABLATION_STAGES.indexOf("TEMPORAL_SCOPE_TEMPERATURE");
}

function scopeEligible(
  current: MemoryPhase7AblationCase,
  candidate: MemoryPhase7AblationCandidate
): boolean {
  if (candidate.kind !== "FACT" || candidate.scopeType === null) return true;
  if (candidate.scopeType === "GLOBAL_USER") return true;
  if (candidate.scopeType === "FOLDER") {
    return current.contextFolderId !== null &&
      candidate.scopeTargetId === current.contextFolderId;
  }
  if (candidate.scopeType === "CHAT") {
    return candidate.scopeTargetId === current.contextChatId;
  }
  return false;
}

function candidatesForStage(
  current: MemoryPhase7AblationCase,
  stage: MemoryPhase7AblationStage
): readonly MemoryPhase7AblationCandidate[] {
  const kinds = kindsForStage(stage);
  return current.candidates.filter((candidate) =>
    kinds.has(candidate.kind) &&
    (!usesProductionFeatures(stage) || scopeEligible(current, candidate))
  );
}

function dedupeKey(candidate: MemoryPhase7AblationCandidate): string {
  return memoryEvaluationSha256({
    sourceFixtureId: candidate.sourceFixtureId,
    sourceMessageIds: [...candidate.sourceMessageIds].sort()
  });
}

function dedupeRanked(values: readonly RankedCandidate[]): readonly RankedCandidate[] {
  const seen = new Set<string>();
  return values.filter(({ candidate }) => {
    const key = dedupeKey(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function directRank(input: Readonly<{
  candidates: readonly MemoryPhase7AblationCandidate[];
  caseKey: string;
  documentVectors: ReadonlyMap<string, readonly number[]>;
  lexicalScores: ReadonlyMap<string, number>;
  minimumVectorScore: number;
  queryVector: readonly number[];
  stage: MemoryPhase7AblationStage;
}>): readonly RankedCandidate[] {
  const vectorEnabled = usesVector(input.stage);
  const values = input.candidates.flatMap((candidate) => {
    const lexicalScore = input.lexicalScores.get(pairKey(input.caseKey, candidate.key)) ?? 0;
    const documentVector = input.documentVectors.get(candidate.text);
    if (!validVector(documentVector)) {
      throw new Error("memory_phase7_ablation_document_vector_missing");
    }
    const vectorScore = cosine(input.queryVector, documentVector);
    const lexicalMatched = lexicalScore > 0;
    const vectorMatched = vectorEnabled && vectorScore >= input.minimumVectorScore;
    if (!lexicalMatched && !vectorMatched) return [];
    return [{
      candidate,
      score: Math.max(vectorMatched ? vectorScore : -1, lexicalMatched ? 1 + lexicalScore : -1)
    }];
  }).sort((left, right) =>
    right.score - left.score || left.candidate.key.localeCompare(right.candidate.key)
  );
  return dedupeRanked(values).slice(0, MEMORY_PHASE7_ABLATION_TOP_K);
}

function rrfRank(input: Readonly<{
  candidates: readonly MemoryPhase7AblationCandidate[];
  caseKey: string;
  documentVectors: ReadonlyMap<string, readonly number[]>;
  lexicalScores: ReadonlyMap<string, number>;
  minimumVectorScore: number;
  queryVector: readonly number[];
}>): readonly RankedCandidate[] {
  const lexical = input.candidates.map((candidate) => ({
    candidate,
    score: input.lexicalScores.get(pairKey(input.caseKey, candidate.key)) ?? 0
  })).filter(({ score }) => score > 0).sort((left, right) =>
    right.score - left.score || left.candidate.key.localeCompare(right.candidate.key)
  );
  const vector = input.candidates.map((candidate) => {
    const documentVector = input.documentVectors.get(candidate.text);
    if (!validVector(documentVector)) {
      throw new Error("memory_phase7_ablation_document_vector_missing");
    }
    return { candidate, score: cosine(input.queryVector, documentVector) };
  }).filter(({ score }) => score >= input.minimumVectorScore).sort((left, right) =>
    right.score - left.score || left.candidate.key.localeCompare(right.candidate.key)
  );
  const scores = new Map<string, RankedCandidate>();
  for (const values of [lexical, vector]) {
    values.forEach(({ candidate }, index) => {
      const previous = scores.get(candidate.key);
      scores.set(candidate.key, {
        candidate,
        score: (previous?.score ?? 0) + 1 / (MEMORY_RETRIEVAL_RRF_K + index + 1)
      });
    });
  }
  return dedupeRanked([...scores.values()].sort((left, right) =>
    right.score - left.score || left.candidate.key.localeCompare(right.candidate.key)
  )).slice(0, MEMORY_PHASE7_ABLATION_TOP_K);
}

function itemType(candidate: MemoryPhase7AblationCandidate): MemoryRetrievalItemType {
  if (candidate.kind === "FACT") return "FACT_VERSION";
  // Historical phase-7 episode fixtures are evaluated as their source-history
  // representation; production no longer serves extractive episode objects.
  return "RECALL_CHUNK";
}

function date(value: string | null): Date | null {
  if (value === null) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("memory_phase7_ablation_date_invalid");
  }
  return parsed;
}

function metadata(
  current: MemoryPhase7AblationCase,
  candidate: MemoryPhase7AblationCandidate
): MemoryCandidateMetadata {
  const scopeAffinity = candidate.kind === "FACT"
    ? candidate.scopeType === "CHAT"
      ? 1
      : candidate.scopeType === "ASSISTANT"
        ? 0.9
        : candidate.scopeType === "FOLDER" ? 0.8 : 0.7
    : candidate.sourceChatId === current.contextChatId
      ? 1
      : candidate.sourceFolderId !== null &&
          candidate.sourceFolderId === current.contextFolderId
        ? 0.8
        : 0.5;
  return {
    canonicalKey: null,
    category: candidate.category,
    confidence: 1,
    conflict: false,
    coreEligible: false,
    coreSalience: "NONE",
    current: candidate.current,
    dedupeKey: dedupeKey(candidate),
    directness: "DIRECT",
    factId: candidate.kind === "FACT" ? candidate.key : null,
    historical: !candidate.current,
    historySafetyClass: candidate.kind === "FACT" ? null : "NORMAL",
    importance: candidate.kind === "FACT" ? 0.8 : 0.5,
    languageCode: candidate.language.toLocaleLowerCase("und"),
    modality: candidate.modality,
    occurredFrom: date(candidate.occurredFrom),
    occurredTo: date(candidate.occurredTo),
    pinned: candidate.explicit,
    scopeAffinity,
    scopeType: candidate.scopeType,
    sensitivityClass: candidate.sensitivity,
    sourceAssistantId: null,
    sourceChatId: candidate.sourceChatId,
    sourceFolderId: candidate.sourceFolderId,
    sourceMode: candidate.sourceMode,
    systemFrom: date(candidate.occurredFrom),
    temperatureClass: candidate.kind === "FACT"
      ? "HOT"
      : candidate.kind === "RUN_SNAPSHOT" ? "COLD" : "WARM",
    validFrom: date(candidate.validFrom),
    validTo: date(candidate.validTo)
  };
}

function lexicalLane(
  candidate: MemoryPhase7AblationCandidate
): MemoryRetrievalLane {
  return candidate.kind === "FACT" ? "FACT_FTS_SIMPLE" : "HISTORY_RECALL_FTS_SIMPLE";
}

function vectorLane(
  candidate: MemoryPhase7AblationCandidate
): MemoryRetrievalLane {
  if (candidate.kind === "FACT") return "FACT_VECTOR";
  return "HISTORY_RECALL_VECTOR";
}

function productionRank(input: Readonly<{
  candidates: readonly MemoryPhase7AblationCandidate[];
  current: MemoryPhase7AblationCase;
  documentVectors: ReadonlyMap<string, readonly number[]>;
  lexicalScores: ReadonlyMap<string, number>;
  minimumVectorScore: number;
  queryVector: readonly number[];
}>): readonly RankedCandidate[] {
  const lanes = new Map<MemoryRetrievalLane, MemoryLaneCandidate[]>();
  function add(candidate: MemoryPhase7AblationCandidate, lane: MemoryRetrievalLane, rawScore: number) {
    const values = lanes.get(lane) ?? [];
    values.push({
      entryId: candidate.key,
      hardFilterPassed: true,
      itemId: candidate.key,
      itemType: itemType(candidate),
      lane,
      metadata: metadata(input.current, candidate),
      rawScore
    });
    lanes.set(lane, values);
  }
  for (const candidate of input.candidates) {
    const lexical = input.lexicalScores.get(pairKey(input.current.key, candidate.key)) ?? 0;
    if (lexical > 0) add(candidate, lexicalLane(candidate), lexical);
    const documentVector = input.documentVectors.get(candidate.text);
    if (!validVector(documentVector)) {
      throw new Error("memory_phase7_ablation_document_vector_missing");
    }
    const vector = cosine(input.queryVector, documentVector);
    if (vector >= input.minimumVectorScore) add(candidate, vectorLane(candidate), vector);
  }
  const results: MemoryLaneResult[] = [...lanes.entries()].map(([lane, candidates]) => ({
    candidates: candidates.sort((left, right) =>
      right.rawScore - left.rawScore || left.itemId.localeCompare(right.itemId)
    ),
    lane
  }));
  const plan = planMemoryRetrieval({ currentUserText: input.current.queryText, now: scoringNow });
  if (plan.queryPresent !== input.current.retrievalAllowed) {
    throw new Error("memory_phase7_ablation_planner_drift");
  }
  const byKey = new Map(input.candidates.map((candidate) => [candidate.key, candidate]));
  return fuseMemoryRetrievalCandidates(plan, results, scoringNow)
    .slice(0, MEMORY_PHASE7_ABLATION_TOP_K)
    .map((ranked) => {
      const candidate = byKey.get(ranked.itemId);
      if (!candidate) throw new Error("memory_phase7_ablation_candidate_missing");
      return { candidate, score: ranked.finalScore };
    });
}

function select(input: Readonly<{
  current: MemoryPhase7AblationCase;
  documentVectors: ReadonlyMap<string, readonly number[]>;
  lexicalScores: ReadonlyMap<string, number>;
  minimumVectorScore: number;
  queryVectors: ReadonlyMap<string, readonly number[]>;
  stage: MemoryPhase7AblationStage;
}>): readonly RankedCandidate[] {
  if (input.stage === "ACTIVE_BRANCH" || !input.current.retrievalAllowed) return [];
  const queryVector = input.queryVectors.get(input.current.queryText);
  if (!validVector(queryVector)) {
    throw new Error("memory_phase7_ablation_query_vector_missing");
  }
  const candidates = candidatesForStage(input.current, input.stage);
  if (usesProductionFeatures(input.stage)) {
    return productionRank({ ...input, candidates, queryVector });
  }
  if (usesRrf(input.stage)) {
    return rrfRank({ ...input, candidates, caseKey: input.current.key, queryVector });
  }
  return directRank({ ...input, candidates, caseKey: input.current.key, queryVector });
}

function wilsonUpper95(positive: number, total: number): number {
  if (total < 1) return 1;
  const z = 1.959963984540054;
  const proportion = positive / total;
  const denominator = 1 + z * z / total;
  const center = proportion + z * z / (2 * total);
  const margin = z * Math.sqrt(
    proportion * (1 - proportion) / total + z * z / (4 * total * total)
  );
  return Math.min(1, (center + margin) / denominator);
}

type LanguageAccumulator = {
  cases: number;
  cohortRecall: Map<string, number[]>;
  hardInvariantFailures: number;
  injections: number;
  recall: number[];
  retrievalContamination: number;
  scope: boolean[];
  temporal: boolean[];
};

function emptyAccumulator(): LanguageAccumulator {
  return {
    cases: 0,
    cohortRecall: new Map(),
    hardInvariantFailures: 0,
    injections: 0,
    recall: [],
    retrievalContamination: 0,
    scope: [],
    temporal: []
  };
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) /
    values.length;
}

function languageScore(value: LanguageAccumulator): MemoryPhase7LanguageScore {
  return {
    criticalRecallAt5: Object.fromEntries([...value.cohortRecall.entries()]
      .map(([cohort, scores]) => [cohort, average(scores)])),
    hardInvariantFailures: value.hardInvariantFailures,
    irrelevantInjectionRate: value.cases === 0 ? 1 : value.injections / value.cases,
    irrelevantInjectionUpper95: wilsonUpper95(value.injections, value.cases),
    recallAt5: average(value.recall),
    scopeAccuracy: value.scope.length === 0
      ? 0
      : value.scope.filter(Boolean).length / value.scope.length,
    temporalAccuracy: value.temporal.length === 0
      ? 0
      : value.temporal.filter(Boolean).length / value.temporal.length
  };
}

export function memoryPhase7AblationEmbeddingTexts(
  cases: readonly MemoryPhase7AblationCase[]
): Readonly<{ documents: readonly string[]; queries: readonly string[] }> {
  return {
    documents: [...new Set(cases.flatMap(({ candidates }) =>
      candidates.map(({ text }) => text)
    ))].sort(),
    queries: [...new Set(cases.map(({ queryText }) => queryText))].sort()
  };
}

export function evaluateMemoryPhase7AblationStage(input: Readonly<{
  cases: readonly MemoryPhase7AblationCase[];
  documentVectors: ReadonlyMap<string, readonly number[]>;
  lexicalScores: ReadonlyMap<string, number>;
  minimumVectorScore?: number;
  queryVectors: ReadonlyMap<string, readonly number[]>;
  stage: MemoryPhase7AblationStage;
}>): MemoryPhase7StageEvaluation {
  if (input.cases.length === 0 || !MEMORY_PHASE7_ABLATION_STAGES.includes(input.stage)) {
    throw new Error("memory_phase7_ablation_input_invalid");
  }
  const threshold = input.minimumVectorScore ?? MEMORY_RETRIEVAL_MINIMUM_VECTOR_SCORE;
  if (!Number.isFinite(threshold) || threshold < -1 || threshold > 1) {
    throw new Error("memory_phase7_ablation_input_invalid");
  }
  const accumulators: Record<MemoryEvaluationLanguage, LanguageAccumulator> = {
    EN: emptyAccumulator(),
    RU: emptyAccumulator()
  };
  const observations: MemoryPhase7CaseObservation[] = [];
  let selectedCandidates = 0;
  for (const current of input.cases) {
    const accumulator = accumulators[current.language];
    accumulator.cases += 1;
    const ranked = select({
      current,
      documentVectors: input.documentVectors,
      lexicalScores: input.lexicalScores,
      minimumVectorScore: threshold,
      queryVectors: input.queryVectors,
      stage: input.stage
    });
    selectedCandidates += ranked.length;
    const relevant = new Set(current.relevantMessageIds);
    const forbidden = new Set(current.forbiddenMessageIds);
    const selectedRelevant = new Set<string>();
    let forbiddenSelected = false;
    let retrievalContaminated = false;
    for (const { candidate } of ranked) {
      const overlapsRelevant = candidate.sourceMessageIds.some((id) => relevant.has(id));
      const overlapsForbidden = candidate.sourceMessageIds.some((id) => forbidden.has(id));
      if (!overlapsRelevant || overlapsForbidden) retrievalContaminated = true;
      if (overlapsForbidden) forbiddenSelected = true;
      for (const id of candidate.sourceMessageIds) {
        if (relevant.has(id) && !forbidden.has(id)) selectedRelevant.add(id);
      }
    }
    if (forbiddenSelected) accumulator.injections += 1;
    if (retrievalContaminated) accumulator.retrievalContamination += 1;
    if (forbiddenSelected) accumulator.hardInvariantFailures += 1;
    const recall = current.recallExpected && relevant.size > 0
      ? selectedRelevant.size / relevant.size
      : null;
    if (recall !== null) {
      accumulator.recall.push(recall);
      if (current.criticalCohort) {
        const values = accumulator.cohortRecall.get(current.cohort) ?? [];
        values.push(recall);
        accumulator.cohortRecall.set(current.cohort, values);
      }
    }
    const topCandidate = ranked[0]?.candidate;
    const topRelevant = Boolean(topCandidate?.sourceMessageIds.some((id) =>
      relevant.has(id) && !forbidden.has(id)
    ));
    const correct = current.recallExpected
      ? topRelevant && !forbiddenSelected
      : !forbiddenSelected;
    const scopeCorrect = scopeCohorts.has(current.cohort) ? correct : null;
    const temporalCorrect = temporalCohorts.has(current.cohort) ? correct : null;
    if (scopeCorrect !== null) accumulator.scope.push(scopeCorrect);
    if (temporalCorrect !== null) accumulator.temporal.push(temporalCorrect);
    observations.push({
      cohort: current.cohort,
      irrelevant: forbiddenSelected,
      language: current.language,
      recallAt5: recall,
      retrievalContaminated,
      scopeCorrect,
      temporalCorrect
    });
  }
  return {
    cases: input.cases.length,
    irrelevantInjections: {
      EN: accumulators.EN.injections,
      RU: accumulators.RU.injections
    },
    observations,
    retrievalContamination: {
      EN: accumulators.EN.retrievalContamination,
      RU: accumulators.RU.retrievalContamination
    },
    score: {
      EN: languageScore(accumulators.EN),
      RU: languageScore(accumulators.RU)
    },
    selectedCandidates,
    stage: input.stage
  };
}

export function memoryPhase7AblationPairKey(caseKey: string, candidateKey: string): string {
  return pairKey(caseKey, candidateKey);
}
