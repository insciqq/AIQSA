import { generateMemoryCorpusSplit } from "../shared/generateCorpus";
import {
  MEMORY_CORPUS_VERSION,
  type MemoryCorpusFixture
} from "../shared/corpusTypes";
import { MEMORY_HOLDOUT_COHORT_TEMPLATES } from "./cohorts";

export function loadMemoryHoldoutCorpus(input: {
  expectedCorpusVersion: string;
  purpose: "SCORING_ONLY";
}): readonly MemoryCorpusFixture[] {
  if (
    input.purpose !== "SCORING_ONLY" ||
    input.expectedCorpusVersion !== MEMORY_CORPUS_VERSION
  ) {
    throw new Error("memory_holdout_access_denied");
  }
  return generateMemoryCorpusSplit({
    family: "blind-holdout-family-v2",
    split: "HOLDOUT",
    templates: MEMORY_HOLDOUT_COHORT_TEMPLATES
  });
}
