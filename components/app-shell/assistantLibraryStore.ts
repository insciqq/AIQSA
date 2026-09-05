import type {
  AssistantAvailability,
  AssistantListResponse,
  AssistantPublicationView
} from "@/lib/contracts/assistants";
import type {
  AssistantEditorDraftState,
  AssistantEditorFieldErrors,
  LibraryNotice
} from "@/components/assistants/libraryViewContracts";
import { create } from "zustand";

export type AssistantLibraryEditorState = {
  /** Null while creating a new Assistant. */
  assistantId: string | null;
  archived: boolean;
  availability: AssistantAvailability | null;
  baseline: string;
  /** Set after a successful create so `Use in chat` can be offered. */
  createdAssistantId: string | null;
  draft: AssistantEditorDraftState;
  error: { code: string; text: string } | null;
  fieldErrors: AssistantEditorFieldErrors | null;
  expectedVersion: number | null;
  publications: AssistantPublicationView[] | null;
  saving: boolean;
};

export type AssistantLibrarySnapshot = {
  busy: boolean;
  busyRequestId: number;
  mcpOptions: {
    enabled: boolean;
    id: string;
    name: string;
    readiness: import("@/lib/contracts/mcp").McpReadiness;
  }[];
  mcpOptionsRequestId: number;
  data: AssistantListResponse | null;
  dataError: string | null;
  dataState: "error" | "loading" | "ready";
  editor: AssistantLibraryEditorState | null;
  listRequestId: number;
  notice: LibraryNotice | null;
  open: boolean;
  task: "editor" | "list";
};

export type AssistantLibraryStore = AssistantLibrarySnapshot & {
  patch(update: Partial<AssistantLibrarySnapshot>): void;
  patchEditor(update: Partial<AssistantLibraryEditorState>): void;
};

export const initialAssistantLibrarySnapshot: AssistantLibrarySnapshot = {
  busy: false,
  busyRequestId: 0,
  mcpOptions: [],
  mcpOptionsRequestId: 0,
  data: null,
  dataError: null,
  dataState: "loading",
  editor: null,
  listRequestId: 0,
  notice: null,
  open: false,
  task: "list"
};

export const useAssistantLibraryStore = create<AssistantLibraryStore>((set) => ({
  ...initialAssistantLibrarySnapshot,
  patch(update) {
    set(update);
  },
  patchEditor(update) {
    set((state) => (state.editor ? { editor: { ...state.editor, ...update } } : {}));
  }
}));
