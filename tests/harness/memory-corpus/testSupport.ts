import { readFileSync } from "node:fs";
import path from "node:path";
import type { MemoryCorpusManifest } from "../../fixtures/memory-evaluation/manifestBuilders";
import { loadMemoryHoldoutCorpus } from "../../fixtures/memory-evaluation/holdout/corpus";
import {
  MEMORY_CORPUS_VERSION,
  type MemoryCorpusFixture
} from "../../fixtures/memory-evaluation/shared/corpusTypes";
import { loadMemoryTuningCorpus } from "../../fixtures/memory-evaluation/tuning/corpus";

export const memoryCorpusRoot = path.resolve(
  process.cwd(),
  "tests/fixtures/memory-evaluation"
);

export function readMemoryCorpusJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(path.join(memoryCorpusRoot, relativePath), "utf8")) as T;
}

export function loadFrozenMemoryCorpus(): Readonly<{
  fixtures: readonly MemoryCorpusFixture[];
  holdout: readonly MemoryCorpusFixture[];
  manifest: MemoryCorpusManifest;
  tuning: readonly MemoryCorpusFixture[];
}> {
  const tuning = loadMemoryTuningCorpus();
  const holdout = loadMemoryHoldoutCorpus({
    expectedCorpusVersion: MEMORY_CORPUS_VERSION,
    purpose: "SCORING_ONLY"
  });
  return {
    fixtures: [...tuning, ...holdout],
    holdout,
    manifest: readMemoryCorpusJson<MemoryCorpusManifest>("manifests/corpus-v1.json"),
    tuning
  };
}
