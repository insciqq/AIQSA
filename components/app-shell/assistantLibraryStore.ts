import type {
  AssistantListResponse,
  AssistantPublicationView,
  AssistantRevisionContent,
  AssistantRevisionHistoryEntry
} from "@/lib/contracts/assistants";
import type {
  AssistantEditorDraftState,
  LibraryFilter,
  LibraryMode,
  LibraryNotice
} from "@/components/assistants/libraryViewContracts";
import { create } from "zustand";

export type AssistantLibraryEditorState = {
  /** Null while creating a new Assistant. */
  assistantId: string | null;
  baseline: string;
  /** Set after a successful create so `Use in chat` can be offered. */
  createdAssistantId: string | null;
  draft: AssistantEditorDraftState;
  error: { code: string; text: string } | null;
  expectedVersion: number | null;
  publications: AssistantPublicationView[] | null;
  revisionNumber: number | null;
  saving: boolean;
};

export type AssistantLibraryHistoryState = {
  assistantId: string;
  assistantName: string;
  entries: AssistantRevisionHistoryEntry[];
  loading: boolean;
  restoring: boolean;
  viewedRevision: AssistantRevisionContent | null;
};

export type AssistantLibrarySnapshot = {
  busy: boolean;
  mcpOptions: { id: string; name: string }[];
  category: import("@/lib/contracts/assistants").AssistantCategory | null;
  data: AssistantListResponse | null;
  dataError: string | null;
  dataState: "error" | "loading" | "ready";
  editor: AssistantLibraryEditorState | null;
  filter: LibraryFilter;
  history: AssistantLibraryHistoryState | null;
  mode: LibraryMode;
  notice: LibraryNotice | null;
  open: boolean;
  query: string;
  task: "editor" | "history" | "list";
};

export type AssistantLibraryStore = AssistantLibrarySnapshot & {
  patch(update: Partial<AssistantLibrarySnapshot>): void;
  patchEditor(update: Partial<AssistantLibraryEditorState>): void;
  patchHistory(update: Partial<AssistantLibraryHistoryState>): void;
};

export const initialAssistantLibrarySnapshot: AssistantLibrarySnapshot = {
  busy: false,
  mcpOptions: [],
  category: null,
  data: null,
  dataError: null,
  dataState: "loading",
  editor: null,
  filter: "all",
  history: null,
  mode: "discover",
  notice: null,
  open: false,
  query: "",
  task: "list"
};

export const useAssistantLibraryStore = create<AssistantLibraryStore>((set) => ({
  ...initialAssistantLibrarySnapshot,
  patch(update) {
    set(update);
  },
  patchEditor(update) {
    set((state) => (state.editor ? { editor: { ...state.editor, ...update } } : {}));
  },
  patchHistory(update) {
    set((state) => (state.history ? { history: { ...state.history, ...update } } : {}));
  }
}));

export function resetAssistantLibraryStoreForTest() {
  useAssistantLibraryStore.setState({ ...initialAssistantLibrarySnapshot });
}
