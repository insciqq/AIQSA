import type { AssistantDraft } from "@/lib/contracts/assistants";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAssistant } from "./assistantsApi";

const mocks = vi.hoisted(() => ({ shellFetch: vi.fn() }));

vi.mock("@/components/app-shell/shellApi", () => ({ shellFetch: mocks.shellFetch }));

const draft: AssistantDraft = {
  avatar: {
    accents: [0, 4],
    backgroundShape: "circle",
    foregroundShape: "diamond",
    kind: "generated",
    paletteId: "ocean",
    recipeVersion: 1,
    rotations: [0, 2]
  },
  category: null,
  description: "",
  developerPrompt: null,
  knowledgeSelection: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
  mcpServerIds: [],
  name: "Reviewer",
  providerModelId: "model-1",
  runControls: {},
  searchPlan: { mode: "all_selected", optionIds: [] },
  skillIds: [],
  starterPrompts: [],
  systemPrompt: ""
};

beforeEach(() => vi.resetAllMocks());

describe("Assistants API errors", () => {
  it("preserves bounded run-control field and limit metadata", async () => {
    mocks.shellFetch.mockResolvedValue(Response.json({
      error: "assistant_run_controls_invalid",
      field: "maxOutputTokens",
      limit: 8192
    }, { status: 400 }));

    await expect(createAssistant(draft)).resolves.toEqual({
      code: "assistant_run_controls_invalid",
      field: "maxOutputTokens",
      limit: 8192,
      message: "The assistant request could not be completed.",
      ok: false
    });
  });

  it("drops unknown or non-finite error metadata", async () => {
    mocks.shellFetch.mockResolvedValue(Response.json({
      error: "assistant_run_controls_invalid",
      field: "providerSecret",
      limit: "8192"
    }, { status: 400 }));

    await expect(createAssistant(draft)).resolves.toEqual({
      code: "assistant_run_controls_invalid",
      message: "The assistant request could not be completed.",
      ok: false
    });
  });
});
