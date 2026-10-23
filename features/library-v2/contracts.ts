import type { AttachmentPreviewKind } from "@/lib/contracts/uploads";
import type { ReactNode } from "react";

export type LibraryTabIdV2 = "assistants" | "instructions" | "skills" | "memory" | "files" | "artifacts" | "mcp" | "secrets" | "scheduled" | "defaults";

export type StudioNavigationV2 = Readonly<{
  tab: LibraryTabIdV2;
  busy: boolean;
  open(tab?: LibraryTabIdV2, afterSelect?: () => void): void;
  exit(proceed?: () => void): void;
  registerGuard(guard: ((proceed: () => void) => void) | null, busy: boolean): void;
}>;

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
  /** The section's owner reports something the user must act on; the tab shows a warn signal. */
  attention?: boolean;
  content: ReactNode;
  id: LibraryTabIdV2;
  label: string;
}>;

/**
 * A resource sub-view open inside the selected section (an Assistant's
 * editor, an artifact). The Library shows it in the crumb and replaces
 * "Back to chat" with the sub-view's own Back control; a `key` change moves
 * focus to that control unless the resource owns its editor/row focus.
 */
export type LibrarySubviewV2 = Readonly<{
  backLabel: string;
  busy?: boolean;
  focus?: "resource";
  key: string;
  label: string;
  onBack(): void;
  /** Optional ancestors between the selected section and this resource. */
  trail?: readonly string[];
}>;

export type FileSummaryV2 = Readonly<{
  byteSize: number;
  canOpenChat: boolean;
  chatId: string | null;
  chatTitle: string | null;
  createdAt: string;
  id: string;
  name: string;
  savedAt: string | null;
  previewKind: AttachmentPreviewKind;
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
