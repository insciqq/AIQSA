import { describe, expect, it } from "vitest";
import type { ProviderRunRequest } from "../providers/types";
import { openAIResponsesToolBridge } from "../tools/bridges";
import type { ToolExecutionResult } from "../tools/types";
import { applyProviderRequestContextBudget } from "../runs/runContextBudget";
import { createSkillToolResultBudget } from "./toolResultBudget";

const request: ProviderRunRequest = {
  attachmentIds: [], attachments: [], chatId: "chat", content: { blocks: [{ type: "text", text: "Question" }] },
  knowledgePlan: { baseIds: [], sourceIds: [], mode: "none", version: 1 },
  modelCapabilities: { contextWindow: 6_000, defaultMaxOutputTokens: 512, nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false },
  modelId: "model", provider: "openai", params: {}, prompt: { system: null, developer: null },
  searchPlan: { mode: "all_selected", options: [] }, toolMode: "auto"
};
const result = (callId: string, name: string, size: number): ToolExecutionResult => ({
  callId, name, status: "complete", content: [{ type: "json", value: { instructions: "x".repeat(size) } }]
});

describe("Skill result context admission", () => {
  it("counts other results and preceding Skill reads before persisting, preserving a valid next round", () => {
    const budget = createSkillToolResultBudget();
    const calls = [{ id: "external", name: "search" }, { id: "a", name: "load_skill" }, { id: "b", name: "read_skill_file" }];
    budget.begin({ request, bridge: openAIResponsesToolBridge, calls });
    const external = budget.accept(result("external", "search", 2_000));
    const first = budget.accept(result("a", "load_skill", 10_000));
    const second = budget.accept(result("b", "read_skill_file", 10_000));
    expect(first.status).toBe("complete");
    expect(second).toMatchObject({ status: "error", content: [{ value: { error: "skill_too_large_for_context" } }] });
    expect(applyProviderRequestContextBudget({ bridge: openAIResponsesToolBridge, request: {
      ...request, providerToolMessages: [external, first, second].map((entry) => openAIResponsesToolBridge.appendToolResult(undefined, entry))
    } }).ok).toBe(true);
  });
});
