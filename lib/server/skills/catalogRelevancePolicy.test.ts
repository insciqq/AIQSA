import { describe, expect, it } from "vitest";
import { buildSkillCatalogRelevancePlan, skillCatalogRelevanceSelection } from "./catalogRelevancePolicy";

const candidates = Array.from({ length: 33 }, (_, index) => ({ skillId: `private-skill-${index}`, revisionId: `private-revision-${index}`,
  name: `Skill ${index}`, description: `A useful procedure for task ${index}.`, fileCount: 3, hasExecutables: true,
  instructions: "PRIVATE_INSTRUCTIONS_NEVER_DISCLOSE", files: [{ path: "private-file-name", text: "PRIVATE_FILE_BYTES" }] }));
const input = { candidates, query: "Help with task 2." };
const plan = () => buildSkillCatalogRelevancePlan(input)!;
const answers = () => Object.fromEntries(candidates.map((_skill, index) => [`s${index}`, { type: "noul", noul: 0 }]));

describe("Skill catalog relevance cohort", () => {
  it("discloses only the complete user query, names and descriptions with opaque cohort keys", () => {
    const request = plan().request;
    expect(Object.keys(request.questions)).toHaveLength(33);
    expect(request.state).toEqual({ query: input.query, skills: candidates.map((skill, index) => ({ key: `s${index}`, name: skill.name, description: skill.description })) });
    const serialized = JSON.stringify(request);
    for (const field of ["private-skill-", "private-revision-", "fileCount", "hasExecutables", "PRIVATE_INSTRUCTIONS_NEVER_DISCLOSE", "private-file-name", "PRIVATE_FILE_BYTES"]) expect(serialized).not.toContain(field);
  });
  it("retains uncertain relevance, orders complete scores and keeps tie order stable", () => {
    const cohort = answers(); cohort.s2!.noul = 0.9; cohort.s4!.noul = 0.9; cohort.s1!.noul = 0.5; cohort.s3!.noul = 0.1;
    expect(skillCatalogRelevanceSelection(plan(), cohort)).toEqual(["private-skill-2", "private-skill-4", "private-skill-1", "private-skill-3"]);
    expect(skillCatalogRelevanceSelection(plan(), answers())).toEqual([]);
  });
  it("rejects a missing, extra, malformed or non-finite cohort as a whole", () => {
    const missing = answers(); delete missing.s32;
    const extra = { ...answers(), forged: { type: "noul", noul: 1 } };
    for (const bad of [null, [], missing, extra, ...[NaN, Infinity, -0.1, 1.1, "0.9"].map(noul => ({ ...answers(), s3: { type: "noul", noul } })),
      { ...answers(), s3: { type: "choice", choice: "private-skill-3" } }]) expect(skillCatalogRelevanceSelection(plan(), bad)).toBeNull();
  });
  it("skips small catalogs, oversized full cohorts and incomplete query metadata without partial requests", () => {
    expect(buildSkillCatalogRelevancePlan({ ...input, candidates: candidates.slice(0, 32) })).toBeNull();
    expect(buildSkillCatalogRelevancePlan({ ...input, candidates: [...candidates, candidates[0]!] })).toBeNull();
    expect(buildSkillCatalogRelevancePlan({ ...input, query: "界".repeat(4097) })).toBeNull();
    expect(buildSkillCatalogRelevancePlan({ ...input, candidates: candidates.map(skill => ({ ...skill, description: "界".repeat(1024) })) })).toBeNull();
    expect(buildSkillCatalogRelevancePlan({ ...input, candidates: candidates.map(skill => ({ ...skill, description: undefined })) })).toBeNull();
    expect(buildSkillCatalogRelevancePlan({ ...input, query: " " })).toBeNull();
  });
});
