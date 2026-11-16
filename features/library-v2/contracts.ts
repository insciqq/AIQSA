import type { AttachmentPreviewKind } from "@/lib/contracts/uploads";
import type { ReactNode } from "react";

/**
 * A section of the Settings surface. The ids keep their `library` names
 * (`?library=<id>` addresses, stored preferences); only the words changed.
 */
export type LibraryTabIdV2 = "general" | "account" | "data" |
  "assistants" | "instructions" | "skills" | "subagents" | "scheduled" | "defaults" |
  "memory" | "files" | "artifacts" |
  "mcp" | "secrets" | "proxies" |
  "computers" | "telegram" | "apps";

export type StudioNavigationV2 = Readonly<{
  tab: LibraryTabIdV2;
  busy: boolean;
  /**
   * Where a section is not beside the list of sections (narrow and short
   * screens), true while the section shows instead of the list. Wide
   * layouts ignore it.
   */
  sectionShown: boolean;
  /**
   * Opens Settings from outside it: a named section shows that section, and
   * no name (the gear) opens the last visited section beside the list, or
   * the list itself where they do not fit side by side.
   */
  open(tab?: LibraryTabIdV2, afterSelect?: () => void): void;
  /** Changes the section from inside Settings; the list or section stays as it was shown. */
  select(tab: LibraryTabIdV2, afterSelect?: () => void): void;
  /** Shows the selected section (true) or the list of sections (false) where they do not fit side by side. */
  showSection(shown: boolean): void;
  exit(proceed?: () => void): void;
  registerGuard(guard: ((proceed: () => void) => void) | null, busy: boolean): void;
}>;

export type LibraryNavigationIntentV2 =
  | Readonly<{ from: LibraryTabIdV2; kind: "exit" }>
  | Readonly<{ from: LibraryTabIdV2; kind: "tab"; to: LibraryTabIdV2 }>;

/**
 * The selected Settings section is presentation state. Dirty/busy decisions remain
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
 * editor, an artifact, archived chats). Settings shows it in the crumb and replaces
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
