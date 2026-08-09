import { generateMemoryCorpusSplit } from "../shared/generateCorpus";
import type { MemoryCorpusFixture } from "../shared/corpusTypes";
import { MEMORY_COHORT_TEMPLATES } from "../shared/cohorts";

export function loadMemoryTuningCorpus(): readonly MemoryCorpusFixture[] {
  return generateMemoryCorpusSplit({
    family: "tuning-family-v1",
    split: "TUNING",
    templates: MEMORY_COHORT_TEMPLATES
  });
}
