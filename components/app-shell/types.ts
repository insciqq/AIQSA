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
  ThreadGroundingDisplay,
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

export type NoticeAction = {
  disabled?: boolean;
  label: string;
  onClick(): void;
  tone?: "destructive" | "neutral";
};

export type Notice = {
  action?: NoticeAction;
  href?: string;
  kind: "error" | "success";
  persistent?: boolean;
  secondaryAction?: NoticeAction;
  scope?: "settings";
  text: string;
};
