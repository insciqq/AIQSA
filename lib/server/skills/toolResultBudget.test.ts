import { describe, expect, it } from "vitest";
import type { ProviderConversationMessage, ProviderRunRequest } from "../providers/types";
import { openAIResponsesToolBridge } from "../tools/bridges";
import { readToolResultTool } from "../tools/readToolResult";
import type { ToolExecutionResult } from "../tools/types";
import { conversationContextPolicy } from "../runs/contextCompactionContract";
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

  // Review reproduction: window 20 000, maxOutput 512 (17 488-token budget).
  const accepted = (mode: "hybrid" | "legacy_compatible", history: ProviderConversationMessage[] = []): ProviderRunRequest => {
    const messages = [...history, { content: request.content, id: "current", role: "user" as const }];
    return {
      ...request,
      context: { messages, mode: "branch_path" },
      contextCompactionPolicy: conversationContextPolicy({ leafMessageId: "current", messages, mode }),
      modelCapabilities: { ...request.modelCapabilities, contextWindow: 20_000, toolCalling: true },
      toolObservationVersion: 1,
      tools: [readToolResultTool]
    };
  };

  it.each(["hybrid", "legacy_compatible"] as const)("refuses a %s Skill result that cannot fit by itself", (mode) => {
    const budget = createSkillToolResultBudget();
    budget.begin({ request: accepted(mode), bridge: openAIResponsesToolBridge, calls: [{ id: "skill", name: "load_skill" }] });
    // About 51 300 estimated tokens: no summary can shrink the newest batch.
    expect(budget.accept(result("skill", "load_skill", 205_164)))
      .toMatchObject({ status: "error", content: [{ value: { error: "skill_too_large_for_context" } }] });
  });

  it("admits a fitting hybrid Skill result while a summary of long history is still pending", () => {
    const history = Array.from({ length: 12 }, (_, index): ProviderConversationMessage => ({
      content: { blocks: [{ text: "h".repeat(6_000), type: "text" }] }, id: `h${index}`, role: index % 2 ? "assistant" : "user"
    }));
    const hybrid = accepted("hybrid", history);
    const budget = createSkillToolResultBudget();
    budget.begin({ request: hybrid, bridge: openAIResponsesToolBridge, calls: [{ id: "skill", name: "load_skill" }] });
    const admitted = budget.accept(result("skill", "load_skill", 2_000));
    expect(admitted.status).toBe("complete");
    const next = applyProviderRequestContextBudget({ bridge: openAIResponsesToolBridge, request: {
      ...hybrid, providerToolMessages: [openAIResponsesToolBridge.appendToolResult(undefined, admitted)]
    } });
    expect(next).toMatchObject({ ok: true, request: { contextCompaction: { outcome: "needs_summary" } } });
  });
});
