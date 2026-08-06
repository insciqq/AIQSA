import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Catalog, ChatSummary, InspectorMode } from "./types";
import { useCommandPaletteActions } from "./useCommandPaletteActions";

function renderActions(mode: InspectorMode, pinningAvailable = false, workspaceReady = true) {
  const setInspectorMode = vi.fn();
  const closePalette = vi.fn();
  const openLibrary = vi.fn();
  const openSettings = vi.fn();
  const { result } = renderHook(() =>
    useCommandPaletteActions({
      activateChat: vi.fn(),
      activateBlankWorkspace: vi.fn(),
      activeChatId: null,
      catalog: null,
      chatGroups: [],
      chats: [],
      changeInspectorMode: setInspectorMode,
      closePalette,
      inspectorMode: mode,
      inspectorPinningAvailable: pinningAvailable,
      openLibrary,
      openSettings,
      searchOptions: [],
      selectModel: vi.fn(),
      selectSearchStrategy: vi.fn(),
      selectedModelId: "test-model",
      selectedProvider: "test-provider",
      selectedSearchStrategy: "search-disabled",
      settingsOpen: false,
      workspaceReady
    })
  );

  return { closePalette, openLibrary, openSettings, result, setInspectorMode };
}

describe("useCommandPaletteActions", () => {
  it("closes the palette before opening Details as an overlay", async () => {
    const { closePalette, result, setInspectorMode } = renderActions("closed");
    const detailsCommand = result.current.commandItems.find((item) => item.id === "action:toggle-inspector");

    expect(detailsCommand?.label).toBe("Open details");
    expect(result.current.commandItems.some((item) => item.id.includes("compact"))).toBe(false);
    act(() => result.current.runCommand(detailsCommand!));

    expect(closePalette).toHaveBeenCalledOnce();
    expect(setInspectorMode).not.toHaveBeenCalled();
    await waitFor(() => expect(setInspectorMode).toHaveBeenCalledOnce());
    const update = setInspectorMode.mock.calls[0]?.[0] as (mode: InspectorMode) => InspectorMode;
    expect(update("closed")).toBe("overlay");
  });

  it("offers pin and unpin only when pinning is available and Details is open", () => {
    const overlay = renderActions("overlay", true);
    const pinCommand = overlay.result.current.commandItems.find((item) => item.id === "action:pin-inspector");
    expect(pinCommand?.label).toBe("Pin details");

    act(() => overlay.result.current.runCommand(pinCommand!));
    const pinUpdate = overlay.setInspectorMode.mock.calls[0]?.[0] as (mode: InspectorMode) => InspectorMode;
    expect(pinUpdate("overlay")).toBe("pinned");

    const pinned = renderActions("pinned", true);
    expect(pinned.result.current.commandItems.find((item) => item.id === "action:pin-inspector")?.label).toBe(
      "Unpin details"
    );
    expect(renderActions("overlay", false).result.current.commandItems).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "action:pin-inspector" })])
    );
  });

  it("closes the palette before opening Settings on the next task", async () => {
    const { closePalette, openSettings, result } = renderActions("closed");
    const settingsCommand = result.current.commandItems.find((item) => item.id === "action:open-settings");

    act(() => result.current.runCommand(settingsCommand!));

    expect(closePalette).toHaveBeenCalledOnce();
    expect(openSettings).not.toHaveBeenCalled();
    await waitFor(() => expect(openSettings).toHaveBeenCalledOnce());
  });

  it("omits New chat until workspace hydration succeeds", () => {
    expect(renderActions("closed", false, false).result.current.commandItems).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "action:new-chat" })])
    );
    expect(renderActions("closed").result.current.commandItems).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "action:new-chat" })])
    );
  });

  it("builds and dispatches every searchable category with readable non-id subtitles", async () => {
    const chat: ChatSummary = {
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
        modelId: "gpt-5.5",
        provider: "openai",
        searchStrategyId: "openai-native-web-search",
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
    const selectSearchStrategy = vi.fn();
    const closePalette = vi.fn();
    const { result } = renderHook(() =>
      useCommandPaletteActions({
        activateChat,
        activateBlankWorkspace: vi.fn(),
        activeChatId: chat.id,
        catalog,
        chatGroups: [{ chats: [chat], depth: 0, folder: null, name: "No folder" }],
        chats: [chat],
        changeInspectorMode: vi.fn(),
        closePalette,
        inspectorMode: "closed",
        inspectorPinningAvailable: false,
        openLibrary,
        openSettings: vi.fn(),
        searchOptions: catalog.searchStrategies,
        selectModel,
        selectSearchStrategy,
        selectedModelId: "gpt-5.5",
        selectedProvider: "openai",
        selectedSearchStrategy: "openai-native-web-search",
        settingsOpen: false,
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
  });
});
