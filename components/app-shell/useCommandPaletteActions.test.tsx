import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Catalog, WorkspaceChatSummary } from "./types";
import { useCommandPaletteActions } from "./useCommandPaletteActions";

function renderActions(
  branchesOpen: boolean,
  workspaceReady = true,
  surface: "assistants" | "knowledge" | "memory" | "settings" | null = null
) {
  const toggleBranches = vi.fn();
  const closePalette = vi.fn();
  const openKnowledge = vi.fn();
  const openLibrary = vi.fn();
  const openMemory = vi.fn();
  const openSettings = vi.fn();
  const { result } = renderHook(() =>
    useCommandPaletteActions({
      activateChat: vi.fn(),
      activateBlankWorkspace: vi.fn(),
      activeChatId: null,
      assistantLibraryOpen: surface === "assistants",
      branchesOpen,
      catalog: null,
      chatGroups: [],
      chats: [],
      closePalette,
      knowledgeOpen: surface === "knowledge",
      memoryOpen: surface === "memory",
      openKnowledge,
      openLibrary,
      openMemory,
      openSettings,
      searchOptions: [],
      selectModel: vi.fn(),
      selectSearchStrategy: vi.fn(),
      selectedModelId: "test-model",
      selectedProvider: "test-provider",
      selectedSearchOptionIds: [],
      settingsOpen: surface === "settings",
      toggleBranches,
      workspaceReady
    })
  );

  return { closePalette, openKnowledge, openLibrary, openMemory, openSettings, result, toggleBranches };
}

