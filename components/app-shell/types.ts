import type { WorkspaceChatSummary } from "@/lib/contracts/chats";

export type {
  Catalog,
  CatalogModel,
  CatalogSearchStrategy,
  CatalogSearchStrategyKind,
  ModelParameterControls,
  PromptPreset,
  ReasoningEffort
} from "@/lib/contracts/catalog";

export type {
  ChatDetail,
  ChatSummary,
  ChatUsageStats,
  ThreadArtifactSummary,
  ThreadCitation,
  ThreadMessage,
  ThreadSearchDetail,
  ThreadToolActivity,
  ThreadToolActivityStatus,
  WorkspaceChatSummary
} from "@/lib/contracts/chats";

export type { PersistedRun, RunEventView } from "@/lib/contracts/runs";

export type InspectorMode = "closed" | "overlay" | "pinned";

export type FolderSummary = {
  id: string;
  name: string;
  parentId: string | null;
  projectMemory: string;
  sortOrder: number;
};

export type ChatGroup = {
  chats: WorkspaceChatSummary[];
  depth: number;
  folder: FolderSummary | null;
  name: string;
};

export type ChatContentMatch = {
  chatId: string;
  snippet: string | null;
};

export type Notice = {
  action?: {
    disabled?: boolean;
    label: string;
    onClick(): void;
    tone?: "destructive" | "neutral";
  };
  href?: string;
  kind: "error" | "success";
  persistent?: boolean;
  scope?: "settings";
  text: string;
};
