import { render, renderHook } from "@testing-library/react";
import { memo } from "react";
import { describe, expect, it, vi } from "vitest";
import { usePowerAppShellViewModel } from "./usePowerAppShellViewModel";
import { formatComposerContextStats } from "./composerContextStats";
import { estimateApproxTokens } from "@/lib/domain/contextBudget";
import { STANDARD_CHAT_BASELINE_TEMPLATE } from "@/lib/domain/promptTemplates";
import type { Catalog, ChatGroup, ChatSummary, FolderSummary, ThreadMessage } from "./types";

function chat(id: string): ChatSummary {
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
      chatContentMatchIds: new Set(),
      chatQuery: "",
      chats: [chat("chat-a")],
      draft: "",
      folders: [],
      maxOutputTokens: "128000",
      pendingChatFolderId: null,
      projectSettingsFolderId: null,
      renderActiveLeafId: null,
      runSurface: { events: [], lastRun: null, runsById: {} },
      selectedAssistantPromptCharacterCount: null,
      selectedModelId: "gpt-5.5",
      selectedProvider: "openai",
      selectedSearchStrategy: "search-disabled",
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
    personalModelDefault: { modelId: "gpt-5.5", provider: "openai" },
    provider: "openai",
    searchStrategyId: "search-disabled",
    showCitations: true,
    showReasoningBlocks: false,
    showToolActivity: true,
  },
  models: [],
  providers: [],
  searchStrategies: [{ displayName: "No Search", kind: "none", strategyId: "search-disabled" }]
};

