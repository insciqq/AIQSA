import type {
  KnowledgeBaseDetail,
  KnowledgeBaseListResponse,
  KnowledgeBasePublicationInput,
  KnowledgeBaseSummary,
  KnowledgeSourceDetail,
  KnowledgeSourceFilter,
  KnowledgeSourceListResponse
} from "@/lib/contracts/knowledge";
import type { KnowledgeUploadBatch } from "@/lib/contracts/knowledgeUploads";

export type KnowledgeLibraryNotice = {
  kind: "error" | "success";
  text: string;
};

export type KnowledgeLibraryFilter = "all" | "archived" | "shared" | "trash" | "yours";

export type KnowledgeCreateDraft = {
  description: string;
  files: File[];
  name: string;
};

export type KnowledgeCreateView = {
  dirty: boolean;
  draft: KnowledgeCreateDraft;
  error: { code: string; text: string } | null;
  maxUploadBytes: number;
  onCancel(): void;
  onChange(update: Partial<KnowledgeCreateDraft>): void;
  onSave(): void;
  progress: { current: number; fileName: string; total: number } | null;
  saving: boolean;
};

export type KnowledgeDetailView = {
  actionId: string | null;
  base: KnowledgeBaseDetail | null;
  dataError: string | null;
  dataState: "error" | "loading" | "ready";
  dirty: boolean;
  draft: Pick<KnowledgeCreateDraft, "description" | "name">;
  error: { code: string; text: string } | null;
  maxUploadBytes: number;
  onArchiveToggle(archived: boolean): void;
  onBack(): void;
  onCancelUpload(batchId: string, itemId: string): void;
  onChange(update: Partial<Pick<KnowledgeCreateDraft, "description" | "name">>): void;
  onDeletePermanently(): void;
  onPublish(input: KnowledgeBasePublicationInput): void;
  onRefresh(): void;
  onOpenSource(sourceId: string): void;
  onRemoveSource(sourceId: string): void;
  onResumeUpload(batchId: string, itemId: string, file: File): void;
  onRevokePublication(publicationId: string): void;
  onSave(): void;
  onRestore(): void;
  onTrash(): void;
  onUpload(files: readonly File[]): void;
  publishableGroups: KnowledgeBaseListResponse["publishableGroups"];
  canPublishInstallation: boolean;
  sourcePage: number;
  sourceQuery: string;
  sources: KnowledgeSourceListResponse | null;
  onSourcePageChange(page: number): void;
  onSourceQueryChange(query: string): void;
  uploadBatches: KnowledgeUploadBatch[];
  uploadErrors: Record<string, string>;
  uploadProgress: Record<string, number>;
};

export type KnowledgeListView = {
  catalog: "bases" | "sources";
  canCreate: boolean;
  filter: KnowledgeLibraryFilter;
  knowledgeBases: KnowledgeBaseSummary[];
  onArchiveToggle(baseId: string, archived: boolean): void;
  onFilterChange(filter: KnowledgeLibraryFilter): void;
  onCatalogChange(catalog: "bases" | "sources"): void;
  onNewBase(): void;
  onOpenBase(baseId: string): void;
  onOpenSource(sourceId: string): void;
  onQueryChange(query: string): void;
  onRefresh(): Promise<void>;
  query: string;
  sourceData: KnowledgeSourceListResponse | null;
  sourceDataError: string | null;
  sourceDataState: "error" | "loading" | "ready";
  sourceFilter: KnowledgeSourceFilter;
  sourceQuery: string;
  onSourceFilterChange(filter: KnowledgeSourceFilter): void;
  onSourcePageChange(page: number): void;
  onSourceQueryChange(query: string): void;
};

export type KnowledgeSourceDetailView = {
  actionId: string | null;
  backLabel: string;
  dataError: string | null;
  dataState: "error" | "loading" | "ready";
  dirty: boolean;
  draft: { description: string; name: string; tags: string };
  error: { code: string; text: string } | null;
  onAddToBases(baseIds: readonly string[]): void;
  onBack(): void;
  onChange(update: Partial<{ description: string; name: string; tags: string }>): void;
  onDeletePermanently(): void;
  onMove(fromBaseId: string, toBaseId: string): void;
  onRefresh(): void;
  onRemoveFromBase(baseId: string): void;
  onReplace(file: File): void;
  onReprocess(): void;
  onSave(): void;
  onRestore(): void;
  onTrash(): void;
  source: KnowledgeSourceDetail | null;
};

export type KnowledgeLibraryView = {
  busy: boolean;
  create: KnowledgeCreateView | null;
  dataError: string | null;
  dataState: "error" | "loading" | "ready";
  detail: KnowledgeDetailView | null;
  list: KnowledgeListView;
  notice: KnowledgeLibraryNotice | null;
  onBackToChat(): void;
  onDismissNotice(): void;
  onRetry(): void;
  sourceDetail: KnowledgeSourceDetailView | null;
  task: "create" | "detail" | "list" | "source-detail";
};
