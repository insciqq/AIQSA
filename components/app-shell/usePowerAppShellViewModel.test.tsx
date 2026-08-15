import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { usePowerAppShellViewModel } from "./usePowerAppShellViewModel";
import { estimateApproxTokens } from "@/lib/domain/contextBudget";
import { STANDARD_CHAT_BASELINE_TEMPLATE } from "@/lib/domain/promptTemplates";
import type { Catalog, WorkspaceChatSummary } from "./types";

function chat(id: string): WorkspaceChatSummary {
  return {
    activeLeafMessageId: null,
    createdAt: "2026-06-10T00:00:00.000Z",
    defaultModelId: "gpt-5.5",
    defaultProvider: "openai",
    folderId: null,
    id,
    messageCount: 0,
    title: "Chat",
    updatedAt: "2026-06-10T00:00:00.000Z"
  };
}

function renderViewModel(overrides: Partial<Parameters<typeof usePowerAppShellViewModel>[0]> = {}) {
  return renderHook(() =>
    usePowerAppShellViewModel({
      activeChatId: "chat-a",
      activeChatStreaming: false,
      activeThreadUsageStats: null,
      attachments: [],
      catalog: null,
      chats: [chat("chat-a")],
      draft: "",
      folders: [],
      maxOutputTokens: "128000",
      pendingChatFolderId: null,
      projectSettingsFolderId: null,
      renderActiveLeafId: null,
      runSurface: { events: [] },
      selectedAssistantPromptCharacterCount: null,
      selectedModelId: "gpt-5.5",
      selectedProvider: "openai",
      visibleMessages: [],
      ...overrides
    })
  );
}

const emptyCatalog: Catalog = {
  defaults: {
    controlValues: {},
    hasPersonalModelDefault: true,
    modelId: "gpt-5.5",
    modelPreferenceSource: "personal",
    organizationModelDefault: null,
    organizationSearchPlan: { mode: "all_selected", optionIds: [] },
    personalModelDefault: { modelId: "gpt-5.5", provider: "openai" },
    provider: "openai",
    searchPlan: { mode: "all_selected", optionIds: [] },
    searchPreferenceSource: "personal",
    showCitations: true,
    showReasoningBlocks: false,
  },
  models: [],
  providers: [],
  searchStrategies: [{ displayName: "No Search", kind: "none", strategyId: "search-disabled" }]
};

describe("usePowerAppShellViewModel", () => {
  it("does not mark a blank workspace as streaming while another chat runs", () => {
    const { result } = renderViewModel({
      activeChatId: null,
      activeChatStreaming: false
    });

    expect(result.current.activeChatStreaming).toBe(false);
  });

  it("keeps the complete command-palette chat inventory", () => {
    const alpha = { ...chat("chat-alpha"), title: "Alpha notes" };
    const beta = { ...chat("chat-beta"), title: "Beta plan" };
    const { result } = renderViewModel({ chats: [alpha, beta] });

    expect(
      result.current.commandChatGroups.flatMap((group) => group.chats.map((item) => item.id))
    ).toEqual(expect.arrayContaining(["chat-alpha", "chat-beta"]));
  });

  it("marks only the owning chat as streaming", () => {
    const { result } = renderViewModel({
      activeChatStreaming: true
    });

    expect(result.current.activeChatStreaming).toBe(true);
  });

  it("uses the user message as the reading anchor for a streaming turn", () => {
    const { result } = renderViewModel({
      visibleMessages: [
        {
          content: "Previous answer",
          id: "assistant-previous",
          parentMessageId: null,
          role: "assistant",
          status: "complete"
        },
        {
          content: "New question",
          id: "user-current",
          parentMessageId: "assistant-previous",
          role: "user",
          status: "complete"
        },
        {
          content: "",
          id: "assistant-current",
          parentMessageId: "user-current",
          role: "assistant",
          status: "streaming"
        }
      ]
    });

    expect(result.current.threadReadingAnchorKey).toBe("user-current");
  });

  it("shows an entitlement hint when the current user has no catalog models", () => {
    const { result } = renderViewModel({
      catalog: emptyCatalog,
      selectedModelId: "",
      selectedProvider: ""
    });

    expect(result.current.currentModel).toBeUndefined();
    expect(result.current.composerDisabledHint).toBe("No model access. Ask an admin to grant model access.");
  });

  it("swaps the baseline estimate for the assistant prompt size when an assistant is selected", () => {
    // The baseline estimate must come from the raw template, never a live
    // clock/zone/locale render: SSR and hydration would disagree otherwise.
    const withoutAssistant = renderViewModel();
    const baselineTokens = estimateApproxTokens(STANDARD_CHAT_BASELINE_TEMPLATE);
    expect(baselineTokens).toBe(21);
    expect(withoutAssistant.result.current.composerContextStats.approximateInputTokens).toBe(
      baselineTokens
    );

    const withAssistant = renderViewModel({ selectedAssistantPromptCharacterCount: 8001 });
    expect(withAssistant.result.current.composerContextStats.approximateInputTokens).toBe(
      Math.ceil(8001 / 4)
    );
  });

  it("uses the server-owned full active-branch estimate when the browser holds only a page", () => {
    const { result } = renderViewModel({
      activeThreadContextStats: { approximateActiveBranchInputTokens: 12_345 },
      visibleMessages: [{
        content: "only the loaded tail",
        id: "tail",
        parentMessageId: "unloaded-parent",
        role: "assistant",
        status: "complete"
      }]
    });

    expect(result.current.composerContextStats.approximateInputTokens).toBe(
      estimateApproxTokens(STANDARD_CHAT_BASELINE_TEMPLATE) + 12_345
    );
  });
});