describe("useCommandPaletteActions", () => {
  it("closes the palette before opening standalone Branches", async () => {
    const { closePalette, result, toggleBranches } = renderActions(false);
    const branchesCommand = result.current.commandItems.find(
      (item) => item.id === "action:toggle-branches"
    );

    expect(branchesCommand).toMatchObject({
      current: false,
      label: "Open Branches",
      subtitle: "Conversation history"
    });
    expect(renderActions(true).result.current.commandItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          current: true,
          id: "action:toggle-branches",
          label: "Close Branches"
        })
      ])
    );
    expect(result.current.commandItems.some((item) => item.id.includes("compact"))).toBe(false);
    act(() => result.current.runCommand(branchesCommand!));

    expect(closePalette).toHaveBeenCalledOnce();
    expect(toggleBranches).not.toHaveBeenCalled();
    await waitFor(() => expect(toggleBranches).toHaveBeenCalledOnce());
  });

  it("closes the palette before opening Settings on the next task", async () => {
    const { closePalette, openSettings, result } = renderActions(false);
    const settingsCommand = result.current.commandItems.find((item) => item.id === "action:open-settings");

    act(() => result.current.runCommand(settingsCommand!));

    expect(closePalette).toHaveBeenCalledOnce();
    expect(openSettings).not.toHaveBeenCalled();
    await waitFor(() => expect(openSettings).toHaveBeenCalledOnce());
  });

  it("omits New chat until workspace hydration succeeds", () => {
    expect(renderActions(false, false).result.current.commandItems).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "action:new-chat" })])
    );
    expect(renderActions(false).result.current.commandItems).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "action:new-chat" })])
    );
  });

  it.each([
    ["assistants", "action:open-library"],
    ["knowledge", "action:open-knowledge"],
    ["memory", "action:open-memory"],
    ["settings", "action:open-settings"]
  ] as const)("marks only the active %s workspace destination current", (surface, currentId) => {
    const current = renderActions(false, true, surface).result.current.commandItems
      .filter((item) => item.current && item.id.startsWith("action:open-"))
      .map((item) => item.id);
    expect(current).toEqual([currentId]);
  });

  it("builds and dispatches every searchable category with readable non-id subtitles", async () => {
    const chat: WorkspaceChatSummary = {
      activeLeafMessageId: null,
      createdAt: "2026-07-11T00:00:00.000Z",
      defaultModelId: "gpt-5.5",
      defaultProvider: "openai",
      folderId: null,
      id: "chat-1",
      messageCount: 0,
      title: "Architecture review",
      updatedAt: "2026-07-11T00:00:00.000Z"
    };
    const catalog: Catalog = {
      defaults: {
        controlValues: {},
        hasPersonalModelDefault: true,
        modelId: "gpt-5.5",
        modelPreferenceSource: "personal",
        organizationModelDefault: null,
        organizationSearchPlan: {
          mode: "all_selected",
          optionIds: ["openai-native-web-search"]
        },
        personalModelDefault: { modelId: "gpt-5.5", provider: "openai" },
        provider: "openai",
        searchPlan: {
          mode: "all_selected",
          optionIds: ["openai-native-web-search"]
        },
        searchPreferenceSource: "personal",
        showCitations: true,
        showReasoningBlocks: false,
      },
      models: [
        {
          capabilities: {
            background: false,
            documentInputMode: "none",
            imageInput: false,
            nativeWebSearch: true,
            openRouterPerplexitySearch: false,
            reasoning: true,
            streaming: true,
            toolCalling: true
          },
          contextWindow: 128_000,
          defaultParams: {},
          displayName: "GPT-5.5",
          modelId: "gpt-5.5",
          parameterControls: {
            background: { defaultValue: false, supported: false },
            maxOutputTokens: { defaultValue: 4096, maxValue: 16_384 },
            reasoningEffort: { defaultValue: "medium", options: ["medium"], supported: true },
            stream: { defaultValue: false, supported: false },
            temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: true }
          },
          provider: "openai",
          searchStrategyIds: ["openai-native-web-search"]
        }
      ],
      providers: [{ id: "openai", models: ["gpt-5.5"], name: "OpenAI" }],
      searchStrategies: [
        {
          description: "Search the web with OpenAI.",
          displayName: "OpenAI Web Search",
          kind: "web_search",
          strategyId: "openai-native-web-search"
        }
      ]
    };
    const activateChat = vi.fn();
    const selectModel = vi.fn();
    const openLibrary = vi.fn();
    const openKnowledge = vi.fn();
    const selectSearchStrategy = vi.fn();
    const closePalette = vi.fn();
    const { result } = renderHook(() =>
      useCommandPaletteActions({
        activateChat,
        activateBlankWorkspace: vi.fn(),
        activeChatId: chat.id,
        assistantLibraryOpen: false,
        branchesOpen: false,
        catalog,
        chatGroups: [{ chats: [chat], depth: 0, folder: null, name: "No folder" }],
        chats: [chat],
        closePalette,
        knowledgeOpen: false,
        memoryOpen: false,
        openKnowledge,
        openLibrary,
        openMemory: vi.fn(),
        openSettings: vi.fn(),
        searchOptions: catalog.searchStrategies,
        selectModel,
        selectSearchStrategy,
        selectedModelId: "gpt-5.5",
        selectedProvider: "openai",
        selectedSearchOptionIds: ["openai-native-web-search"],
        settingsOpen: false,
        toggleBranches: vi.fn(),
        workspaceReady: true
      })
    );

    expect(new Set(result.current.commandItems.map((item) => item.kind))).toEqual(
      new Set(["action", "chat", "model", "search"])
    );
    expect(result.current.commandItems.some((item) => item.id.startsWith("provider:"))).toBe(false);
    const modelCommand = result.current.commandItems.find((item) => item.kind === "model");
    expect(modelCommand?.subtitle).toBe("OpenAI · Reasoning · Web search · Streaming");
    expect(modelCommand?.keywords).toEqual(
      expect.arrayContaining(["gpt-5.5", "reasoning / search / stream"])
    );
    expect(modelCommand?.subtitle).not.toContain("/");
    expect(result.current.commandItems.find((item) => item.kind === "search")?.subtitle).toBe(
      "Search the web with OpenAI."
    );
    expect(result.current.commandItems.filter((item) => item.current).map((item) => item.kind)).toEqual(
      expect.arrayContaining(["chat", "model", "search"])
    );

    for (const kind of ["chat", "model", "search"] as const) {
      const item = result.current.commandItems.find((candidate) => candidate.kind === kind);
      act(() => result.current.runCommand(item!));
    }
    expect(activateChat).toHaveBeenCalledWith(chat);
    expect(selectModel).toHaveBeenCalledWith(catalog.models[0]);
    expect(selectSearchStrategy).toHaveBeenCalledWith("openai-native-web-search");
    expect(closePalette).toHaveBeenCalledTimes(3);

    const libraryCommand = result.current.commandItems.find(
      (item) => item.id === "action:open-library"
    );
    expect(libraryCommand?.label).toBe("Open assistants");
    act(() => result.current.runCommand(libraryCommand!));
    expect(closePalette).toHaveBeenCalledTimes(4);
    expect(openLibrary).not.toHaveBeenCalled();
    await waitFor(() => expect(openLibrary).toHaveBeenCalledOnce());

    const knowledgeCommand = result.current.commandItems.find(
      (item) => item.id === "action:open-knowledge"
    );
    expect(knowledgeCommand?.label).toBe("Open Knowledge");
    act(() => result.current.runCommand(knowledgeCommand!));
    expect(closePalette).toHaveBeenCalledTimes(5);
    expect(openKnowledge).not.toHaveBeenCalled();
    await waitFor(() => expect(openKnowledge).toHaveBeenCalledOnce());
  });
});