describe("usePowerAppShellViewModel", () => {
  it("keeps summary identity and sidebar memoization stable for thread-only changes", () => {
    const onRender = vi.fn();
    const contentMatchIds = new Set<string>();
    const folders: FolderSummary[] = [];
    const SidebarProbe = memo(function SidebarProbe({ chatGroups }: { chatGroups: ChatGroup[] }) {
      const firstSummary = chatGroups[0]?.chats[0] ?? null;
      onRender(firstSummary);
      return <span>{firstSummary?.title}</span>;
    });
    function Harness({ chats, visibleMessages }: { chats: ChatSummary[]; visibleMessages: ThreadMessage[] }) {
      const viewModel = usePowerAppShellViewModel({
        activeChatId: "chat-a",
        activeChatStreaming: false,
        activeThreadUsageStats: null,
        attachments: [],
        catalog: null,
        chatContentMatchIds: contentMatchIds,
        chatQuery: "",
        chats,
        draft: "",
        folders,
        maxOutputTokens: "128000",
        pendingChatFolderId: null,
        projectSettingsFolderId: null,
        renderActiveLeafId: null,
        runSurface: { events: [], lastRun: null, runsById: {} },
        selectedAssistantPromptCharacterCount: null,
        selectedModelId: "gpt-5.5",
        selectedProvider: "openai",
        selectedSearchStrategy: "search-disabled",
        visibleMessages
      });

      return <SidebarProbe chatGroups={viewModel.chatGroups} />;
    }

    const initialChat = chat("chat-a");
    const stableChats = [initialChat];
    const view = render(<Harness chats={stableChats} visibleMessages={[]} />);
    const initialRenderCount = onRender.mock.calls.length;
    expect(onRender).toHaveBeenLastCalledWith(initialChat);
    view.rerender(
      <Harness
        chats={stableChats}
        visibleMessages={[
          {
            content: "x".repeat(2_000),
            id: "assistant-1",
            parentMessageId: null,
            role: "assistant",
            status: "streaming"
          }
        ]}
      />
    );

    expect(onRender).toHaveBeenCalledTimes(initialRenderCount);

    const renamedChat = { ...initialChat, title: "Renamed chat" };
    view.rerender(<Harness chats={[renamedChat]} visibleMessages={[]} />);
    expect(onRender).toHaveBeenCalledTimes(initialRenderCount + 1);
    expect(onRender).toHaveBeenLastCalledWith(renamedChat);
  });

  it("does not mark a blank workspace as streaming while another chat runs", () => {
    const { result } = renderViewModel({
      activeChatId: null,
      activeChatStreaming: false
    });

    expect(result.current.activeChatStreaming).toBe(false);
  });

  it("keeps the command-palette chat inventory independent from sidebar filtering", () => {
    const alpha = { ...chat("chat-alpha"), title: "Alpha notes" };
    const beta = { ...chat("chat-beta"), title: "Beta plan" };
    const { result } = renderViewModel({
      chatQuery: "alpha",
      chats: [alpha, beta]
    });

    expect(result.current.chatGroups.flatMap((group) => group.chats.map((item) => item.id))).toEqual([
      "chat-alpha"
    ]);
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

  it("derives Details errors only from the selected chat run surface", () => {
    const idleB = renderViewModel({
      activeChatId: "chat-b",
      chats: [chat("chat-a"), chat("chat-b")],
      runSurface: { events: [], lastRun: null, runsById: {} }
    });
    expect(idleB.result.current.currentErrorText).toBeNull();

    const failedA = renderViewModel({
      runSurface: {
        events: [{ data: { message: "A failed" }, type: "error" }],
        lastRun: null,
        runsById: {}
      }
    });
    expect(failedA.result.current.currentErrorText).toContain("A failed");
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

  it("does not present a one-token compatibility sentinel as model context", () => {
    const catalog: Catalog = {
      ...emptyCatalog,
      models: [{
        capabilities: {
          background: false,
          documentInputMode: "none",
          imageInput: false,
          nativeWebSearch: false,
          openRouterPerplexitySearch: false,
          reasoning: false,
          streaming: true,
          toolCalling: false
        },
        contextWindow: 1,
        defaultParams: {},
        displayName: "Private model",
        modelId: "private-model",
        parameterControls: {
          background: { defaultValue: false, supported: false },
          maxOutputTokens: { defaultValue: 1024, maxValue: 1024 },
          reasoningEffort: { defaultValue: "none", options: ["none"], supported: false },
          stream: { defaultValue: true, supported: true },
          temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: true }
        },
        provider: "private-connection",
        searchStrategyIds: ["search-disabled"]
      }],
      providers: [{ id: "private-connection", models: ["private-model"], name: "Private" }]
    };
    const { result } = renderViewModel({
      catalog,
      draft: "draft",
      selectedModelId: "private-model",
      selectedProvider: "private-connection"
    });

    expect(formatComposerContextStats(result.current.composerContextStats)).toMatch(/^Approx\. input: ~/);
    expect(result.current.composerContextStats.safeInputBudgetTokens).toBeNull();
    expect(result.current.composerContextStats.totalContextTokens).toBeNull();
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

  it("derives current context and active-chat usage stats", () => {
    const catalog: Catalog = {
      defaults: {
        controlValues: {},
        hasPersonalModelDefault: true,
        modelId: "gpt-5.5",
        modelPreferenceSource: "personal",
        organizationModelDefault: null,
        personalModelDefault: { modelId: "gpt-5.5", provider: "openai" },
        provider: "openai",
        searchStrategyId: "search-disabled",
        showCitations: true,
        showReasoningBlocks: false,
        showToolActivity: true,
      },
      models: [
        {
          capabilities: {
            background: true,
            documentInputMode: "none",
            imageInput: false,
            nativeWebSearch: false,
            openRouterPerplexitySearch: false,
            reasoning: true,
            streaming: true,
            toolCalling: true
          },
          contextWindow: 1_050_000,
          defaultParams: {},
          displayName: "GPT 5.5",
          modelId: "gpt-5.5",
          parameterControls: {
            background: { defaultValue: true, supported: true },
            maxOutputTokens: { defaultValue: 1024, maxValue: 128000 },
            reasoningEffort: { defaultValue: "medium", options: ["none", "medium"], supported: true },
            stream: { defaultValue: false, supported: true },
            temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: true }
          },
          provider: "openai",
          searchStrategyIds: ["search-disabled"]
        }
      ],
      providers: [{ id: "openai", models: ["gpt-5.5"], name: "OpenAI" }],
      searchStrategies: [{ displayName: "No Search", kind: "none", strategyId: "search-disabled" }]
    };
    const currentChat = chat("chat-a");
    currentChat.activeLeafMessageId = "assistant-1";
    const visibleMessages: ThreadMessage[] = [
      {
        content: "hello",
        id: "user-1",
        parentMessageId: null,
        role: "user",
        status: "complete"
      },
      {
        content: "answer",
        id: "assistant-1",
        parentMessageId: "user-1",
        role: "assistant",
        status: "complete"
      }
    ];
    const usageStats = {
      activeBranchMessageCount: 2,
      cachedInputTokens: 10,
      cacheWriteInputTokens: 0,
      totalTokens: 24
    };

    const { result } = renderViewModel({
      activeThreadUsageStats: usageStats,
      catalog,
      chats: [currentChat],
      draft: "draft text",
      maxOutputTokens: "64000",
      renderActiveLeafId: "assistant-1",
      visibleMessages
    });

    expect(formatComposerContextStats(result.current.composerContextStats)).toMatch(/^Approx\. input: ~/);
    expect(formatComposerContextStats(result.current.composerContextStats)).toContain("/ 881k safe input · 1.05m total context");
    expect(result.current.composerUsageStats).toEqual(usageStats);
  });

  it("uses the provider family rather than its opaque connection id for context limits", () => {
    const catalog: Catalog = {
      defaults: {
        controlValues: {},
        hasPersonalModelDefault: true,
        modelId: "fake-model-id",
        modelPreferenceSource: "personal",
        organizationModelDefault: null,
        personalModelDefault: {
          modelId: "fake-model-id",
          provider: "fake-connection-id"
        },
        provider: "fake-connection-id",
        searchStrategyId: "search-disabled",
        showCitations: true,
        showReasoningBlocks: false,
        showToolActivity: true,
      },
      models: [
        {
          capabilities: {
            background: false,
            documentInputMode: "none",
            imageInput: false,
            nativeWebSearch: false,
            openRouterPerplexitySearch: false,
            reasoning: true,
            streaming: true,
            toolCalling: true
          },
          contextWindow: 8192,
          defaultParams: {},
          displayName: "Fake QSA",
          modelId: "fake-model-id",
          parameterControls: {
            background: { defaultValue: false, supported: false },
            maxOutputTokens: { defaultValue: 8192, maxValue: 8192 },
            reasoningEffort: { defaultValue: "medium", options: ["medium"], supported: true },
            stream: { defaultValue: true, supported: false },
            temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: true }
          },
          provider: "fake-connection-id",
          providerFamily: "fake",
          searchStrategyIds: ["search-disabled"],
          upstreamModelId: "fake-qsa"
        }
      ],
      providers: [
        {
          family: "fake",
          id: "fake-connection-id",
          models: ["fake-model-id"],
          name: "Fake QSA"
        }
      ],
      searchStrategies: [{ displayName: "No Search", kind: "none", strategyId: "search-disabled" }]
    };

    const { result } = renderViewModel({
      catalog,
      maxOutputTokens: "8192",
      selectedModelId: "fake-model-id",
      selectedProvider: "fake-connection-id"
    });

    expect(formatComposerContextStats(result.current.composerContextStats)).toContain("/ 7.4k safe input · 8.2k total context");
  });

  it("adds native PDF text and page-image estimates to current context", () => {
    const catalog: Catalog = {
      defaults: {
        controlValues: {},
        hasPersonalModelDefault: true,
        modelId: "gpt-5.5",
        modelPreferenceSource: "personal",
        organizationModelDefault: null,
        personalModelDefault: { modelId: "gpt-5.5", provider: "openai" },
        provider: "openai",
        searchStrategyId: "search-disabled",
        showCitations: true,
        showReasoningBlocks: false,
        showToolActivity: true,
      },
      models: [
        {
          capabilities: {
            background: true,
            documentInputMode: "native_pdf",
            imageInput: true,
            nativeWebSearch: false,
            openRouterPerplexitySearch: false,
            reasoning: true,
            streaming: true,
            toolCalling: true
          },
          contextWindow: 1_050_000,
          defaultParams: {},
          displayName: "GPT 5.5",
          modelId: "gpt-5.5",
          parameterControls: {
            background: { defaultValue: true, supported: true },
            maxOutputTokens: { defaultValue: 1024, maxValue: 128000 },
            reasoningEffort: { defaultValue: "medium", options: ["none", "medium"], supported: true },
            stream: { defaultValue: false, supported: true },
            temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: true }
          },
          provider: "openai",
          searchStrategyIds: ["search-disabled"]
        }
      ],
      providers: [{ id: "openai", models: ["gpt-5.5"], name: "OpenAI" }],
      searchStrategies: [{ displayName: "No Search", kind: "none", strategyId: "search-disabled" }]
    };

    const { result } = renderViewModel({
      attachments: [
        {
          extractedText: "x".repeat(4000),
          fileName: "notes.pdf",
          id: "attachment-1",
          kind: "pdf",
          metadata: { pdf: { pageCount: 999_999 } },
          mimeType: "application/pdf",
          processing: {
            extractedCharacterCount: 4_000,
            pageCount: 2,
            pagesProcessed: 2,
            status: "complete"
          }
        }
      ],
      catalog,
      selectedModelId: "gpt-5.5",
      selectedProvider: "openai"
    });

    expect(formatComposerContextStats(result.current.composerContextStats)).toContain("~2k / 817k safe input · 1.05m total context");
  });
});
