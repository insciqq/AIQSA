import type {
  MemoryBinaryOutcome,
  MemoryEvaluationLanguage,
  MemoryRankedOutcome
} from "./contracts";

export const MEMORY_RECALL_RELEASE_EVALUATOR_VERSION =
  "memory-recall-release-evaluator-v2";
export const MEMORY_RECALL_RELEASE_EVIDENCE_VERSION =
  "memory-recall-release-quality-evidence-v2";

export type MemoryRecallReleaseCandidate = Readonly<{
  key: string;
  kind: "FACT" | "HISTORY_CHUNK" | "RUN_SNAPSHOT";
  sourceMessageIds: readonly string[];
  text: string;
}>;

export type MemoryRecallReleaseCase = Readonly<{
  candidates: readonly MemoryRecallReleaseCandidate[];
  cohort: string;
  criticalCohort: boolean;
  forbiddenMessageIds: readonly string[];
  key: string;
  language: MemoryEvaluationLanguage;
  lexicalTerms: readonly string[];
  queryText: string;
  recallExpected: boolean;
  relevantMessageIds: readonly string[];
  retrievalAllowed: boolean;
}>;

export type MemoryRecallReleaseEvaluation = Readonly<{
  binary: readonly Readonly<{
    language: MemoryEvaluationLanguage;
    outcome: MemoryBinaryOutcome;
  }>[];
  ranked: readonly Readonly<{
    language: MemoryEvaluationLanguage;
    outcome: MemoryRankedOutcome;
  }>[];
  summary: Readonly<{
    cases: number;
    candidateKindsSelected: Readonly<Record<MemoryRecallReleaseCandidate["kind"], number>>;
    irrelevantInjections: Readonly<Record<MemoryEvaluationLanguage, number>>;
    selectionModes: Readonly<Record<"HYBRID" | "LEXICAL_ONLY" | "VECTOR_ONLY", number>>;
    queriesAdmitted: Readonly<Record<MemoryEvaluationLanguage, number>>;
    recallQueries: Readonly<Record<MemoryEvaluationLanguage, number>>;
  }>;
}>;

function validVector(vector: readonly number[] | undefined): vector is readonly number[] {
  return Boolean(vector && vector.length > 0 && vector.every(Number.isFinite));
}

function cosine(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) throw new Error("memory_recall_vector_dimension_mismatch");
  let result = 0;
  for (let index = 0; index < left.length; index += 1) {
    result += left[index]! * right[index]!;
  }
  return result;
}

export function memoryRecallReleaseEmbeddingTexts(
  cases: readonly MemoryRecallReleaseCase[]
): Readonly<{ documents: readonly string[]; queries: readonly string[] }> {
  return {
    documents: [...new Set(cases.flatMap(({ candidates }) =>
      candidates.map(({ text }) => text)
    ))].sort(),
    queries: [...new Set(cases.map(({ queryText }) => queryText))].sort()
  };
}

export function memoryRecallReleasePairKey(caseKey: string, candidateKey: string): string {
  return `${caseKey}\u0000${candidateKey}`;
}

