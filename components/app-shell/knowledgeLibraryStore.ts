import type {
  KnowledgeCreateDraft,
  KnowledgeLibraryFilter,
  KnowledgeLibraryNotice
} from "@/components/knowledge/libraryViewContracts";
import type {
  KnowledgeBaseDetail,
  KnowledgeBaseListResponse,
  KnowledgeIngestionStatusResponse
} from "@/lib/contracts/knowledge";
import { create } from "zustand";

export type KnowledgeCreateState = {
  baseline: string;
  draft: KnowledgeCreateDraft;
  error: { code: string; text: string } | null;
  saving: boolean;
};

export type KnowledgeDetailState = {
  actionId: string | null;
  base: KnowledgeBaseDetail | null;
  baseId: string;
  baseline: string;
  dataError: string | null;
  dataState: "error" | "loading" | "ready";
  documentPage: number;
  documentQuery: string;
  draft: { description: string; name: string };
  error: { code: string; text: string } | null;
  ingestion: KnowledgeIngestionStatusResponse | null;
  requestId: number;
  upload: { current: number; fileName: string; total: number } | null;
};

export type KnowledgeLibrarySnapshot = {
  busy: boolean;
  data: KnowledgeBaseListResponse | null;
  dataError: string | null;
  dataState: "error" | "loading" | "ready";
  create: KnowledgeCreateState | null;
  detail: KnowledgeDetailState | null;
  filter: KnowledgeLibraryFilter;
  listRequestId: number;
  notice: KnowledgeLibraryNotice | null;
  open: boolean;
  operationRequestId: number;
  query: string;
  task: "create" | "detail" | "list";
};

export type KnowledgeLibraryStore = KnowledgeLibrarySnapshot & {
  patch(update: Partial<KnowledgeLibrarySnapshot>): void;
  patchCreate(update: Partial<KnowledgeCreateState>): void;
  patchDetail(update: Partial<KnowledgeDetailState>): void;
};

export const initialKnowledgeLibrarySnapshot: KnowledgeLibrarySnapshot = {
  busy: false,
  create: null,
  data: null,
  dataError: null,
  dataState: "loading",
  detail: null,
  filter: "all",
  listRequestId: 0,
  notice: null,
  open: false,
  operationRequestId: 0,
  query: "",
  task: "list"
};

export const useKnowledgeLibraryStore = create<KnowledgeLibraryStore>((set) => ({
  ...initialKnowledgeLibrarySnapshot,
  patch(update) {
    set(update);
  },
  patchCreate(update) {
    set((state) => (state.create ? { create: { ...state.create, ...update } } : {}));
  },
  patchDetail(update) {
    set((state) => (state.detail ? { detail: { ...state.detail, ...update } } : {}));
  }
}));
