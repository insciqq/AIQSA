import type { AssistantAvatarRecipe } from "@/lib/contracts/assistants";
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

/**
 * A resource sub-view open inside the selected section (a Knowledge base,
 * the Sources catalog). The Library shows it in the crumb and replaces
 * "Back to chat" with the sub-view's own Back control; a `key` change moves
 * focus to that control.
 */
export type LibrarySubviewV2 = Readonly<{
  backLabel: string;
  busy?: boolean;
  key: string;
  label: string;
  onBack(): void;
}>;

export type AssistantSummaryV2 = Readonly<{
  archived: boolean;
  available: boolean;
  /** Immutable identity recipe pinned in the Assistant revision, when known. */
  avatar?: AssistantAvatarRecipe;
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
  /** Exact readiness sentence ("1 ready · 1 processing"); the status label otherwise. */
  readinessLabel?: string;
  /** Formatted last-update time, when known. */
  updatedLabel?: string;
  status:
    | "archived"
    | "empty"
    | "needs_attention"
    | "processing"
    | "ready"
    | "trashed"
    | "unavailable";
}>;

export type FileSummaryV2 = Readonly<{
  id: string;
  meta: string;
  name: string;
  private: boolean;
  status: "failed" | "processing" | "ready";
}>;

export type MemoryOverviewV2 = Readonly<{
  administratorDisabled: boolean;
  automaticLearning: boolean;
  disabledReason?: string;
  explicitCrudAvailable: boolean;
  loadState: "error" | "idle" | "loading" | "ready";
  referenceChatHistory: boolean;
  status: "NEEDS_ADMIN_SETUP" | "ON" | "PAUSED" | "PREPARING" | "UNAVAILABLE" | null;
  useMemoryFacts: boolean;
}>;