export function evaluateMemoryRecallRelease(input: Readonly<{
  cases: readonly MemoryRecallReleaseCase[];
  documentVectors: ReadonlyMap<string, readonly number[]>;
  lexicalScores: ReadonlyMap<string, number>;
  minimumVectorScore: number;
  queryVectors: ReadonlyMap<string, readonly number[]>;
  topK: 5;
}>): MemoryRecallReleaseEvaluation {
  if (
    input.cases.length === 0 ||
    !Number.isFinite(input.minimumVectorScore) ||
    input.minimumVectorScore < -1 ||
    input.minimumVectorScore > 1 ||
    input.topK !== 5
  ) {
    throw new Error("memory_recall_release_input_invalid");
  }
  const binary: Array<{
    language: MemoryEvaluationLanguage;
    outcome: MemoryBinaryOutcome;
  }> = [];
  const ranked: Array<{
    language: MemoryEvaluationLanguage;
    outcome: MemoryRankedOutcome;
  }> = [];
  const candidateKindsSelected: Record<MemoryRecallReleaseCandidate["kind"], number> = {
    FACT: 0,
    HISTORY_CHUNK: 0,
    RUN_SNAPSHOT: 0
  };
  const irrelevantInjections: Record<MemoryEvaluationLanguage, number> = { EN: 0, RU: 0 };
  const selectionModes = { HYBRID: 0, LEXICAL_ONLY: 0, VECTOR_ONLY: 0 };
  const queriesAdmitted: Record<MemoryEvaluationLanguage, number> = { EN: 0, RU: 0 };
  const recallQueries: Record<MemoryEvaluationLanguage, number> = { EN: 0, RU: 0 };

  for (const current of input.cases) {
    const queryVector = input.queryVectors.get(current.queryText);
    if (!validVector(queryVector)) throw new Error("memory_recall_query_vector_missing");
    if (current.retrievalAllowed) queriesAdmitted[current.language] += 1;
    const selected = current.retrievalAllowed
      ? current.candidates.map((candidate) => {
          const documentVector = input.documentVectors.get(candidate.text);
          if (!validVector(documentVector)) {
            throw new Error("memory_recall_document_vector_missing");
          }
          const vectorScore = cosine(queryVector, documentVector);
          const lexicalScore = input.lexicalScores.get(memoryRecallReleasePairKey(
            current.key,
            candidate.key
          )) ?? 0;
          const lexicalMatched = lexicalScore > 0;
          const vectorMatched = vectorScore >= input.minimumVectorScore;
          return {
            candidate,
            lexicalMatched,
            score: Math.max(vectorScore, lexicalMatched ? 1 + lexicalScore : -1),
            vectorMatched
          };
        }).filter(({ lexicalMatched, vectorMatched }) => lexicalMatched || vectorMatched)
          .sort((left, right) =>
            right.score - left.score || left.candidate.key.localeCompare(right.candidate.key)
          )
          .slice(0, input.topK)
      : [];
    for (const { candidate, lexicalMatched, vectorMatched } of selected) {
      candidateKindsSelected[candidate.kind] += 1;
      selectionModes[lexicalMatched && vectorMatched
        ? "HYBRID"
        : lexicalMatched ? "LEXICAL_ONLY" : "VECTOR_ONLY"] += 1;
    }

    const relevant = new Set(current.relevantMessageIds);
    const forbidden = new Set(current.forbiddenMessageIds);
    const selectedRelevant = new Set<string>();
    let irrelevant = false;
    for (const { candidate } of selected) {
      const overlapsRelevant = candidate.sourceMessageIds.some((id) => relevant.has(id));
      const overlapsForbidden = candidate.sourceMessageIds.some((id) => forbidden.has(id));
      if (!overlapsRelevant || overlapsForbidden) irrelevant = true;
      for (const id of candidate.sourceMessageIds) {
        if (relevant.has(id) && !forbidden.has(id)) selectedRelevant.add(id);
      }
    }
    if (irrelevant) irrelevantInjections[current.language] += 1;
    binary.push({
      language: current.language,
      outcome: {
        cohort: "overall",
        metric: "IRRELEVANT_AUTOMATIC_INJECTION_RATE",
        positive: irrelevant
      }
    });

    if (current.recallExpected) {
      if (relevant.size === 0) throw new Error("memory_recall_release_judgment_invalid");
      recallQueries[current.language] += 1;
      const score = selectedRelevant.size / relevant.size;
      ranked.push({
        language: current.language,
        outcome: {
          cohort: "overall",
          metric: "CURATED_RECALL_AT_5",
          score,
          stratum: current.cohort
        }
      });
      if (current.criticalCohort) {
        ranked.push({
          language: current.language,
          outcome: {
            cohort: current.cohort,
            metric: "CURATED_RECALL_AT_5",
            score,
            stratum: current.cohort
          }
        });
      }
    }

    const relevantKinds = new Set(selected.filter(({ candidate }) =>
      candidate.sourceMessageIds.some((id) => relevant.has(id))
    ).map(({ candidate }) => candidate.kind));
    ranked.push({
      language: current.language,
      outcome: {
        cohort: "overall",
        metric: "SOURCE_DIVERSITY",
        score: Math.min(1, relevantKinds.size / 3),
        stratum: current.cohort
      }
    });
  }

  return {
    binary,
    ranked,
    summary: {
      candidateKindsSelected,
      cases: input.cases.length,
      irrelevantInjections,
      queriesAdmitted,
      recallQueries,
      selectionModes
    }
  };
}
