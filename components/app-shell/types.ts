import type { WorkspaceChatSummary } from "@/lib/contracts/chats";
import type { KnowledgePlan } from "@/lib/contracts/knowledge";

export type {
  Catalog,
  CatalogModel,
  CatalogSearchStrategy,
  CatalogSearchStrategyKind,
  ModelParameterControls,
  ReasoningEffort
} from "@/lib/contracts/catalog";

export type {
  ChatDetail,
  ChatContextStats,
  ChatSummary,
  ThreadAssistantIdentity,
  ChatUsageStats,
  ThreadArtifactSummary,
  ThreadCitation,
  ThreadGroundingDisplay,
  ThreadKnowledgeCitation,
  ThreadKnowledgeOutcome,
  ThreadMessage,
  ThreadRunUsage,
  ThreadSearchActivity,
  ThreadSearchActivityStatus,
  ThreadSearchExecution,
  ThreadSearchOperation,
  ThreadSearchProviderOperation,
  ThreadSearchSource,
  ThreadToolActivity,
  ThreadToolActivityStatus,
  WorkspaceChatSummary
} from "@/lib/contracts/chats";

export type { PersistedRun, RunEventView } from "@/lib/contracts/runs";

export type InspectorMode = "closed" | "overlay" | "pinned";

export type FolderSummary = {
  defaultKnowledgePlan?: KnowledgePlan | null;
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
