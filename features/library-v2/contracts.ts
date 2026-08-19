import type { ReactNode } from "react";

export type LibraryTabIdV2 = "assistants" | "knowledge" | "files" | "memory";

export type LibraryNavigationIntentV2 =
  | Readonly<{ from: LibraryTabIdV2; kind: "exit" }>
  | Readonly<{ from: LibraryTabIdV2; kind: "tab"; to: LibraryTabIdV2 }>;

/**
 * The selected Library tab is presentation state. Dirty/busy decisions remain
 * with the focused resource owner, which may call `proceed` after its own
 * confirmation or mutation settles.
 */
export type LibraryNavigationGuardV2 = (
  intent: LibraryNavigationIntentV2,
  proceed: () => void
) => void;

export type LibraryTabV2 = Readonly<{
  content: ReactNode;
  id: LibraryTabIdV2;
  label: string;
}>;

export type AssistantSummaryV2 = Readonly<{
  archived: boolean;
  available: boolean;
  description: string;
  id: string;
  name: string;
  owned: boolean;
  pinned?: boolean;
  revision: number;
  unavailableReason?: string;
}>;

export type KnowledgeSummaryV2 = Readonly<{
  description: string;
  sourceCount: number;
  id: string;
  name: string;
  owned: boolean;
  status: "archived" | "indexing" | "ready" | "unavailable";
}>;

export type FileSummaryV2 = Readonly<{
  id: string;
  meta: string;
  name: string;
  private: boolean;
  status: "failed" | "processing" | "ready";
}>;

export type MemoryFactSummaryV2 = Readonly<{
  id: string;
  pinned?: boolean;
  scope: string;
  statement: string;
}>;

export type MemoryOverviewV2 = Readonly<{
  administratorDisabled: boolean;
  automaticLearning: boolean;
  disabledReason?: string;
  explicitCrudAvailable: boolean;
  facts: readonly MemoryFactSummaryV2[];
  healthDetail: string;
  healthLabel: string;
  referenceChatHistory: boolean;
  useMemoryFacts: boolean;
}>;
