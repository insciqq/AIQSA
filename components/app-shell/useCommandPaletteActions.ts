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
  WorkspaceChatSummary
} from "@/components/app-shell/types";
import { useMemo } from "react";

function searchCommandSubtitle(strategy: CatalogSearchStrategy): string {
  if (strategy.description) {
    return strategy.description;
  }

  if (strategy.kind === "none") {
    return "Search off";
  }

  if (strategy.kind === "gemini_google_search") {
    return "Google Search";
  }

  if (strategy.kind === "perplexity_tool_search") {
    return "Perplexity Search";
  }

  return "Web search";
}

type CommandPaletteActionsInput = {
  activateChat(chat: WorkspaceChatSummary): void;
  activateBlankWorkspace(
    folderId?: string | null,
    memoryMode?: "EXCLUDED" | "NORMAL" | "TEMPORARY"
  ): void;
  activeChatId: string | null;
  assistantLibraryOpen: boolean;
  branchesOpen: boolean;
  catalog: Catalog | null;
  chatGroups: ChatGroup[];
  chats: WorkspaceChatSummary[];
  closePalette(): void;
  knowledgeOpen: boolean;
  memoryOpen: boolean;
  openKnowledge(): void;
  openLibrary(): void;
  openMemory(): void;
  openSettings(): void;
  searchOptions: CatalogSearchStrategy[];
  selectModel(model: CatalogModel): void;
  selectSearchStrategy(strategyId: string): void;
  selectedModelId: string;
  selectedProvider: string;
  selectedSearchOptionIds: readonly string[];
  settingsOpen: boolean;
  toggleBranches(): void;
  workspaceReady: boolean;
};

export function useCommandPaletteActions({
  activateChat,
  activateBlankWorkspace,
  activeChatId,
  assistantLibraryOpen,
  branchesOpen,
  catalog,
  chatGroups,
  chats,
  closePalette,
  knowledgeOpen,
  memoryOpen,
  openKnowledge,
  openLibrary,
  openMemory,
  openSettings,
  searchOptions,
  selectModel,
  selectSearchStrategy,
  selectedModelId,
  selectedProvider,
  selectedSearchOptionIds,
  settingsOpen,
  toggleBranches,
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
        current: branchesOpen,
        id: "action:toggle-branches",
        kind: "action",
        keywords: ["branches", "versions", "history"],
        label: branchesOpen ? "Close Branches" : "Open Branches",
        subtitle: "Conversation history"
      },
      {
        current: settingsOpen,
        id: "action:open-settings",
        kind: "action",
        keywords: ["settings", "appearance", "mcp", "tools"],
        label: "Open settings",
        subtitle: "Settings"
      },
      {
        current: assistantLibraryOpen,
        id: "action:open-library",
        kind: "action",
        keywords: ["library", "assistants", "assistant", "use an assistant"],
        label: "Open assistants",
        subtitle: "Reusable run setups"
      },
      {
        current: knowledgeOpen,
        id: "action:open-knowledge",
        kind: "action",
        keywords: ["knowledge", "bases", "documents", "retrieval", "library"],
        label: "Open Knowledge",
        subtitle: "Retrieval bases and documents"
      },
      {
        current: memoryOpen,
        id: "action:open-memory",
        kind: "action",
        keywords: ["memory", "remember", "saved", "personalization", "evidence"],
        label: "Open Memory",
        subtitle: "Saved context and controls"
      }
    );

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

    for (const strategy of searchOptions) {
      items.push({
        current: strategy.kind === "none"
          ? selectedSearchOptionIds.length === 0
          : selectedSearchOptionIds.includes(strategy.strategyId),
        id: `search:${strategy.strategyId}`,
        kind: "search",
        keywords: [strategy.kind, strategy.strategyId],
        label: strategy.displayName,
        subtitle: searchCommandSubtitle(strategy)
      });
    }

    return items;
  }, [
    activeChatId,
    assistantLibraryOpen,
    branchesOpen,
    catalog,
    chatGroups,
    knowledgeOpen,
    memoryOpen,
    searchOptions,
    selectedModelId,
    selectedProvider,
    selectedSearchOptionIds,
    settingsOpen,
    workspaceReady
  ]);

  function runCommand(item: CommandItem) {
    if (item.id === "action:toggle-branches") {
      closePalette();
      window.setTimeout(toggleBranches, 0);
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

    if (item.id === "action:open-library") {
      closePalette();
      window.setTimeout(openLibrary, 0);
      return;
    }

    if (item.id === "action:open-knowledge") {
      closePalette();
      window.setTimeout(openKnowledge, 0);
      return;
    }

    if (item.id === "action:open-memory") {
      closePalette();
      window.setTimeout(openMemory, 0);
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
