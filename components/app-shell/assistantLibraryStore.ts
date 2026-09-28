import type {
  AssistantAvailability,
  AssistantDetail,
  AssistantListResponse,
  AssistantRowAvailability,
  AssistantRowKey
} from "@/lib/contracts/assistants";
import type { AssistantDeletionConsequences } from "@/lib/contracts/assistantDeletion";
import type {
  AssistantEditorConflict,
  AssistantEditorDraft,
  AssistantEditorErrors,
  AssistantSharingDraft,
  AssistantSharingFailure,
  LibraryNotice
} from "@/components/assistants/libraryViewContracts";
import type { McpReadiness } from "@/lib/contracts/mcp";
import { create } from "zustand";

export type AssistantLibraryEditorState = {
  /** Null while creating a new Assistant. */
  assistantId: string | null;
  archived: boolean;
  availability: AssistantAvailability | null;
  baseline: string;
  conflict: AssistantEditorConflict | null;
  /** Set after a successful create so `Use in chat` can be offered. */
  createdAssistantId: string | null;
  draft: AssistantEditorDraft;
  error: { code: string; text: string } | null;
  errors: AssistantEditorErrors | null;
  expectedVersion: number | null;
  initialExpandedRow: AssistantRowKey | null;
  rowAvailability: AssistantRowAvailability;
  selectedSkills: { id: string; name: string; available?: boolean }[];
  /** The last saved name; null while creating. */
  savedName: string | null;
  saving: boolean;
};

export type AssistantDetailSheetState = {
  assistantId: string;
  detail: AssistantDetail | null;
  error: string | null;
  requestId: number;
  state: "error" | "loading" | "ready" | "unavailable";
};

export type AssistantDeletionState = {
  assistantId: string;
  consequences: AssistantDeletionConsequences | null;
  error: string | null;
  name: string;
  requestId: number;
  state: "deleting" | "error" | "loading" | "ready";
};

export type AssistantSharingState = {
  assistantId: string;
  baseline: string;
  detail: AssistantDetail | null;
  draft: AssistantSharingDraft;
  error: string | null;
  failures: AssistantSharingFailure[];
  requestId: number;
  saving: boolean;
  state: "error" | "loading" | "ready";
  withdrawing: boolean;
};

export type AssistantLibrarySnapshot = {
  busy: boolean;
  busyRequestId: number;
  mcpOptions: {
    enabled: boolean;
    id: string;
    name: string;
    readiness: McpReadiness;
  }[];
  mcpOptionsRequestId: number;
  data: AssistantListResponse | null;
  dataError: string | null;
  dataState: "error" | "loading" | "ready";
  deletion: AssistantDeletionState | null;
  /** The detail sheet over the gallery. */
  detail: AssistantDetailSheetState | null;
  editor: AssistantLibraryEditorState | null;
  listRequestId: number;
  /** The New assistant sheet (Blank, templates, From current chat). */
  newAssistantOpen: boolean;
  notice: LibraryNotice | null;
  open: boolean;
  /** Source of request ids for the sheets, so a stale response never lands. */
  sheetRequestId: number;
  sharing: AssistantSharingState | null;
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
  deletion: null,
  detail: null,
  editor: null,
  listRequestId: 0,
  newAssistantOpen: false,
  notice: null,
  open: false,
  sheetRequestId: 0,
  sharing: null,
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

/** Reserves a request id for a sheet load or mutation. */
export function nextAssistantSheetRequestId(): number {
  const requestId = useAssistantLibraryStore.getState().sheetRequestId + 1;
  useAssistantLibraryStore.getState().patch({ sheetRequestId: requestId });
  return requestId;
}
