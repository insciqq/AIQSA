import { describe, expect, it } from "vitest";
import { loadMemoryTuningCorpus } from "../../fixtures/memory-evaluation/tuning/corpus";
import {
  buildMemoryRecallReleaseCases,
  stripMemoryEvaluationVariantMarker
} from "../../fixtures/memory-evaluation/recallReleaseCases";

describe("Memory frozen-corpus recall cases", () => {
  it("removes generator-only uniqueness markers before retrieval scoring", () => {
    expect(stripMemoryEvaluationVariantMarker(
      "Только синтетический текст [синтетический пример 17]"
    )).toBe("Только синтетический текст");
    expect(stripMemoryEvaluationVariantMarker(
      "Synthetic text only [synthetic case 17]"
    )).toBe("Synthetic text only");
  });

  it("projects current-user, active-lineage, lifecycle-safe candidates only", () => {
    const cases = buildMemoryRecallReleaseCases(loadMemoryTuningCorpus());
    expect(cases).toHaveLength(824);
    expect(cases.filter(({ language }) => language === "RU")).toHaveLength(412);
    expect(cases.find(({ cohort, language }) =>
      cohort === "forget-rebuild" && language === "RU"
    )?.candidates).toEqual([]);
    expect(cases.find(({ cohort, language }) =>
      cohort === "public-share-stripping" && language === "EN"
    )?.candidates).toEqual([]);
    expect(cases.find(({ cohort, language }) =>
      cohort === "historical-run-snapshot" && language === "RU"
    )?.candidates).toMatchObject([{ kind: "RUN_SNAPSHOT" }]);

    const branch = cases.find(({ cohort, language }) =>
      cohort === "branch-edit-stale-job" && language === "EN"
    );
    expect(branch?.candidates).toHaveLength(2);
    expect(branch?.candidates.every(({ sourceMessageIds }) =>
      sourceMessageIds.every((id) => !branch.forbiddenMessageIds.includes(id))
    )).toBe(true);

    const crossUser = cases.find(({ cohort, language }) =>
      cohort === "cross-user-isolation" && language === "EN"
    );
    expect(crossUser?.candidates).toHaveLength(2);
    expect(crossUser?.candidates.every(({ sourceMessageIds }) =>
      sourceMessageIds.every((id) => !crossUser.forbiddenMessageIds.includes(id))
    )).toBe(true);
  });
});
