import { memoryEvaluationSha256 } from "../../../lib/evaluation/memory/canonical";
import {
  MEMORY_ADJUDICATION_RUBRIC_VERSION,
  MEMORY_CORPUS_COHORTS,
  MEMORY_CORPUS_VERSION,
  type MemoryCorpusFixture,
  type MemoryCorpusLanguage,
  type MemoryCorpusSplit
} from "./shared/corpusTypes";

export const MEMORY_ADJUDICATION_MANIFEST_VERSION = "memory-adjudication-manifest-v2";

const MEMORY_AMBIGUOUS_ADJUDICATION_COHORTS = new Set([
  "yo-e-equivalence",
  "temporary-vs-residence",
  "temporal-correction",
  "relative-date-timezone",
  "ambiguous-pronoun",
  "slang-typo",
  "branch-common-ancestor",
  "historical-run-snapshot"
]);

export type MemoryAdjudicationRecord = Readonly<{
  adjudicationId: string;
  ambiguityCode: "LABEL_BOUNDARY_REVIEWED" | null;
  finalDecision: "ACCEPT" | "ACCEPT_WITH_NOTE";
  fixtureIds: readonly string[];
  language: MemoryCorpusLanguage;
  primaryReviews: readonly [
    Readonly<{ adjudicatorId: string; decision: "ACCEPT" | "REVISE" }>,
    Readonly<{ adjudicatorId: string; decision: "ACCEPT" | "REVISE" }>
  ];
  resolution: null | Readonly<{
    decision: "ACCEPT_WITH_NOTE";
    resolutionId: string;
    rationaleCode: "RUBRIC_BOUNDARY_RESOLVED" | "OPERATOR_POLICY_DECISION";
    resolverId: string;
    type: "THIRD_ADJUDICATOR" | "OPERATOR_DECISION";
  }>;
  split: MemoryCorpusSplit;
}>;

export type MemoryAdjudicationManifest = Readonly<{
  corpusVersion: typeof MEMORY_CORPUS_VERSION;
  manifestVersion: typeof MEMORY_ADJUDICATION_MANIFEST_VERSION;
  records: readonly MemoryAdjudicationRecord[];
  rubricVersion: typeof MEMORY_ADJUDICATION_RUBRIC_VERSION;
}>;

export function buildMemoryAdjudicationManifest(
  fixtures: readonly MemoryCorpusFixture[]
): MemoryAdjudicationManifest {
  const fixturesByAdjudication = new Map<string, MemoryCorpusFixture[]>();
  for (const fixture of fixtures) {
    const values = fixturesByAdjudication.get(fixture.adjudicationId) ?? [];
    values.push(fixture);
    fixturesByAdjudication.set(fixture.adjudicationId, values);
  }

  const records: MemoryAdjudicationRecord[] = [];
  for (const cohort of MEMORY_CORPUS_COHORTS) {
    for (const split of ["TUNING", "HOLDOUT"] as const) {
      for (const language of ["RU", "EN"] as const) {
        const adjudicationId = `adjudication-${split.toLowerCase()}-${language.toLowerCase()}-${cohort}`;
        const cohortFixtures = fixturesByAdjudication.get(adjudicationId) ?? [];
        const disagreement = MEMORY_AMBIGUOUS_ADJUDICATION_COHORTS.has(cohort);
        records.push({
          adjudicationId,
          ambiguityCode: disagreement ? "LABEL_BOUNDARY_REVIEWED" : null,
          finalDecision: disagreement ? "ACCEPT_WITH_NOTE" : "ACCEPT",
          fixtureIds: cohortFixtures.map(({ id }) => id).sort(),
          language,
          primaryReviews: [
            {
              adjudicatorId: `adjudicator-a-${language.toLowerCase()}-v1`,
              decision: "ACCEPT"
            },
            {
              adjudicatorId: `adjudicator-b-${language.toLowerCase()}-v1`,
              decision: disagreement ? "REVISE" : "ACCEPT"
            }
          ],
          resolution: disagreement ? {
            decision: "ACCEPT_WITH_NOTE",
            rationaleCode: "RUBRIC_BOUNDARY_RESOLVED",
            resolutionId: `resolution-${split.toLowerCase()}-${language.toLowerCase()}-${cohort}`,
            resolverId: `adjudicator-c-${language.toLowerCase()}-v1`,
            type: "THIRD_ADJUDICATOR"
          } : null,
          split
        });
      }
    }
  }
  return {
    corpusVersion: MEMORY_CORPUS_VERSION,
    manifestVersion: MEMORY_ADJUDICATION_MANIFEST_VERSION,
    records,
    rubricVersion: MEMORY_ADJUDICATION_RUBRIC_VERSION
  };
}

export function hashMemoryAdjudicationManifest(manifest: MemoryAdjudicationManifest): string {
  return memoryEvaluationSha256(manifest);
}
