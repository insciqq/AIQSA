import type { CommandItem } from "@/components/command-palette/commandItems";
import {
  modelCapabilityDescription,
  modelCapabilityLabel
} from "@/components/app-shell/shellFormatting";
import type {
  Catalog,
  CatalogModel,
  CatalogSearchStrategy,
  ChatGroup,
  ChatSummary,
  InspectorMode
} from "@/components/app-shell/types";
import type { Dispatch, SetStateAction } from "react";
import { useMemo } from "react";

function searchCommandSubtitle(kind: string): string {
  if (kind === "none") {
    return "Search off";
  }

  if (kind === "openai_native_web_search") {
    return "Provider-native web search";
  }

  if (kind === "perplexity_tool_search") {
    return "Answer-model tool search";
  }

  return "Search strategy";
}

type CommandPaletteActionsInput = {
  activateChat(chat: ChatSummary): void;
  activateBlankWorkspace(folderId?: string | null): void;
  activeChatId: string | null;
  catalog: Catalog | null;
  chatGroups: ChatGroup[];
  chats: ChatSummary[];
  changeInspectorMode: Dispatch<SetStateAction<InspectorMode>>;
  closePalette(): void;
  inspectorMode: InspectorMode;
  inspectorPinningAvailable: boolean;
  openSettings(): void;
  searchOptions: CatalogSearchStrategy[];
  selectModel(model: CatalogModel): void;
  selectPrompt(promptId: string): void;
  selectSearchStrategy(strategyId: string): void;
  selectedModelId: string;
  selectedPromptId: string | null;
  selectedProvider: string;
  selectedSearchStrategy: string;
  settingsOpen: boolean;
  workspaceReady: boolean;
};

export function useCommandPaletteActions({
  activateChat,
  activateBlankWorkspace,
  activeChatId,
  catalog,
  chatGroups,
  chats,
  changeInspectorMode,
  closePalette,
  inspectorMode,
  inspectorPinningAvailable,
  openSettings,
  searchOptions,
  selectModel,
  selectPrompt,
  selectSearchStrategy,
  selectedModelId,
  selectedPromptId,
  selectedProvider,
  selectedSearchStrategy,
  settingsOpen,
  workspaceReady
}: CommandPaletteActionsInput) {
  const commandItems = useMemo<CommandItem[]>(() => {
    const items: CommandItem[] = [];
    if (workspaceReady) {
      items.push({
        current: activeChatId === null,
        id: "action:new-chat",
        kind: "action",
        keywords: ["new", "chat", "workspace"],
        label: "New chat",
        subtitle: "Workspace"
      });
    }
    items.push(
      {
        current: inspectorMode !== "closed",
        id: "action:toggle-inspector",
        kind: "action",
        keywords: ["right", "panel", "details"],
        label: inspectorMode === "closed" ? "Open details" : "Close details",
        subtitle: "Details"
      },
      {
        current: settingsOpen,
        id: "action:open-settings",
        kind: "action",
        keywords: ["settings", "prompts", "prompt manager"],
        label: "Open settings",
        subtitle: "Settings"
      }
    );

    if (inspectorPinningAvailable && inspectorMode !== "closed") {
      const settingsIndex = items.findIndex((item) => item.id === "action:open-settings");
      items.splice(settingsIndex, 0, {
        current: inspectorMode === "pinned",
        id: "action:pin-inspector",
        kind: "action",
        keywords: ["right", "panel", "details", "pin"],
        label: inspectorMode === "pinned" ? "Unpin details" : "Pin details",
        subtitle: "Details"
      });
    }

    for (const group of chatGroups) {
      for (const chat of group.chats) {
        items.push({
          current: chat.id === activeChatId,
          id: `chat:${chat.id}`,
          kind: "chat",
          keywords: [group.name, chat.defaultProvider, chat.defaultModelId],
          label: chat.title,
          subtitle: group.name
        });
      }
    }

    for (const model of catalog?.models ?? []) {
      const provider = catalog?.providers.find((candidate) => candidate.id === model.provider);
      const providerName = provider?.name ?? "Model";
      items.push({
        current: model.provider === selectedProvider && model.modelId === selectedModelId,
        id: `model:${model.provider}:${model.modelId}`,
        kind: "model",
        keywords: [
          model.provider,
          provider?.family ?? "",
          model.providerFamily ?? "",
          model.modelId,
          model.upstreamModelId ?? "",
          modelCapabilityLabel(model),
          modelCapabilityDescription(model),
          ...model.searchStrategyIds
        ],
        label: model.displayName,
        subtitle: `${providerName} · ${modelCapabilityDescription(model)}`
      });
    }

    for (const prompt of catalog?.promptPresets ?? []) {
      items.push({
        current: prompt.id === selectedPromptId,
        id: `prompt:${prompt.id}`,
        kind: "prompt",
        keywords: [prompt.name, prompt.systemPrompt, prompt.developerPrompt ?? "", prompt.isDefault ? "default" : ""],
        label: prompt.name,
        subtitle: prompt.isDefault ? "Default prompt" : "Prompt preset"
      });
    }

    for (const strategy of searchOptions) {
      items.push({
        current: strategy.strategyId === selectedSearchStrategy,
        id: `search:${strategy.strategyId}`,
        kind: "search",
        keywords: [strategy.kind, strategy.strategyId],
        label: strategy.displayName,
        subtitle: searchCommandSubtitle(strategy.kind)
      });
    }

    return items;
  }, [
    activeChatId,
    catalog,
    chatGroups,
    inspectorMode,
    inspectorPinningAvailable,
    searchOptions,
    selectedModelId,
    selectedPromptId,
    selectedProvider,
    selectedSearchStrategy,
    settingsOpen,
    workspaceReady
  ]);

  function runCommand(item: CommandItem) {
    if (item.id === "action:toggle-inspector") {
      closePalette();
      window.setTimeout(
        () => changeInspectorMode((mode) => (mode === "closed" ? "overlay" : "closed")),
        0
      );
      return;
    }

    if (item.id === "action:pin-inspector" && inspectorPinningAvailable) {
      changeInspectorMode((mode) => (mode === "pinned" ? "overlay" : "pinned"));
      closePalette();
      return;
    }

    if (item.id === "action:open-settings") {
      closePalette();
      window.setTimeout(openSettings, 0);
      return;
    }

    if (item.id === "action:new-chat" && workspaceReady) {
      activateBlankWorkspace();
      closePalette();
      return;
    }

    if (item.kind === "chat" && item.id.startsWith("chat:")) {
      const chat = chats.find((candidate) => candidate.id === item.id.slice("chat:".length));
      if (chat) {
        activateChat(chat);
      }
      closePalette();
      return;
    }

    if (item.kind === "model" && item.id.startsWith("model:")) {
      const [, provider, ...modelIdParts] = item.id.split(":");
      const modelId = modelIdParts.join(":");
      const model = catalog?.models.find((candidate) => candidate.provider === provider && candidate.modelId === modelId);
      if (model) {
        selectModel(model);
      }
      closePalette();
      return;
    }

    if (item.kind === "prompt" && item.id.startsWith("prompt:")) {
      selectPrompt(item.id.slice("prompt:".length));
      closePalette();
      return;
    }

    if (item.kind === "search" && item.id.startsWith("search:")) {
      selectSearchStrategy(item.id.slice("search:".length));
      closePalette();
    }
  }

  return {
    commandItems,
    runCommand
  };
}
