import { describe, expect, it } from "vitest";
import type { AssistantRevisionContent } from "../contracts/assistants";
import { assistantRevisionChangedSections } from "./assistants";

function revision(overrides: Partial<AssistantRevisionContent> = {}): AssistantRevisionContent {
  return {
    authorDisplayName: "Alex",
    avatar: {
      accents: [1],
      backgroundShape: "circle",
      foregroundShape: "ring",
      kind: "generated",
      paletteId: "ember",
      recipeVersion: 1,
      rotations: [0, 0]
    },
    category: "coding",
    createdAt: "2026-08-06T00:00:00.000Z",
    description: "Reviews changes.",
    developerPrompt: null,
    knowledgeSelection: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    mcpServerIds: ["a", "b"],
    name: "Code Reviewer",
    providerModelId: "model-1",
    revisionNumber: 2,
    runControls: { reasoningEffort: "high" },
    searchPlan: { mode: "all_selected", optionIds: [] },
    skillIds: [],
    starterPrompts: ["Review a diff"],
    systemPrompt: "You review code.",
    ...overrides
  };
}

describe("assistantRevisionChangedSections", () => {
  it("marks every section for the first revision", () => {
    expect(assistantRevisionChangedSections(null, revision())).toEqual([
      "identity",
      "instructions",
      "model",
      "run-setup",
      "search",
      "skills",
      "starters",
      "tools"
    ]);
  });

  it("returns only the semantically changed sections", () => {
    const previous = revision();
    expect(
      assistantRevisionChangedSections(previous, revision({ name: "Strict Reviewer" }))
    ).toEqual(["identity"]);
    expect(
      assistantRevisionChangedSections(previous, revision({ systemPrompt: "Be strict." }))
    ).toEqual(["instructions"]);
    expect(
      assistantRevisionChangedSections(previous, revision({ providerModelId: "model-2" }))
    ).toEqual(["model"]);
    expect(
      assistantRevisionChangedSections(previous, revision({ runControls: { temperature: 0.2 } }))
    ).toEqual(["run-setup"]);
    expect(
      assistantRevisionChangedSections(
        previous,
        revision({ searchPlan: { mode: "model_choice", optionIds: ["x"] } })
      )
    ).toEqual(["search"]);
    expect(
      assistantRevisionChangedSections(previous, revision({ starterPrompts: [] }))
    ).toEqual(["starters"]);
    expect(
      assistantRevisionChangedSections(previous, revision({ skillIds: ["skill-1"] }))
    ).toEqual(["skills"]);
  });

  it("ignores MCP server ordering but not membership", () => {
    const previous = revision({ mcpServerIds: ["a", "b"] });
    expect(
      assistantRevisionChangedSections(previous, revision({ mcpServerIds: ["b", "a"] }))
    ).toEqual([]);
    expect(
      assistantRevisionChangedSections(previous, revision({ mcpServerIds: ["a"] }))
    ).toEqual(["tools"]);
  });
});
