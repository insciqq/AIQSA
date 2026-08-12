import { describe, expect, it } from "vitest";
import {
  buildMemoryPhase7AblationCases,
  memoryPhase7VariantForFixtureId
} from "../../fixtures/memory-evaluation/phase7AblationCases";
import { loadMemoryTuningCorpus } from
  "../../fixtures/memory-evaluation/tuning/corpus";

describe("Phase 7 discriminating ablation cases", () => {
  it("derives the frozen variant from tuning and four-digit holdout fixture ids", () => {
    expect(memoryPhase7VariantForFixtureId("fixture-tuning-ru-cohort-01")).toBe(1);
    expect(memoryPhase7VariantForFixtureId("fixture-holdout-ru-cohort-1001")).toBe(1);
    expect(memoryPhase7VariantForFixtureId("fixture-holdout-en-cohort-1020")).toBe(20);
  });

  it("builds same-language, same-variant distractor pools without foreign-user sources", () => {
    const fixtures = loadMemoryTuningCorpus();
    const cases = buildMemoryPhase7AblationCases(fixtures);
    expect(cases).toHaveLength(fixtures.length);
    const current = cases.find(({ cohort, language, variant }) =>
      cohort === "cross-user-isolation" && language === "RU" && variant === 1
    );
    expect(current).toBeDefined();
    expect(current!.candidates.length).toBeGreaterThan(20);
    expect(current!.candidates.every(({ language, sourceFixtureId }) =>
      language === "RU" && sourceFixtureId.endsWith("-01")
    )).toBe(true);
    expect(current!.candidates.flatMap(({ sourceMessageIds }) => sourceMessageIds)
      .some((id) => id.endsWith("-other-user"))).toBe(false);
  });

  it("adds only source-grounded episode proxies and retains exact fact scope metadata", () => {
    const cases = buildMemoryPhase7AblationCases(loadMemoryTuningCorpus());
    const current = cases.find(({ cohort, language, variant }) =>
      cohort === "scoped-project-preference" && language === "EN" && variant === 1
    );
    expect(current).toBeDefined();
    const relevant = new Set(current!.relevantMessageIds);
    const fact = current!.candidates.find(({ kind, sourceMessageIds }) =>
      kind === "FACT" && sourceMessageIds.some((id) => relevant.has(id))
    );
    expect(fact).toMatchObject({ scopeType: "FOLDER" });
    expect(fact?.scopeTargetId).toBe(current!.contextFolderId);
    const history = current!.candidates.find(({ kind, sourceFixtureId }) =>
      kind === "HISTORY_CHUNK" && sourceFixtureId === current!.sourceFixtureId
    );
    const episode = current!.candidates.find(({ kind, sourceFixtureId }) =>
      kind === "EPISODE" && sourceFixtureId === current!.sourceFixtureId
    );
    expect(episode).toMatchObject({
      sourceMessageIds: history?.sourceMessageIds,
      text: history?.text
    });
  });
});
