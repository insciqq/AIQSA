import { describe, expect, it } from "vitest";
import { buildSkillSuggestionPlan, selectedSkillSuggestions } from "./suggestionPolicy";

const candidates = [{ id: "private-a", revisionId: "private-revision-a", name: "Procedure A", description: "A procedure", instructions: "HIDDEN_INSTRUCTIONS" },
  { id: "private-b", revisionId: "private-revision-b", name: "Procedure B", description: "A second procedure" }];
const input = { draft: "Help with the current task", context: [], candidates, excludedIds: new Set<string>() };
describe("optional Skill suggestion policy", () => {
  it("sends metadata aliases without hidden instructions, private IDs or excluded entries", () => {
    const plan = buildSkillSuggestionPlan({ ...input, excludedIds: new Set(["private-b"]) })!;
    expect(plan.request.state).toEqual({ draft: input.draft, context: [], catalog: [{ id: "s0", name: "Procedure A", description: "A procedure" }] });
    expect(JSON.stringify(plan.request)).not.toMatch(/private-|HIDDEN_INSTRUCTIONS|Procedure B/u);
  });
  it("does not need a provider for an empty draft or catalog", () => {
    expect(buildSkillSuggestionPlan({ ...input, draft: " " })).toBeNull();
    expect(buildSkillSuggestionPlan({ ...input, candidates: [] })).toBeNull();
  });
  it("retains authorized revision identity while returning only clearly useful suggestions", () => {
    const plan = buildSkillSuggestionPlan(input)!;
    expect(selectedSkillSuggestions(plan, { s0: { type: "noul", noul: 0.8 }, s1: { type: "noul", noul: 0.2 } })).toEqual([candidates[0]]);
    expect(selectedSkillSuggestions(plan, { s0: { type: "noul", noul: 0 }, s1: { type: "noul", noul: 0 } })).toEqual([]);
  });
  it("discards incomplete, non-finite and out-of-catalog results", () => {
    const plan = buildSkillSuggestionPlan(input)!;
    expect(selectedSkillSuggestions(plan, { s0: { type: "noul", noul: 1 } })).toBeNull();
    expect(selectedSkillSuggestions(plan, { s0: { type: "noul", noul: NaN }, s1: { type: "noul", noul: 1 } })).toBeNull();
    expect(selectedSkillSuggestions(plan, { s0: { type: "noul", noul: 1 }, unknown: { type: "noul", noul: 1 } })).toBeNull();
  });
});
