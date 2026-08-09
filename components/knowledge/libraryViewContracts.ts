import type {
  KnowledgeBaseDetail,
  KnowledgeBaseListResponse,
  KnowledgeBasePublicationInput,
  KnowledgeBaseSummary,
  KnowledgeEmbeddingDeployment,
  KnowledgeIngestionStatusResponse
} from "@/lib/contracts/knowledge";

export type KnowledgeLibraryNotice = {
  kind: "error" | "success";
  text: string;
};

export type KnowledgeLibraryFilter = "all" | "archived" | "shared" | "yours";

export type KnowledgeCreateDraft = {
  description: string;
  embeddingDeploymentId: string;
  name: string;
};

export type KnowledgeCreateView = {
  dirty: boolean;
  draft: KnowledgeCreateDraft;
  embeddingDeployments: KnowledgeEmbeddingDeployment[];
  error: { code: string; text: string } | null;
  onCancel(): void;
  onChange(update: Partial<KnowledgeCreateDraft>): void;
  onSave(): void;
  saving: boolean;
};

export type KnowledgeDetailView = {
  actionId: string | null;
  base: KnowledgeBaseDetail | null;
  dataError: string | null;
  dataState: "error" | "loading" | "ready";
  documentPage: number;
  documentQuery: string;
  dirty: boolean;
  draft: Pick<KnowledgeCreateDraft, "description" | "name">;
  embeddingDeployments: KnowledgeEmbeddingDeployment[];
  error: { code: string; text: string } | null;
  ingestion: KnowledgeIngestionStatusResponse | null;
  onArchiveToggle(archived: boolean): void;
  onBack(): void;
  onChange(update: Partial<Pick<KnowledgeCreateDraft, "description" | "name">>): void;
  onDocumentPageChange(page: number): void;
  onDocumentQueryChange(query: string): void;
  onPublish(input: KnowledgeBasePublicationInput): void;
  onRefresh(): void;
  onReindex(embeddingDeploymentId: string): void;
  onRemoveDocument(documentId: string): void;
  onReplaceDocument(documentId: string, file: File): void;
  onRetryDocument(documentId: string, versionId: string): void;
  onRevokePublication(publicationId: string): void;
  onSave(): void;
  onUpload(files: readonly File[]): void;
  publishableGroups: KnowledgeBaseListResponse["publishableGroups"];
  canPublishInstallation: boolean;
  upload: { current: number; fileName: string; total: number } | null;
};

export type KnowledgeListView = {
  filter: KnowledgeLibraryFilter;
  knowledgeBases: KnowledgeBaseSummary[];
  onArchiveToggle(baseId: string, archived: boolean): void;
  onFilterChange(filter: KnowledgeLibraryFilter): void;
  onNewBase(): void;
  onOpenBase(baseId: string): void;
  onQueryChange(query: string): void;
  query: string;
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
  task: "create" | "detail" | "list";
};
