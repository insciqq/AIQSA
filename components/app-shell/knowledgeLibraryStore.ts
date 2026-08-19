import type {
  KnowledgeCreateDraft,
  KnowledgeLibraryFilter,
  KnowledgeLibraryNotice
} from "@/components/knowledge/libraryViewContracts";
import type {
  KnowledgeBaseDetail,
  KnowledgeBaseListResponse,
  KnowledgeSourceDetail,
  KnowledgeSourceFilter,
  KnowledgeSourceListResponse
} from "@/lib/contracts/knowledge";
import type { KnowledgeUploadBatch } from "@/lib/contracts/knowledgeUploads";
import { create } from "zustand";

export type KnowledgeCreateState = {
  baseline: string;
  draft: KnowledgeCreateDraft;
  error: { code: string; text: string } | null;
  progress: { current: number; fileName: string; total: number } | null;
  saving: boolean;
};

export type KnowledgeDetailState = {
  actionId: string | null;
  base: KnowledgeBaseDetail | null;
  baseId: string;
  baseline: string;
  dataError: string | null;
  dataState: "error" | "loading" | "ready";
  sourcePage: number;
  sourceQuery: string;
  draft: { description: string; name: string };
  error: { code: string; text: string } | null;
  requestId: number;
  sources: KnowledgeSourceListResponse | null;
  uploadBatches: KnowledgeUploadBatch[];
  uploadErrors: Record<string, string>;
  uploadProgress: Record<string, number>;
};

export type KnowledgeSourceDetailState = {
  actionId: string | null;
  baseline: string;
  dataError: string | null;
  dataState: "error" | "loading" | "ready";
  draft: { description: string; name: string; tags: string };
  error: { code: string; text: string } | null;
  requestId: number;
  returnBaseId: string | null;
  source: KnowledgeSourceDetail | null;
  sourceId: string;
};

export type KnowledgeLibrarySnapshot = {
  busy: boolean;
  catalog: "bases" | "sources";
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
  sourceData: KnowledgeSourceListResponse | null;
  sourceDataError: string | null;
  sourceDataState: "error" | "loading" | "ready";
  sourceDetail: KnowledgeSourceDetailState | null;
  sourceFilter: KnowledgeSourceFilter;
  sourceListRequestId: number;
  sourcePage: number;
  sourceQuery: string;
  task: "create" | "detail" | "list" | "source-detail";
};

export type KnowledgeLibraryStore = KnowledgeLibrarySnapshot & {
  patch(update: Partial<KnowledgeLibrarySnapshot>): void;
  patchCreate(update: Partial<KnowledgeCreateState>): void;
  patchDetail(update: Partial<KnowledgeDetailState>): void;
  patchSourceDetail(update: Partial<KnowledgeSourceDetailState>): void;
};

export const initialKnowledgeLibrarySnapshot: KnowledgeLibrarySnapshot = {
  busy: false,
  catalog: "bases",
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
  sourceData: null,
  sourceDataError: null,
  sourceDataState: "loading",
  sourceDetail: null,
  sourceFilter: "all",
  sourceListRequestId: 0,
  sourcePage: 1,
  sourceQuery: "",
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
  },
  patchSourceDetail(update) {
    set((state) => (
      state.sourceDetail ? { sourceDetail: { ...state.sourceDetail, ...update } } : {}
    ));
  }
}));
