import type {
  AssistantAvatarRecipe,
  AssistantRevisionContent
} from "@/lib/contracts/assistants";
import type { ModelParameterControls } from "@/lib/contracts/catalog";
import { describe, expect, it } from "vitest";
import {
  assistantDraftFromEditorState,
  editorStateFromRevision,
  reconcileDraftForModel,
  type AssistantEditorDraftState
} from "./libraryViewContracts";

const avatar: AssistantAvatarRecipe = {
  accents: [0, 4],
  backgroundShape: "circle",
  foregroundShape: "diamond",
  kind: "generated",
  paletteId: "ocean",
  recipeVersion: 1,
  rotations: [0, 2]
};

function controls(overrides: Partial<ModelParameterControls> = {}): ModelParameterControls {
  return {
    background: { defaultValue: true, supported: true },
    maxOutputTokens: { defaultValue: 4096, maxValue: 8192 },
    reasoningEffort: {
      defaultValue: "medium",
      options: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
      supported: true
    },
    reasoningMode: {
      defaultValue: "standard",
      options: ["standard", "pro"],
      supported: true
    },
    stream: { defaultValue: true, supported: true },
    temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: true },
    ...overrides
  };
}

function editor(overrides: Partial<AssistantEditorDraftState> = {}): AssistantEditorDraftState {
  return {
    avatar,
    backgroundMode: null,
    category: "coding",
    description: "Reviews changes.",
    developerPrompt: "",
    knowledgeSelection: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    maxOutputTokens: "",
    mcpServerIds: [],
    name: "Reviewer",
    providerModelId: "model-1",
    reasoningEffort: "",
    reasoningMode: "",
    searchOptionIds: [],
    searchPlanMode: "all_selected",
    skillIds: [],
    starterPrompts: [],
    streamMode: null,
    systemPrompt: "Review carefully.",
    temperature: "",
    ...overrides
  };
}

function revision(runControls: AssistantRevisionContent["runControls"]): AssistantRevisionContent {
  return {
    authorDisplayName: "Dana",
    avatar,
    category: null,
    createdAt: "2026-09-03T10:00:00.000Z",
    description: "",
    developerPrompt: null,
    knowledgeSelection: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    mcpServerIds: [],
    name: "Reviewer",
    providerModelId: "model-1",
    revisionNumber: 1,
    runControls,
    searchPlan: { mode: "all_selected", optionIds: [] },
    skillIds: [],
    starterPrompts: [],
    systemPrompt: ""
  };
}

describe("Assistant editor run-control contracts", () => {
  it("omits every untouched control so the model defaults remain authoritative", () => {
    expect(assistantDraftFromEditorState(editor(), controls())).toMatchObject({
      draft: { runControls: {} }
    });
  });

  it.each(["0", "-5", "1.5", "8193"])(
    "rejects invalid max output tokens %s instead of silently dropping it",
    (maxOutputTokens) => {
      expect(assistantDraftFromEditorState(
        editor({ maxOutputTokens }),
        controls()
      )).toEqual({
        fieldErrors: {
          maxOutputTokens: "Enter a whole number from 1 to 8192."
        }
      });
    }
  );

  it("rejects out-of-range and unsupported Temperature values", () => {
    expect(assistantDraftFromEditorState(editor({ temperature: "3" }), controls()))
      .toMatchObject({ fieldErrors: { temperature: expect.any(String) } });
    expect(assistantDraftFromEditorState(
      editor({ temperature: "1" }),
      controls({
        temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: false }
      })
    )).toEqual({
      fieldErrors: { temperature: "This model does not support Temperature." }
    });
  });

  it("accepts the exact catalog effort set and rejects stale values", () => {
    expect(assistantDraftFromEditorState(
      editor({ reasoningEffort: "max" }),
      controls()
    )).toMatchObject({ draft: { runControls: { reasoningEffort: "max" } } });
    expect(assistantDraftFromEditorState(
      editor({ reasoningEffort: "ultra" }),
      controls()
    )).toMatchObject({ fieldErrors: { reasoningEffort: expect.any(String) } });
  });

  it("resets incompatible values without clamping and reports every reset field", () => {
    const result = reconcileDraftForModel(
      editor({
        backgroundMode: true,
        maxOutputTokens: "8192",
        reasoningEffort: "max",
        reasoningMode: "pro",
        streamMode: false,
        temperature: "2"
      }),
      controls({
        background: { defaultValue: false, supported: false },
        maxOutputTokens: { defaultValue: 1024, maxValue: 2048 },
        reasoningEffort: { defaultValue: "low", options: ["low"], supported: true },
        reasoningMode: undefined,
        stream: { defaultValue: true, supported: true },
        temperature: { defaultValue: 0.5, maxValue: 1, minValue: 0, supported: true }
      })
    );

    expect(result.draft).toMatchObject({
      backgroundMode: null,
      maxOutputTokens: "",
      reasoningEffort: "",
      reasoningMode: "",
      streamMode: false,
      temperature: ""
    });
    expect(result.resetFields).toEqual([
      "backgroundMode",
      "maxOutputTokens",
      "temperature",
      "reasoningEffort",
      "reasoningMode"
    ]);
  });

  it("round-trips absent revision controls as nullable model defaults", () => {
    expect(editorStateFromRevision(revision({}))).toMatchObject({
      backgroundMode: null,
      maxOutputTokens: "",
      reasoningEffort: "",
      reasoningMode: "",
      streamMode: null,
      temperature: ""
    });
  });
});
