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
  WorkspaceChatSummary,
  ThreadAssistantIdentity,
  ChatUsageStats,
  ThreadArtifactSummary,
  ThreadCitation,
  ThreadGroundingDisplay,
  ThreadKnowledgeCitation,
  ThreadKnowledgeOutcome,
  ThreadMessage,
  ThreadToolActivity,
  ThreadToolActivityCall,
  ThreadToolBudgetWarning,
  ThreadSearchSource
} from "@/lib/contracts/chats";

export type { RunEventView } from "@/lib/contracts/runs";

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

export type NoticeAction = {
  disabled?: boolean;
  label: string;
  onClick(): void;
  tone?: "destructive" | "neutral";
};

export type Notice = {
  action?: NoticeAction;
  /** Error notices stay until dismissed unless this opts into the standard timeout. */
  autoDismiss?: boolean;
  href?: string;
  kind: "error" | "success";
  persistent?: boolean;
  secondaryAction?: NoticeAction;
  scope?: "settings";
  text: string;
};
