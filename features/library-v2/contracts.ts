import type { AssistantAvatarRecipe } from "@/lib/contracts/assistants";
import type { AssistantUnavailabilityCopy } from "./assistantAvailabilityCopy";
import type { ReactNode } from "react";

export type LibraryTabIdV2 = "assistants" | "knowledge" | "files" | "memory" | "skills";

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
  /** Optional ancestors between the selected section and this resource. */
  trail?: readonly string[];
}>;

export type AssistantSummaryV2 = Readonly<{
  archived: boolean;
  available: boolean;
  /** Immutable identity recipe pinned in the Assistant revision, when known. */
  avatar?: AssistantAvatarRecipe;
  description: string;
  id: string;
  modelLabel?: string | null;
  name: string;
  owned: boolean;
  ownerDisplayName?: string | null;
  pinned?: boolean;
  revision: number;
  unavailable?: AssistantUnavailabilityCopy;
}>;

export type KnowledgeSummaryV2 = Readonly<{
  archived?: boolean;
  description: string;
  sourceCount: number;
  id: string;
  name: string;
  owned: boolean;
  purgeScheduledAt?: string | null;
  /** Exact usability-first status sentence ("Ready · 1 processing"); the status label otherwise. */
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
  /** Display name only; never an account or resource identifier. */
  sharedBy?: string;
  trashed?: boolean;
  trashedAt?: string | null;
}>;

export type FileSummaryV2 = Readonly<{
  canOpenChat: boolean;
  id: string;
  meta: string;
  name: string;
  private: boolean;
  saved: boolean;
  mutation?: "saving" | "saved" | "removing" | "error";
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
