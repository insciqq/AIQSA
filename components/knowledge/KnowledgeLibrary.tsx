import {
  ConfirmationDialog,
  DiscardChangesConfirmationDialog
} from "@/components/app-shell/ConfirmationDialog";
import { useDialogFocus } from "@/components/app-shell/useDialogFocus";
import { useBeforeUnloadGuard } from "@/components/app-shell/useBeforeUnloadGuard";
import type {
  KnowledgeCreateView,
  KnowledgeDetailView,
  KnowledgeLibraryFilter,
  KnowledgeLibraryNotice,
  KnowledgeLibraryView,
  KnowledgeListView,
  KnowledgeSourceDetailView
} from "@/components/knowledge/libraryViewContracts";
import {
  KNOWLEDGE_BASE_DESCRIPTION_MAX_LENGTH,
  KNOWLEDGE_BASE_NAME_MAX_LENGTH,
  KNOWLEDGE_SOURCE_DESCRIPTION_MAX_LENGTH,
  KNOWLEDGE_SOURCE_NAME_MAX_LENGTH,
  KNOWLEDGE_SOURCE_SEARCH_MAX_LENGTH,
  KNOWLEDGE_SOURCE_TAG_MAX_COUNT,
  KNOWLEDGE_SOURCE_TAG_MAX_LENGTH,
  type KnowledgeBaseSummary,
  type KnowledgeReadiness,
  type KnowledgeSourceFilter,
  type KnowledgeSourceSummary
} from "@/lib/contracts/knowledge";
import type {
  KnowledgeUploadBatch,
  KnowledgeUploadItem
} from "@/lib/contracts/knowledgeUploads";
import {
  KNOWLEDGE_UPLOAD_ACCEPT,
  KNOWLEDGE_UPLOAD_FORMAT_LABELS
} from "@/lib/domain/uploadFormats";
import {
  KNOWLEDGE_PROCESSING_WARNING_LABELS,
  type KnowledgeProcessingWarningCode
} from "@/lib/domain/knowledgeProcessingWarnings";
import {
  Archive,
  ArrowRight,
  ArrowLeft,
  BookOpen,
  CircleCheck,
  Clock3,
  FileSearch,
  Files,
  LoaderCircle,
  Plus,
  RefreshCcw,
  RotateCcw,
  Search,
  TriangleAlert,
  Trash2,
  Upload
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type Ref
} from "react";

function processingWarningLabels(codes: readonly KnowledgeProcessingWarningCode[]): string[] {
  return codes.map((code) => KNOWLEDGE_PROCESSING_WARNING_LABELS[code]);
}

const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-app-canvas";
const coarsePointerTarget =
  "[@media(hover:none)]:!min-h-touch [@media(pointer:coarse)]:!min-h-touch";
const quietButton = `inline-flex min-h-touch shrink-0 items-center justify-center gap-2 rounded-control px-3 text-xs font-medium text-ink-secondary hover:bg-control-hover hover:text-ink disabled:cursor-not-allowed disabled:text-ink-disabled disabled:opacity-60 sm:min-h-control-sm ${coarsePointerTarget} ${focusRing}`;
const surfaceButton = `inline-flex min-h-touch shrink-0 items-center justify-center gap-2 rounded-control bg-control-surface px-3 text-xs font-medium text-ink hover:bg-control-hover disabled:cursor-not-allowed disabled:text-ink-disabled disabled:opacity-60 sm:min-h-control-sm ${coarsePointerTarget} ${focusRing}`;
const primaryButton = `inline-flex min-h-touch shrink-0 items-center justify-center gap-2 rounded-control bg-proof px-4 text-sm font-semibold text-proof-contrast hover:bg-proof-hover disabled:cursor-not-allowed disabled:bg-control-surface disabled:text-ink-disabled sm:min-h-control ${coarsePointerTarget} ${focusRing}`;
const fieldInput = `min-h-touch w-full rounded-control border border-control-boundary bg-answer-paper px-3 text-sm text-ink placeholder:text-ink-muted disabled:cursor-not-allowed disabled:border-trace-subtle disabled:text-ink-disabled sm:min-h-control ${coarsePointerTarget} ${focusRing}`;
const fieldTextarea = `w-full resize-y rounded-control border border-control-boundary bg-answer-paper px-3 py-2 text-sm leading-6 text-ink placeholder:text-ink-muted disabled:cursor-not-allowed disabled:border-trace-subtle disabled:text-ink-disabled ${focusRing}`;
const fieldLabel = "mb-1 block text-xs font-medium text-ink-secondary";

type RemoveTarget =
  { baseId: string; baseName: string; kind: "membership"; sourceId: string; sourceName: string };

type LifecycleTarget = Readonly<{
  action: "delete" | "restore" | "trash";
  kind: "base" | "source";
  membershipCount?: number;
  name: string;
}>;

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Date unavailable"
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function formatBytes(value: number): string {
  if (value < 1_000) return `${value} B`;
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} kB`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)} MB`;
}

function knowledgeUploadHelp(maxUploadBytes: number): string {
  return `Supported: ${KNOWLEDGE_UPLOAD_FORMAT_LABELS.join(", ")}. Up to ${formatBytes(maxUploadBytes)} per file.`;
}

function scopeText(base: KnowledgeBaseSummary): string {
  if (base.owned) return "Yours";
  if (base.scope.kind === "group") return `Shared with ${base.scope.groupNames.join(", ")}`;
  return "Shared with the installation";
}

function hasTransientWork(detail: KnowledgeDetailView | null): boolean {
  if (!detail?.sources) return false;
  const transientSource = detail.sources.sources.some((source) =>
    source.readiness.state === "processing" || source.replacement.state === "processing");
  const transientUpload = detail.uploadBatches.some((batch) => batch.items.some((item) =>
    item.state === "queued" || item.state === "uploading" ||
    item.state === "upload_complete" || item.state === "processing"));
  return transientSource || transientUpload;
}

function hasTransientSourceWork(detail: KnowledgeSourceDetailView | null): boolean {
  return detail?.source?.readiness.state === "processing" ||
    detail?.source?.replacement.state === "processing";
}

export function KnowledgeLibrary({
  onPreviewSource,
  restoreFocus,
  view
}: {
  onPreviewSource?(sourceId: string, trigger: HTMLElement): void;
  restoreFocus?(): HTMLElement | null;
  view: KnowledgeLibraryView;
}) {
  const [discardConfirmationOpen, setDiscardConfirmationOpen] = useState(false);
  const [lifecycleTarget, setLifecycleTarget] = useState<LifecycleTarget | null>(null);
  const [removeTarget, setRemoveTarget] = useState<RemoveTarget | null>(null);
  const taskEntryRef = useRef<HTMLButtonElement>(null);
  const childDialogOpen = discardConfirmationOpen || lifecycleTarget !== null || removeTarget !== null;
  const dirty = view.task === "create"
    ? view.create?.dirty
    : view.task === "detail"
      ? view.detail?.dirty
      : view.task === "source-detail"
        ? view.sourceDetail?.dirty
        : false;
  useBeforeUnloadGuard(Boolean(dirty));
  const closeTask = view.task === "create"
    ? view.create?.onCancel
    : view.task === "detail"
      ? view.detail?.onBack
      : view.task === "source-detail"
        ? view.sourceDetail?.onBack
      : view.onBackToChat;
  const requestTaskClose = () => {
    if (view.busy || !closeTask) return;
    if (dirty) {
      setDiscardConfirmationOpen(true);
      return;
    }
    closeTask();
  };
  const dialogRef = useDialogFocus<HTMLDivElement>({
    autoFocus: false,
    closeOnEscape: !childDialogOpen && !view.busy,
    containFocus: !childDialogOpen,
    onClose: requestTaskClose,
    restoreFocus
  });

  useEffect(() => {
    if (childDialogOpen) return;
    const timer = window.setTimeout(() => {
      const dialog = dialogRef.current;
      const active = document.activeElement;
      if (
        !dialog ||
        (active instanceof HTMLElement && active !== dialog && dialog.contains(active))
      ) {
        return;
      }
      taskEntryRef.current?.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [childDialogOpen, dialogRef, view.busy, view.task]);

  const transientSignature = view.detail?.sources
    ? JSON.stringify({
        sources: view.detail.sources.sources.map((source) => [
          source.id,
          source.readiness.state,
          source.replacement.state
        ]),
        uploads: view.detail.uploadBatches.map((batch) => batch.items.map((item) => [
          item.id,
          item.state,
          item.uploadedBytes,
          item.updatedAt
        ]))
      })
    : "";
  useEffect(() => {
    if (view.task !== "detail" || view.busy || !hasTransientWork(view.detail)) return;
    const refresh = () => {
      if (document.visibilityState === "visible") view.detail?.onRefresh();
    };
    const timer = window.setTimeout(refresh, 2_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [transientSignature, view.busy, view.detail, view.task]);

  const sourceTransientSignature = view.sourceDetail?.source
    ? JSON.stringify({
        readiness: view.sourceDetail.source.readiness.state,
        replacement: view.sourceDetail.source.replacement.state,
        updatedAt: view.sourceDetail.source.updatedAt
      })
    : "";
  useEffect(() => {
    if (view.task !== "source-detail" || view.busy ||
      !hasTransientSourceWork(view.sourceDetail)) return;
    const refresh = () => {
      if (document.visibilityState === "visible") view.sourceDetail?.onRefresh();
    };
    const timer = window.setTimeout(refresh, 2_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [sourceTransientSignature, view.busy, view.sourceDetail, view.task]);

  return (
    <>
      <div
        ref={dialogRef}
        aria-busy={view.busy || undefined}
        aria-hidden={childDialogOpen || undefined}
        aria-label="Knowledge"
        aria-modal="true"
        className="fixed inset-0 z-50 flex h-[100dvh] w-full flex-col overflow-hidden bg-app-canvas pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)] text-ink"
        data-testid="knowledge-library"
        inert={childDialogOpen || undefined}
        role="dialog"
      >
        {view.task === "create" && view.create ? (
          <CreateTask
            busy={view.busy}
            create={view.create}
            entryRef={taskEntryRef}
            notice={view.notice}
            onDismissNotice={view.onDismissNotice}
            onRequestClose={requestTaskClose}
          />
        ) : view.task === "detail" && view.detail ? (
          <DetailTask
            busy={view.busy}
            detail={view.detail}
            entryRef={taskEntryRef}
            notice={view.notice}
            onDismissNotice={view.onDismissNotice}
            onRequestClose={requestTaskClose}
            onRequestLifecycle={setLifecycleTarget}
            onRequestRemove={setRemoveTarget}
            onPreviewSource={onPreviewSource}
            onRetry={view.onRetry}
          />
        ) : view.task === "source-detail" && view.sourceDetail ? (
          <SourceDetailTask
            busy={view.busy}
            detail={view.sourceDetail}
            entryRef={taskEntryRef}
            notice={view.notice}
            onDismissNotice={view.onDismissNotice}
            onRequestClose={requestTaskClose}
            onRequestLifecycle={setLifecycleTarget}
            onRequestRemove={setRemoveTarget}
            onPreviewSource={onPreviewSource}
            onRetry={view.onRetry}
          />
        ) : (
          <ListTask
            busy={view.busy}
            dataError={view.dataError}
            dataState={view.dataState}
            entryRef={taskEntryRef}
            list={view.list}
            notice={view.notice}
            onBackToChat={view.onBackToChat}
            onDismissNotice={view.onDismissNotice}
            onRetry={view.onRetry}
          />
        )}
      </div>
      {discardConfirmationOpen ? (
        <DiscardChangesConfirmationDialog
          label={view.task === "create"
            ? "Knowledge base draft"
            : view.task === "source-detail"
              ? "Source details"
              : "Knowledge base settings"}
          onCancel={() => setDiscardConfirmationOpen(false)}
          onConfirm={() => {
            setDiscardConfirmationOpen(false);
            closeTask?.();
          }}
        />
      ) : null}
      {removeTarget ? (
        <ConfirmationDialog
          confirmLabel="Remove from base"
          dialogLabel={`Remove ${removeTarget.sourceName} from ${removeTarget.baseName}`}
          icon="x"
          onCancel={() => setRemoveTarget(null)}
          onConfirm={() => {
            if (view.task === "detail") {
              view.detail?.onRemoveSource(removeTarget.sourceId);
            } else {
              view.sourceDetail?.onRemoveFromBase(removeTarget.baseId);
            }
            setRemoveTarget(null);
          }}
          testId="remove-knowledge-source-confirmation"
          title="Remove Source from this base?"
          tone="warning"
        >
          The Source stays in your library and in its other bases. Future chats using this base will no longer include it; accepted chats are unchanged.
        </ConfirmationDialog>
      ) : null}
      {lifecycleTarget ? (
        <ConfirmationDialog
          confirmLabel={lifecycleTarget.action === "delete"
            ? "Delete permanently"
            : lifecycleTarget.action === "restore" ? "Restore Source" : "Move to Trash"}
          dialogLabel={`${lifecycleTarget.action === "delete"
            ? "Permanently delete"
            : lifecycleTarget.action === "restore" ? "Restore" : "Move to Trash"} ${lifecycleTarget.name}`}
          icon="trash"
          onCancel={() => setLifecycleTarget(null)}
          onConfirm={() => {
            const target = lifecycleTarget;
            setLifecycleTarget(null);
            if (target.kind === "base") {
              if (target.action === "delete") view.detail?.onDeletePermanently();
              else view.detail?.onTrash();
            } else if (target.action === "delete") {
              view.sourceDetail?.onDeletePermanently();
            } else if (target.action === "restore") {
              view.sourceDetail?.onRestore();
            } else {
              view.sourceDetail?.onTrash();
            }
          }}
          testId={`knowledge-${lifecycleTarget.kind}-${lifecycleTarget.action}-confirmation`}
          title={lifecycleTarget.action === "delete"
            ? `Delete this ${lifecycleTarget.kind === "base" ? "base" : "Source"} permanently?`
            : lifecycleTarget.action === "restore"
              ? "Restore this Source to its Bases?"
            : `Move this ${lifecycleTarget.kind === "base" ? "base" : "Source"} to Trash?`}
          tone={lifecycleTarget.action === "delete" ? "destructive" : "warning"}
        >
          {lifecycleTarget.action === "restore"
            ? `This Source has ${lifecycleTarget.membershipCount ?? 0} Base memberships. Restoring it makes its current ready version available to future runs through every still-valid membership.`
            : lifecycleTarget.action === "delete"
            ? lifecycleTarget.kind === "base"
              ? "This cannot be undone. The base, its memberships, and its indexed copies will be removed. Canonical Sources remain available. Past answers keep only generic citation handles where evidence is deleted."
              : "This cannot be undone. The Source, every version, indexed copy, and stored file will be removed when no other resource retains the object. Past answer text remains, but citation evidence becomes a generic deleted-source marker."
            : lifecycleTarget.kind === "base"
              ? "Future Chat, Project, and Assistant runs stop using this base immediately. You can restore its Sources and sharing settings from Trash."
              : "Future runs exclude this Source from every base immediately. You can restore its previous Base memberships from Trash."}
        </ConfirmationDialog>
      ) : null}
    </>
  );
}

function NoticeRow({
  notice,
  onDismiss
}: {
  notice: KnowledgeLibraryNotice;
  onDismiss(): void;
}) {
  return (
    <div className="shrink-0 border-b border-trace-subtle bg-app-canvas px-3 py-2 sm:px-6 lg:px-8">
      <div
        aria-live={notice.kind === "error" ? "assertive" : "polite"}
        className={`flex w-full max-w-3xl items-center justify-between gap-3 rounded-control border-l-2 bg-overlay-surface px-3 py-2 text-sm text-ink-secondary shadow-float ${
          notice.kind === "error" ? "border-critical/45" : "border-positive/45"
        }`}
        data-testid="knowledge-library-notice"
        role={notice.kind === "error" ? "alert" : "status"}
      >
        <span className="min-w-0 break-words [overflow-wrap:anywhere]">{notice.text}</span>
        <button className={quietButton} onClick={onDismiss} type="button">
          Dismiss
        </button>
      </div>
    </div>
  );
}

function TaskFailure({ error, onRetry }: { error: string | null; onRetry(): void }) {
  return (
    <div className="grid min-h-0 flex-1 place-items-center overflow-y-auto px-4 py-8">
      <div className="w-full max-w-sm text-center">
        <RotateCcw className="mx-auto size-6 text-critical" aria-hidden="true" />
        <p className="mt-3 text-sm font-semibold text-ink" role="alert">
          Knowledge didn’t load
        </p>
        <p className="mt-1 text-xs leading-5 text-ink-secondary">
          {error ?? "Try loading Knowledge again."}
        </p>
        <button className={`${surfaceButton} mt-4`} onClick={onRetry} type="button">
          <RotateCcw className="size-4" aria-hidden="true" />
          Retry
        </button>
      </div>
    </div>
  );
}

function TaskLoading({ label }: { label: string }) {
  return (
    <div className="grid min-h-0 flex-1 place-items-center overflow-y-auto px-4 py-8">
      <div className="text-center" role="status">
        <LoaderCircle className="mx-auto size-6 animate-spin text-proof" aria-hidden="true" />
        <p className="mt-3 text-sm font-semibold text-ink">{label}</p>
      </div>
    </div>
  );
}

const FILTERS: readonly (readonly [KnowledgeLibraryFilter, string])[] = [
  ["all", "Active"],
  ["yours", "Yours"],
  ["shared", "Shared"],
  ["archived", "Archived"],
  ["trash", "Trash"]
];

function filterButton(selected: boolean): string {
  return `inline-flex min-h-touch items-center rounded-pill px-3 text-xs font-medium sm:min-h-control-sm ${coarsePointerTarget} ${focusRing} ${
    selected
      ? "bg-control-selected text-ink"
      : "bg-control-surface text-ink-secondary hover:bg-control-hover hover:text-ink"
  }`;
}

function visibleBases(list: KnowledgeListView): KnowledgeBaseSummary[] {
  const query = list.query.trim().toLocaleLowerCase();
  return list.knowledgeBases
    .filter((base) => {
      if (list.filter === "trash") return base.owned && base.trashed;
      if (base.trashed) return false;
      if (list.filter === "archived") return base.owned && base.archived;
      if (base.archived) return false;
      if (list.filter === "yours") return base.owned;
      if (list.filter === "shared") return !base.owned;
      return true;
    })
    .filter((base) => {
      if (!query) return true;
      return [
        base.name,
        base.description,
        base.ownerDisplayName
      ].some((value) => value.toLocaleLowerCase().includes(query));
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function ListTask({
  busy,
  dataError,
  dataState,
  entryRef,
  list,
  notice,
  onBackToChat,
  onDismissNotice,
  onRetry
}: {
  busy: boolean;
  dataError: string | null;
  dataState: "error" | "loading" | "ready";
  entryRef: Ref<HTMLButtonElement>;
  list: KnowledgeListView;
  notice: KnowledgeLibraryNotice | null;
  onBackToChat(): void;
  onDismissNotice(): void;
  onRetry(): void;
}) {
  const visible = visibleBases(list);
  const sourceCatalog = list.catalog === "sources";
  const effectiveDataState = sourceCatalog ? list.sourceDataState : dataState;
  const effectiveDataError = sourceCatalog ? list.sourceDataError : dataError;
  const sources = list.sourceData?.sources ?? [];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 border-b border-trace-subtle bg-app-canvas px-3 py-3 sm:px-6 lg:px-8">
        <div className="mx-auto grid w-full max-w-6xl min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 sm:grid-cols-[auto_minmax(0,1fr)_16rem_auto] sm:gap-3">
          <button ref={entryRef} className={quietButton} disabled={busy} onClick={onBackToChat} type="button">
            <ArrowLeft className="size-4" aria-hidden="true" />
            Back to chat
          </button>
          <h1 className="min-w-0 break-words text-xl font-semibold tracking-tight text-ink [overflow-wrap:anywhere]">
            Knowledge
          </h1>
          <label className="relative col-span-3 row-start-2 block min-w-0 sm:col-span-1 sm:col-start-3 sm:row-start-1" htmlFor="knowledge-search">
            <span className="sr-only">Search {sourceCatalog ? "Sources" : "Knowledge bases"}</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-muted" aria-hidden="true" />
            <input
              className={`${fieldInput} pl-9`}
              disabled={busy}
              id="knowledge-search"
              onChange={(event) => sourceCatalog
                ? list.onSourceQueryChange(event.currentTarget.value)
                : list.onQueryChange(event.currentTarget.value)}
              placeholder={sourceCatalog ? "Search Sources" : "Search bases"}
              type="search"
              value={sourceCatalog ? list.sourceQuery : list.query}
            />
          </label>
          <button className={`${primaryButton} col-start-3 row-start-1 sm:col-start-4`} disabled={busy || !list.canCreate} onClick={list.onNewBase} type="button">
            <Plus className="size-4" aria-hidden="true" />
            {sourceCatalog ? "New base + files" : "New knowledge base"}
          </button>
        </div>
      </header>
      {notice ? <NoticeRow notice={notice} onDismiss={onDismissNotice} /> : null}
      {effectiveDataState === "loading" ? (
        <TaskLoading label={sourceCatalog ? "Loading Sources…" : "Loading Knowledge…"} />
      ) : effectiveDataState === "error" ? (
        <TaskFailure error={effectiveDataError} onRetry={onRetry} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4 sm:px-6 lg:px-8">
          <div className="mx-auto w-full max-w-6xl">
            <div aria-label="Knowledge catalog" className="inline-flex rounded-control bg-control-surface p-1" role="group">
              {([[
                "bases",
                "Bases"
              ], [
                "sources",
                "Sources"
              ]] as const).map(([catalog, label]) => (
                <button
                  key={catalog}
                  aria-pressed={list.catalog === catalog}
                  className={`inline-flex min-h-touch items-center gap-2 rounded-control px-3 text-xs font-semibold sm:min-h-control-sm ${coarsePointerTarget} ${focusRing} ${
                    list.catalog === catalog
                      ? "bg-answer-paper text-ink shadow-float"
                      : "text-ink-secondary hover:bg-control-hover hover:text-ink"
                  }`}
                  disabled={busy}
                  onClick={() => list.onCatalogChange(catalog)}
                  type="button"
                >
                  {catalog === "bases"
                    ? <BookOpen className="size-4" aria-hidden="true" />
                    : <Files className="size-4" aria-hidden="true" />}
                  {label}
                </button>
              ))}
            </div>
            <p className="mt-3 max-w-2xl text-xs leading-5 text-ink-muted">
              {sourceCatalog
                ? "Sources are reusable files. Add one Source to several bases without uploading it again."
                : "Bases group Sources into the exact Knowledge scopes used by Chat, Projects, and Assistants."}
            </p>
            <div aria-label={sourceCatalog ? "Source filters" : "Knowledge filters"} className="mt-4 flex flex-wrap gap-2" role="group">
              {(sourceCatalog
                ? ([
                    ["all", "All"],
                    ["yours", "Yours"],
                    ["shared", "Shared"],
                    ["trash", "Trash"]
                  ] as const)
                : FILTERS
              ).map(([filter, label]) => {
                const selected = sourceCatalog
                  ? list.sourceFilter === filter
                  : list.filter === filter;
                return (
                  <button
                    key={filter}
                    aria-pressed={selected}
                    className={filterButton(selected)}
                    disabled={busy}
                    onClick={() => sourceCatalog
                      ? list.onSourceFilterChange(filter as KnowledgeSourceFilter)
                      : list.onFilterChange(filter as KnowledgeLibraryFilter)}
                    type="button"
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            {!sourceCatalog && !list.canCreate ? (
              <div className="mt-4 border-l-2 border-caution bg-caution/[0.06] px-3 py-2" role="status">
                <p className="text-sm font-semibold text-ink">Knowledge is temporarily unavailable</p>
                <p className="mt-1 text-xs leading-5 text-ink-secondary">
                  You can still open existing bases. Contact your administrator before creating or reprocessing content.
                </p>
              </div>
            ) : null}
            {sourceCatalog ? sources.length === 0 ? (
              <div className="py-16 text-center">
                <Files className="mx-auto size-7 text-ink-muted" aria-hidden="true" />
                <p className="mt-3 text-sm font-semibold text-ink">
                  {list.sourceQuery || list.sourceFilter !== "all"
                    ? "No matching Sources"
                    : "No Sources yet"}
                </p>
                <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-ink-muted">
                  {list.sourceQuery || list.sourceFilter !== "all"
                    ? "Try another search or filter."
                    : "Upload a file to a Knowledge base. It will appear here when its Source identity is available."}
                </p>
                {!list.sourceQuery && list.sourceFilter === "all" ? (
                  <button className={`${surfaceButton} mt-4`} disabled={!list.canCreate} onClick={list.onNewBase} type="button">
                    <Plus className="size-4" aria-hidden="true" />
                    Create a base and add files
                  </button>
                ) : null}
              </div>
            ) : (
              <>
                <ul className="mt-4 divide-y divide-trace-subtle border-y border-trace-subtle" aria-label="Knowledge Sources">
                  {sources.map((source) => (
                    <SourceRow key={source.id} busy={busy} list={list} source={source} />
                  ))}
                </ul>
                {(list.sourceData?.pagination.totalPages ?? 0) > 1 ? (
                  <nav aria-label="Source pages" className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-trace-subtle pt-4">
                    <p className="text-xs text-ink-muted">
                      Page {list.sourceData!.pagination.page} of {list.sourceData!.pagination.totalPages}
                    </p>
                    <div className="flex gap-2">
                      <button
                        className={quietButton}
                        disabled={busy || list.sourceData!.pagination.page <= 1}
                        onClick={() => list.onSourcePageChange(list.sourceData!.pagination.page - 1)}
                        type="button"
                      >
                        Previous
                      </button>
                      <button
                        className={quietButton}
                        disabled={busy || list.sourceData!.pagination.page >= list.sourceData!.pagination.totalPages}
                        onClick={() => list.onSourcePageChange(list.sourceData!.pagination.page + 1)}
                        type="button"
                      >
                        Next
                      </button>
                    </div>
                  </nav>
                ) : null}
              </>
            ) : list.knowledgeBases.length === 0 ? (
              <div className="py-16 text-center">
                <BookOpen className="mx-auto size-7 text-ink-muted" aria-hidden="true" />
                <p className="mt-3 text-sm font-semibold text-ink">No Knowledge bases yet</p>
                <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-ink-muted">
                  Create a private base and add the files you want AIQSA to use in future chats.
                </p>
                <button className={`${surfaceButton} mt-4`} disabled={!list.canCreate} onClick={list.onNewBase} type="button">
                  <Plus className="size-4" aria-hidden="true" />
                  Create your first base
                </button>
              </div>
            ) : visible.length === 0 ? (
              <div className="py-16 text-center" role="status">
                <p className="text-sm font-semibold text-ink">No matching Knowledge bases</p>
                <p className="mt-1 text-xs leading-5 text-ink-muted">Try another search or filter.</p>
              </div>
            ) : (
              <ul className="mt-4 divide-y divide-trace-subtle border-y border-trace-subtle" aria-label="Knowledge bases">
                {visible.map((base) => (
                  <BaseRow key={base.id} base={base} busy={busy} list={list} />
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function readinessText(readiness: KnowledgeReadiness): string {
  if (readiness.state === "trashed") return "In Trash";
  if (readiness.state === "archived") return "Archived";
  if (readiness.state === "empty") return "Empty";
  if (readiness.state === "ready") return "Ready";
  const parts = [
    readiness.readySources > 0 ? `${readiness.readySources} ready` : "",
    readiness.processingSources > 0 ? `${readiness.processingSources} processing` : "",
    readiness.attentionSources > 0
      ? `${readiness.attentionSources} need${readiness.attentionSources === 1 ? "s" : ""} attention`
      : ""
  ].filter(Boolean);
  return parts.join(" · ");
}

function BaseRow({ base, busy, list }: { base: KnowledgeBaseSummary; busy: boolean; list: KnowledgeListView }) {
  const state = base.readiness.state;
  const statusTone = state === "ready"
    ? "text-positive"
    : state === "trashed"
      ? "text-caution"
    : state === "needs_attention"
      ? "text-critical"
      : state === "processing"
        ? "text-proof"
        : "text-ink-muted";
  return (
    <li className="group flex min-w-0 items-stretch gap-1 bg-answer-paper hover:bg-control-hover/50" data-testid={`knowledge-base-${base.id}`}>
      <button
        className={`grid min-w-0 flex-1 grid-cols-[1.5rem_minmax(0,1fr)] gap-3 px-2 py-4 text-left sm:px-3 ${focusRing}`}
        disabled={busy}
        onClick={() => list.onOpenBase(base.id)}
        type="button"
      >
        <span className={`pt-0.5 ${statusTone}`} aria-hidden="true">
          {state === "ready" ? <CircleCheck className="size-4" />
            : state === "needs_attention" ? <TriangleAlert className="size-4" />
              : state === "processing" ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
                : state === "archived" ? <Archive className="size-4" />
                  : state === "trashed" ? <Trash2 className="size-4" />
                  : <BookOpen className="size-4" />}
        </span>
        <span className="min-w-0">
          <span className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-1">
            <span className="break-words text-sm font-semibold leading-5 text-ink [overflow-wrap:anywhere]">{base.name}</span>
            <span className={`text-metadata font-medium ${statusTone}`}>
              {base.deletionPending ? "Deletion pending" : readinessText(base.readiness)}
            </span>
          </span>
          {base.description ? (
            <span className="mt-1 line-clamp-2 block break-words text-xs leading-5 text-ink-secondary [overflow-wrap:anywhere]">
              {base.description}
            </span>
          ) : null}
          <span className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-metadata text-ink-muted">
            <span>{base.sourceCount} {base.sourceCount === 1 ? "Source" : "Sources"}</span>
            <span>{scopeText(base)}</span>
            {base.trashedAt ? <span>Deleted {formatDate(base.trashedAt)}</span> : (
              <span>Updated {formatDate(base.updatedAt)}</span>
            )}
            {base.trashedAt && base.purgeScheduledAt ? (
              <span>{base.deletionPending
                ? "Permanent purge in progress"
                : `Purge scheduled ${formatDate(base.purgeScheduledAt)}`}</span>
            ) : null}
          </span>
        </span>
      </button>
      {base.owned && !base.trashed ? (
        <button
          aria-label={`${base.archived ? "Restore" : "Archive"} ${base.name}`}
          className={`${quietButton} self-center px-2 sm:px-3`}
          disabled={busy}
          onClick={() => list.onArchiveToggle(base.id, !base.archived)}
          type="button"
        >
          {base.archived ? <RefreshCcw className="size-4" aria-hidden="true" /> : <Archive className="size-4" aria-hidden="true" />}
          <span className="hidden sm:inline">{base.archived ? "Restore" : "Archive"}</span>
        </button>
      ) : null}
    </li>
  );
}

function sourceStatus(source: KnowledgeSourceSummary): { label: string; tone: string } {
  if (source.deletionPending) return { label: "Deletion pending", tone: "text-critical" };
  if (source.trashed) return { label: "In Trash", tone: "text-caution" };
  if (source.readiness.state === "ready") {
    if (source.replacement.state === "processing") {
      return { label: "Ready · replacement processing", tone: "text-proof" };
    }
    if (source.replacement.state === "needs_attention") {
      return { label: "Ready · replacement needs attention", tone: "text-critical" };
    }
    return source.readiness.warningCodes.length > 0
      ? { label: "Ready with warnings", tone: "text-caution" }
      : { label: "Ready", tone: "text-positive" };
  }
  return source.readiness.state === "processing"
    ? { label: "Processing", tone: "text-proof" }
    : { label: "Needs attention", tone: "text-critical" };
}

function SourceRow({
  busy,
  list,
  source
}: {
  busy: boolean;
  list: KnowledgeListView;
  source: KnowledgeSourceSummary;
}) {
  const status = sourceStatus(source);
  return (
    <li className="bg-answer-paper hover:bg-control-hover/50" data-testid={`knowledge-source-${source.id}`}>
      <button
        className={`grid w-full min-w-0 grid-cols-[1.5rem_minmax(0,1fr)] gap-3 px-2 py-4 text-left sm:px-3 ${focusRing}`}
        disabled={busy}
        onClick={() => list.onOpenSource(source.id)}
        type="button"
      >
        <span className={`pt-0.5 ${status.tone}`} aria-hidden="true">
          {source.trashed
            ? <Trash2 className="size-4" />
            : source.readiness.state === "ready"
            ? source.readiness.warningCodes.length > 0
              ? <TriangleAlert className="size-4" />
              : <CircleCheck className="size-4" />
            : source.readiness.state === "processing"
              ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
              : <TriangleAlert className="size-4" />}
        </span>
        <span className="min-w-0">
          <span className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-1">
            <span className="break-words text-sm font-semibold leading-5 text-ink [overflow-wrap:anywhere]">
              {source.name}
            </span>
            <span className={`text-metadata font-medium ${status.tone}`}>{status.label}</span>
          </span>
          {source.description ? (
            <span className="mt-1 line-clamp-2 block break-words text-xs leading-5 text-ink-secondary [overflow-wrap:anywhere]">
              {source.description}
            </span>
          ) : null}
          {source.tags.length > 0 ? (
            <span className="mt-2 flex flex-wrap gap-1" aria-label="Source tags">
              {source.tags.slice(0, 4).map((tag) => (
                <span key={tag} className="rounded-pill bg-control-surface px-2 py-0.5 text-metadata text-ink-secondary">
                  {tag}
                </span>
              ))}
              {source.tags.length > 4 ? (
                <span className="px-1 py-0.5 text-metadata text-ink-muted">+{source.tags.length - 4}</span>
              ) : null}
            </span>
          ) : null}
          <span className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-metadata text-ink-muted">
            <span>{source.membershipCount} {source.membershipCount === 1 ? "base" : "bases"}</span>
            {source.currentVersion ? (
              <span>{source.currentVersion.fileName} · {formatBytes(source.currentVersion.byteSize)}</span>
            ) : null}
            <span>{source.owned ? "Yours" : `Shared by ${source.ownerDisplayName}`}</span>
            {source.trashedAt ? <span>Deleted {formatDate(source.trashedAt)}</span> : (
              <span>Updated {formatDate(source.updatedAt)}</span>
            )}
            {source.trashedAt && source.purgeScheduledAt ? (
              <span>{source.deletionPending
                ? "Permanent purge in progress"
                : `Purge scheduled ${formatDate(source.purgeScheduledAt)}`}</span>
            ) : null}
          </span>
        </span>
      </button>
    </li>
  );
}

function CreateTask({
  busy,
  create,
  entryRef,
  notice,
  onDismissNotice,
  onRequestClose
}: {
  busy: boolean;
  create: KnowledgeCreateView;
  entryRef: Ref<HTMLButtonElement>;
  notice: KnowledgeLibraryNotice | null;
  onDismissNotice(): void;
  onRequestClose(): void;
}) {
  const [dragActive, setDragActive] = useState(false);
  const dragDepth = useRef(0);
  const addFiles = (files: FileList | readonly File[] | null) => {
    if (!files || busy) return;
    const known = new Set(create.draft.files.map(
      ({ lastModified, name, size }) => `${name}\u0000${size}\u0000${lastModified}`
    ));
    const additions = Array.from(files).filter((file) => {
      const key = `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
      if (known.has(key)) return false;
      known.add(key);
      return true;
    });
    if (additions.length > 0) create.onChange({ files: [...create.draft.files, ...additions] });
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 border-b border-trace-subtle px-3 py-3 sm:px-6 lg:px-8">
        <div className="mx-auto flex w-full max-w-4xl min-w-0 flex-wrap items-center gap-2 sm:gap-3">
          <button ref={entryRef} className={quietButton} disabled={busy} onClick={onRequestClose} type="button">
            <ArrowLeft className="size-4" aria-hidden="true" />
            Back to Knowledge
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="break-words text-xl font-semibold leading-6 tracking-tight text-ink [overflow-wrap:anywhere]">New Knowledge base</h1>
            <p className="text-metadata text-ink-muted">Private until you publish it</p>
          </div>
        </div>
      </header>
      {notice ? <NoticeRow notice={notice} onDismiss={onDismissNotice} /> : null}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-6 sm:px-6 lg:px-8">
        <form
          className="mx-auto w-full max-w-3xl"
          onSubmit={(event) => {
            event.preventDefault();
            create.onSave();
          }}
        >
          <section aria-labelledby="knowledge-create-identity">
            <h2 className="text-base font-semibold text-ink" id="knowledge-create-identity">Identity</h2>
            <p className="mt-1 text-xs leading-5 text-ink-muted">Use a name people will recognize when this base is shared.</p>
            <div className="mt-4">
              <label className={fieldLabel} htmlFor="knowledge-create-name">Name</label>
              <input
                autoComplete="off"
                className={fieldInput}
                disabled={busy}
                id="knowledge-create-name"
                maxLength={KNOWLEDGE_BASE_NAME_MAX_LENGTH}
                onChange={(event) => create.onChange({ name: event.currentTarget.value })}
                required
                value={create.draft.name}
              />
            </div>
            <div className="mt-4">
              <label className={fieldLabel} htmlFor="knowledge-create-description">Description</label>
              <textarea
                className={fieldTextarea}
                disabled={busy}
                id="knowledge-create-description"
                maxLength={KNOWLEDGE_BASE_DESCRIPTION_MAX_LENGTH}
                onChange={(event) => create.onChange({ description: event.currentTarget.value })}
                rows={4}
                value={create.draft.description}
              />
            </div>
          </section>
          <section aria-labelledby="knowledge-create-files" className="mt-8 border-t border-trace-subtle pt-6">
            <h2 className="text-base font-semibold text-ink" id="knowledge-create-files">Files <span className="font-normal text-ink-muted">(optional)</span></h2>
            <p className="mt-1 text-xs leading-5 text-ink-muted">Start empty or add files now. {knowledgeUploadHelp(create.maxUploadBytes)} Each file shows its own processing state.</p>
            <div
              className={`mt-4 rounded-panel border border-dashed px-4 py-5 transition-colors ${
                dragActive ? "border-proof bg-control-selected" : "border-control-boundary bg-control-surface"
              }`}
              data-drop-active={dragActive || undefined}
              data-testid="knowledge-create-drop-zone"
              onDragEnter={(event) => {
                if (!hasFileTransfer(event)) return;
                event.preventDefault();
                dragDepth.current += 1;
                setDragActive(true);
              }}
              onDragLeave={(event) => {
                if (!hasFileTransfer(event)) return;
                event.preventDefault();
                dragDepth.current = Math.max(0, dragDepth.current - 1);
                if (dragDepth.current === 0) setDragActive(false);
              }}
              onDragOver={(event) => {
                if (!hasFileTransfer(event)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = busy ? "none" : "copy";
              }}
              onDrop={(event) => {
                if (!hasFileTransfer(event)) return;
                event.preventDefault();
                dragDepth.current = 0;
                setDragActive(false);
                addFiles(event.dataTransfer.files);
              }}
            >
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
                <p className="text-sm font-medium text-ink">{dragActive ? "Drop files here" : "Drop files here, or choose from your device"}</p>
                <label className={`${surfaceButton} ${busy ? "pointer-events-none" : "cursor-pointer"}`}>
                  <Upload className="size-4" aria-hidden="true" />
                  Choose files
                  <input
                    accept={KNOWLEDGE_UPLOAD_ACCEPT}
                    className="sr-only"
                    disabled={busy}
                    multiple
                    onChange={(event) => {
                      addFiles(event.currentTarget.files);
                      event.currentTarget.value = "";
                    }}
                    type="file"
                  />
                </label>
              </div>
            </div>
            {create.draft.files.length > 0 ? (
              <ul className="mt-3 divide-y divide-trace-subtle border-y border-trace-subtle" aria-label="Files selected for this Knowledge base">
                {create.draft.files.map((file, fileIndex) => (
                  <li key={`${file.name}-${file.size}-${file.lastModified}`} className="flex min-w-0 items-center justify-between gap-3 py-2">
                    <span className="min-w-0 truncate text-xs text-ink-secondary">{file.name} · {formatBytes(file.size)}</span>
                    <button
                      aria-label={`Remove ${file.name}`}
                      className={quietButton}
                      disabled={busy}
                      onClick={() => create.onChange({
                        files: create.draft.files.filter((_, index) => index !== fileIndex)
                      })}
                      type="button"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {create.progress ? (
              <p className="mt-3 flex items-center gap-2 text-xs text-ink-secondary" role="status">
                <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none text-proof" aria-hidden="true" />
                Uploading {create.progress.current} of {create.progress.total}: <span className="min-w-0 truncate">{create.progress.fileName}</span>
              </p>
            ) : null}
          </section>
          {create.error ? (
            <p className="mt-6 text-sm text-critical" role="alert">{create.error.text}</p>
          ) : null}
          <div className="mt-8 flex flex-wrap justify-end gap-2 border-t border-trace-subtle pt-4">
            <button className={quietButton} disabled={busy} onClick={onRequestClose} type="button">Cancel</button>
            <button className={primaryButton} disabled={busy} type="submit">
              {create.saving ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
              Create knowledge base
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function DetailTask({
  busy,
  detail,
  entryRef,
  notice,
  onDismissNotice,
  onRequestClose,
  onRequestLifecycle,
  onRequestRemove,
  onPreviewSource,
  onRetry
}: {
  busy: boolean;
  detail: KnowledgeDetailView;
  entryRef: Ref<HTMLButtonElement>;
  notice: KnowledgeLibraryNotice | null;
  onDismissNotice(): void;
  onRequestClose(): void;
  onRequestLifecycle(target: LifecycleTarget): void;
  onRequestRemove(target: RemoveTarget): void;
  onPreviewSource?(sourceId: string, trigger: HTMLElement): void;
  onRetry(): void;
}) {
  if (detail.dataState === "loading") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <DetailHeader busy={busy} detail={detail} entryRef={entryRef} onRequestClose={onRequestClose} />
        <TaskLoading label="Loading Knowledge base…" />
      </div>
    );
  }
  if (detail.dataState === "error" || !detail.base || !detail.sources) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <DetailHeader busy={busy} detail={detail} entryRef={entryRef} onRequestClose={onRequestClose} />
        <TaskFailure error={detail.dataError} onRetry={onRetry} />
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DetailHeader busy={busy} detail={detail} entryRef={entryRef} onRequestClose={onRequestClose} />
      {notice ? <NoticeRow notice={notice} onDismiss={onDismissNotice} /> : null}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-5 sm:px-6 lg:px-8">
        <div className="mx-auto w-full max-w-5xl">
          {!detail.base.owned ? (
            <div className="mb-6 border-l-2 border-proof/45 pl-3">
              <p className="text-sm font-semibold text-ink">Read-only shared base</p>
              <p className="mt-1 text-xs leading-5 text-ink-secondary">
                {scopeText(detail.base)}. The owner controls files, processing, and access.
              </p>
            </div>
          ) : null}
          <BaseOverview base={detail.base} />
          {detail.base.owned ? (
            <LifecycleSection
              busy={busy}
              deletionPending={detail.base.deletionPending}
              kind="base"
              name={detail.base.name}
              onDelete={() => onRequestLifecycle({ action: "delete", kind: "base", name: detail.base!.name })}
              onRestore={detail.onRestore}
              onTrash={() => onRequestLifecycle({ action: "trash", kind: "base", name: detail.base!.name })}
              purgeScheduledAt={detail.base.purgeScheduledAt}
              trashed={detail.base.trashed}
              trashedAt={detail.base.trashedAt}
            />
          ) : null}
          {!detail.base.trashed ? <BaseSettings busy={busy} detail={detail} /> : null}
          {!detail.base.trashed ? (
            <SourcesSection
              busy={busy}
              detail={detail}
              onPreviewSource={onPreviewSource}
              onRequestRemove={onRequestRemove}
            />
          ) : null}
          {detail.base.owned && !detail.base.trashed ? (
            <PublicationSection busy={busy} detail={detail} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function SourceDetailTask({
  busy,
  detail,
  entryRef,
  notice,
  onDismissNotice,
  onRequestClose,
  onRequestLifecycle,
  onRequestRemove,
  onPreviewSource,
  onRetry
}: {
  busy: boolean;
  detail: KnowledgeSourceDetailView;
  entryRef: Ref<HTMLButtonElement>;
  notice: KnowledgeLibraryNotice | null;
  onDismissNotice(): void;
  onRequestClose(): void;
  onRequestLifecycle(target: LifecycleTarget): void;
  onRequestRemove(target: RemoveTarget): void;
  onPreviewSource?(sourceId: string, trigger: HTMLElement): void;
  onRetry(): void;
}) {
  const [selectedBaseIds, setSelectedBaseIds] = useState<string[]>([]);
  const [moveFromBaseId, setMoveFromBaseId] = useState("");
  const [moveToBaseId, setMoveToBaseId] = useState("");
  const source = detail.source;
  const effectiveMoveFrom = source?.memberships.some(({ id }) => id === moveFromBaseId)
    ? moveFromBaseId
    : source?.memberships[0]?.id ?? "";
  const effectiveMoveTo = source?.eligibleBases.some(({ id }) => id === moveToBaseId)
    ? moveToBaseId
    : source?.eligibleBases[0]?.id ?? "";
  const header = (
    <header className="shrink-0 border-b border-trace-subtle px-3 py-3 sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-5xl min-w-0 flex-wrap items-center gap-2 sm:gap-3">
        <button ref={entryRef} className={quietButton} disabled={busy} onClick={onRequestClose} type="button">
          <ArrowLeft className="size-4" aria-hidden="true" />
          {detail.backLabel}
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="break-words text-xl font-semibold leading-6 tracking-tight text-ink [overflow-wrap:anywhere]">
            {source?.name ?? "Source"}
          </h1>
          <p className="text-metadata text-ink-muted">
            {source?.trashed ? "In Trash · excluded from future runs" : "Reusable across Knowledge bases"}
          </p>
        </div>
        {source ? (
          <>
            {onPreviewSource && source.currentVersion?.readiness.state === "ready" ? (
              <button
                className={quietButton}
                disabled={busy}
                onClick={(event) => onPreviewSource(source.id, event.currentTarget)}
                type="button"
              >
                <FileSearch className="size-4" aria-hidden="true" />
                Preview
              </button>
            ) : null}
            <button className={quietButton} disabled={busy} onClick={detail.onRefresh} type="button">
              <RefreshCcw className="size-4" aria-hidden="true" />
              Refresh
            </button>
          </>
        ) : null}
      </div>
    </header>
  );
  if (detail.dataState === "loading") {
    return <div className="flex min-h-0 flex-1 flex-col">{header}<TaskLoading label="Loading Source…" /></div>;
  }
  if (detail.dataState === "error" || !source) {
    return <div className="flex min-h-0 flex-1 flex-col">{header}<TaskFailure error={detail.dataError} onRetry={onRetry} /></div>;
  }
  const status = sourceStatus(source);
  const reprocessAvailable = source.readiness.state === "needs_attention" ||
    source.replacement.state === "needs_attention";
  const validSelectedBaseIds = selectedBaseIds.filter((id) =>
    source.eligibleBases.some((base) => base.id === id)
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header}
      {notice ? <NoticeRow notice={notice} onDismiss={onDismissNotice} /> : null}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-5 sm:px-6 lg:px-8">
        <div className="mx-auto w-full max-w-5xl">
          {!source.owned ? (
            <div className="mb-6 border-l-2 border-proof/45 pl-3">
              <p className="text-sm font-semibold text-ink">Read-only shared Source</p>
              <p className="mt-1 text-xs leading-5 text-ink-secondary">
                Shared by {source.ownerDisplayName}. You can use it through the listed bases; only its owner can edit or move it.
              </p>
            </div>
          ) : null}

          <section aria-labelledby="knowledge-source-overview-title">
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-ink" id="knowledge-source-overview-title">Current Source</h2>
                <p className="mt-1 text-xs leading-5 text-ink-muted">
                  One canonical file identity, reused wherever you add it.
                </p>
              </div>
              <p className={`text-xs font-semibold ${status.tone}`}>{status.label}</p>
            </div>
            <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <dt className="text-metadata text-ink-muted">Current file</dt>
                <dd className="mt-1 break-words text-sm text-ink [overflow-wrap:anywhere]">
                  {source.currentVersion?.fileName ?? "No ready file"}
                </dd>
              </div>
              <div>
                <dt className="text-metadata text-ink-muted">Size</dt>
                <dd className="mt-1 text-sm text-ink">
                  {source.currentVersion ? formatBytes(source.currentVersion.byteSize) : "Unavailable"}
                </dd>
              </div>
              <div>
                <dt className="text-metadata text-ink-muted">Used in</dt>
                <dd className="mt-1 text-sm text-ink">
                  {source.membershipCount} {source.membershipCount === 1 ? "base" : "bases"}
                </dd>
              </div>
              <div>
                <dt className="text-metadata text-ink-muted">Updated</dt>
                <dd className="mt-1 text-sm text-ink">{formatDate(source.updatedAt)}</dd>
              </div>
            </dl>
            {source.readiness.state === "needs_attention" &&
            source.replacement.state !== "needs_attention" ? (
              <div className="mt-4 border-l-2 border-critical/45 pl-3" role="status">
                <p className="text-sm font-semibold text-ink">Processing needs attention</p>
                <p className="mt-1 text-xs leading-5 text-ink-secondary">
                  Retry processing here or replace the file with a corrected copy.
                  {source.readiness.supportReference
                    ? ` Support reference ${source.readiness.supportReference}.`
                    : ""}
                </p>
              </div>
            ) : null}
            {source.replacement.state === "processing" ? (
              <div className="mt-4 border-l-2 border-proof/45 pl-3" role="status">
                <p className="text-sm font-semibold text-ink">Replacement processing</p>
                <p className="mt-1 text-xs leading-5 text-ink-secondary">
                  The current ready version stays available until the replacement is ready.
                </p>
              </div>
            ) : source.replacement.state === "needs_attention" ? (
              <div className="mt-4 border-l-2 border-critical/45 pl-3" role="status">
                <p className="text-sm font-semibold text-ink">Replacement needs attention</p>
                <p className="mt-1 text-xs leading-5 text-ink-secondary">
                  Retry the replacement or upload a different file. The current ready version is unchanged.
                  {source.replacement.supportReference
                    ? ` Support reference ${source.replacement.supportReference}.`
                    : ""}
                </p>
              </div>
            ) : null}
            {source.readiness.state === "ready" && source.readiness.warningCodes.length > 0 ? (
              <div className="mt-4 border-l-2 border-caution/45 pl-3" role="status">
                <p className="text-sm font-semibold text-ink">Ready with warnings</p>
                <ul className="mt-1 list-disc space-y-1 pl-4 text-xs leading-5 text-ink-secondary">
                  {processingWarningLabels(source.readiness.warningCodes).map((label) => (
                    <li key={label}>{label}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {source.owned && !source.trashed && !source.deletionPending ? (
              <div className="mt-4 flex flex-wrap items-center gap-2">
                {reprocessAvailable ? (
                  <button
                    className={surfaceButton}
                    disabled={busy}
                    onClick={detail.onReprocess}
                    type="button"
                  >
                    {detail.actionId === "source:reprocess"
                      ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                      : <RefreshCcw className="size-4" aria-hidden="true" />}
                    Retry processing
                  </button>
                ) : null}
                <label
                  aria-disabled={busy || source.replacement.state === "processing" || undefined}
                  className={`${surfaceButton} ${
                    busy || source.replacement.state === "processing"
                      ? "cursor-not-allowed opacity-60"
                      : "cursor-pointer"
                  }`}
                >
                  {detail.actionId === "source:replace"
                    ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                    : <Upload className="size-4" aria-hidden="true" />}
                  Replace file
                  <input
                    accept={KNOWLEDGE_UPLOAD_ACCEPT}
                    className="sr-only"
                    disabled={busy || source.replacement.state === "processing"}
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = "";
                      if (file) detail.onReplace(file);
                    }}
                    type="file"
                  />
                </label>
                <p className="basis-full text-metadata leading-5 text-ink-muted">
                  Replacing creates a new version; existing accepted chats keep the version they used.
                </p>
              </div>
            ) : null}
          </section>

          {source.owned ? (
            <LifecycleSection
              busy={busy}
              deletionPending={source.deletionPending}
              kind="source"
              name={source.name}
              onDelete={() => onRequestLifecycle({ action: "delete", kind: "source", name: source.name })}
              onRestore={() => source.membershipCount > 1
                ? onRequestLifecycle({
                    action: "restore",
                    kind: "source",
                    membershipCount: source.membershipCount,
                    name: source.name
                  })
                : detail.onRestore()}
              onTrash={() => onRequestLifecycle({ action: "trash", kind: "source", name: source.name })}
              purgeScheduledAt={source.purgeScheduledAt}
              trashed={source.trashed}
              trashedAt={source.trashedAt}
            />
          ) : null}

          {!source.trashed ? <section aria-labelledby="knowledge-source-details-title" className="mt-6 border-t border-trace-subtle pt-6">
            <h2 className="text-base font-semibold text-ink" id="knowledge-source-details-title">Details</h2>
            {source.owned ? (
              <form
                className="mt-4 grid gap-4 sm:grid-cols-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  detail.onSave();
                }}
              >
                <div>
                  <label className={fieldLabel} htmlFor="knowledge-source-name">Name</label>
                  <input
                    className={fieldInput}
                    disabled={busy}
                    id="knowledge-source-name"
                    maxLength={KNOWLEDGE_SOURCE_NAME_MAX_LENGTH}
                    onChange={(event) => detail.onChange({ name: event.currentTarget.value })}
                    required
                    value={detail.draft.name}
                  />
                </div>
                <div>
                  <label className={fieldLabel} htmlFor="knowledge-source-tags">Tags</label>
                  <input
                    className={fieldInput}
                    disabled={busy}
                    id="knowledge-source-tags"
                    maxLength={KNOWLEDGE_SOURCE_TAG_MAX_COUNT * (KNOWLEDGE_SOURCE_TAG_MAX_LENGTH + 2)}
                    onChange={(event) => detail.onChange({ tags: event.currentTarget.value })}
                    placeholder="product, policy, onboarding"
                    value={detail.draft.tags}
                  />
                  <p className="mt-1 text-metadata text-ink-muted">
                    Comma-separated · up to {KNOWLEDGE_SOURCE_TAG_MAX_COUNT}
                  </p>
                </div>
                <div className="sm:col-span-2">
                  <label className={fieldLabel} htmlFor="knowledge-source-description">Description</label>
                  <textarea
                    className={fieldTextarea}
                    disabled={busy}
                    id="knowledge-source-description"
                    maxLength={KNOWLEDGE_SOURCE_DESCRIPTION_MAX_LENGTH}
                    onChange={(event) => detail.onChange({ description: event.currentTarget.value })}
                    rows={4}
                    value={detail.draft.description}
                  />
                </div>
                {detail.error ? <p className="text-sm text-critical sm:col-span-2" role="alert">{detail.error.text}</p> : null}
                <div className="flex justify-end sm:col-span-2">
                  <button className={primaryButton} disabled={busy || !detail.dirty} type="submit">
                    {detail.actionId === "source:settings"
                      ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                      : null}
                    Save details
                  </button>
                </div>
              </form>
            ) : (
              <dl className="mt-4 grid gap-4 sm:grid-cols-2">
                <div><dt className="text-metadata text-ink-muted">Owner</dt><dd className="mt-1 text-sm text-ink">{source.ownerDisplayName}</dd></div>
                <div><dt className="text-metadata text-ink-muted">Description</dt><dd className="mt-1 whitespace-pre-wrap text-sm leading-6 text-ink-secondary">{source.description || "No description"}</dd></div>
              </dl>
            )}
          </section> : null}

          {!source.trashed ? <section aria-labelledby="knowledge-source-bases-title" className="mt-6 border-t border-trace-subtle pt-6">
            <h2 className="text-base font-semibold text-ink" id="knowledge-source-bases-title">Knowledge bases</h2>
            <p className="mt-1 text-xs leading-5 text-ink-muted">
              These memberships determine where Chat, Project, and Assistant Knowledge selection can use this Source.
            </p>
            {source.memberships.length === 0 ? (
              <p className="mt-4 text-sm text-ink-muted">Not currently used by a base.</p>
            ) : (
              <ul className="mt-4 divide-y divide-trace-subtle border-y border-trace-subtle" aria-label="Source Base memberships">
                {source.memberships.map((base) => (
                  <li key={base.id} className="flex min-w-0 flex-wrap items-center justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="break-words text-sm font-medium text-ink [overflow-wrap:anywhere]">{base.name}</p>
                      <p className="mt-0.5 text-metadata text-ink-muted">
                        {base.archived ? "Archived base" : "Available for future selection"}
                      </p>
                    </div>
                    {source.owned ? (
                      <button
                        className={`${quietButton} text-critical hover:bg-critical/10 hover:text-critical`}
                        disabled={busy}
                        onClick={() => onRequestRemove({
                          baseId: base.id,
                          baseName: base.name,
                          kind: "membership",
                          sourceId: source.id,
                          sourceName: source.name
                        })}
                        type="button"
                      >
                        {detail.actionId === `source:remove:${base.id}`
                          ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                          : null}
                        Remove from base
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {source.owned && source.eligibleBases.length > 0 ? (
              <div className="mt-5 grid gap-5 lg:grid-cols-2">
                <fieldset className="min-w-0">
                  <legend className="text-sm font-semibold text-ink">Add to bases</legend>
                  <p className="mt-1 text-xs leading-5 text-ink-muted">Reuse this Source without another upload.</p>
                  <div className="mt-3 max-h-48 overflow-y-auto rounded-control border border-control-boundary p-2">
                    {source.eligibleBases.map((base) => (
                      <label key={base.id} className="flex min-h-touch items-center gap-3 rounded-control px-2 text-sm text-ink hover:bg-control-hover sm:min-h-control-sm">
                        <input
                          checked={validSelectedBaseIds.includes(base.id)}
                          disabled={busy}
                          onChange={(event) => {
                            const checked = event.currentTarget.checked;
                            setSelectedBaseIds((current) => checked
                              ? [...current, base.id]
                              : current.filter((id) => id !== base.id));
                          }}
                          type="checkbox"
                        />
                        <span className="min-w-0 break-words [overflow-wrap:anywhere]">{base.name}</span>
                      </label>
                    ))}
                  </div>
                  <button
                    className={`${surfaceButton} mt-3`}
                    disabled={busy || validSelectedBaseIds.length === 0}
                    onClick={() => {
                      detail.onAddToBases(validSelectedBaseIds);
                      setSelectedBaseIds([]);
                    }}
                    type="button"
                  >
                    {detail.actionId === "source:add"
                      ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                      : <Plus className="size-4" aria-hidden="true" />}
                    Add to selected
                  </button>
                </fieldset>
                {source.memberships.length > 0 ? (
                  <div>
                    <h3 className="text-sm font-semibold text-ink">Move Source</h3>
                    <p className="mt-1 text-xs leading-5 text-ink-muted">Move removes one membership and adds another in one action.</p>
                    <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-end">
                      <div>
                        <label className={fieldLabel} htmlFor="knowledge-source-move-from">From</label>
                        <select
                          className={fieldInput}
                          disabled={busy}
                          id="knowledge-source-move-from"
                          onChange={(event) => setMoveFromBaseId(event.currentTarget.value)}
                          value={effectiveMoveFrom}
                        >
                          {source.memberships.map((base) => <option key={base.id} value={base.id}>{base.name}</option>)}
                        </select>
                      </div>
                      <ArrowRight className="mb-3 hidden size-4 text-ink-muted sm:block" aria-hidden="true" />
                      <div>
                        <label className={fieldLabel} htmlFor="knowledge-source-move-to">To</label>
                        <select
                          className={fieldInput}
                          disabled={busy}
                          id="knowledge-source-move-to"
                          onChange={(event) => setMoveToBaseId(event.currentTarget.value)}
                          value={effectiveMoveTo}
                        >
                          {source.eligibleBases.map((base) => <option key={base.id} value={base.id}>{base.name}</option>)}
                        </select>
                      </div>
                    </div>
                    <button
                      className={`${surfaceButton} mt-3`}
                      disabled={busy || !effectiveMoveFrom || !effectiveMoveTo}
                      onClick={() => detail.onMove(effectiveMoveFrom, effectiveMoveTo)}
                      type="button"
                    >
                      {detail.actionId?.startsWith("source:move:")
                        ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                        : <ArrowRight className="size-4" aria-hidden="true" />}
                      Move Source
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </section> : null}

          <section aria-labelledby="knowledge-source-history-title" className="mt-6 border-t border-trace-subtle pt-6">
            <details>
              <summary className={`cursor-pointer text-base font-semibold text-ink ${focusRing}`} id="knowledge-source-history-title">
                Version history · {source.versions.length}
              </summary>
              <p className="mt-2 text-xs leading-5 text-ink-muted">
                Replacements create versions. Existing accepted chats keep the version they used.
              </p>
              <ul className="mt-4 divide-y divide-trace-subtle border-y border-trace-subtle" aria-label="Source versions">
                {source.versions.map((version) => {
                  const versionStatus = version.readiness.state === "ready"
                    ? version.readiness.warningCodes.length > 0 ? "Ready with warnings" : "Ready"
                    : version.readiness.state === "processing"
                      ? "Processing"
                      : "Needs attention";
                  return (
                    <li key={version.versionNumber} className="flex min-w-0 flex-wrap items-start justify-between gap-3 py-3">
                      <div className="min-w-0">
                        <p className="break-words text-sm font-medium text-ink [overflow-wrap:anywhere]">
                          Version {version.versionNumber} · {version.fileName}
                        </p>
                        <p className="mt-0.5 text-metadata text-ink-muted">
                          {formatBytes(version.byteSize)} · {formatDate(version.createdAt)}
                        </p>
                      </div>
                      <p className="text-metadata font-medium text-ink-secondary">
                        {version.isCurrent ? "Current · " : version.isPending ? "Replacement · " : ""}{versionStatus}
                      </p>
                    </li>
                  );
                })}
              </ul>
            </details>
          </section>
        </div>
      </div>
    </div>
  );
}

function LifecycleSection({
  busy,
  deletionPending,
  kind,
  name,
  onDelete,
  onRestore,
  onTrash,
  purgeScheduledAt,
  trashedAt,
  trashed
}: Readonly<{
  busy: boolean;
  deletionPending: boolean;
  kind: "base" | "source";
  name: string;
  onDelete(): void;
  onRestore(): void;
  onTrash(): void;
  purgeScheduledAt: string | null;
  trashedAt: string | null;
  trashed: boolean;
}>) {
  const label = kind === "base" ? "Knowledge base" : "Source";
  if (!trashed) {
    return (
      <section aria-label={`${label} lifecycle`} className="mt-6 border-t border-trace-subtle pt-6">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-ink">Trash</h2>
            <p className="mt-1 max-w-2xl text-xs leading-5 text-ink-muted">
              {kind === "base"
                ? "Stop future runs from using this base while keeping its Sources and settings recoverable."
                : "Stop future runs from using this Source in every base while keeping it recoverable."}
            </p>
          </div>
          <button
            aria-label={`Move ${name} to Trash`}
            className={`${quietButton} text-critical hover:bg-critical/10 hover:text-critical`}
            disabled={busy}
            onClick={onTrash}
            type="button"
          >
            <Trash2 className="size-4" aria-hidden="true" />
            Move to Trash
          </button>
        </div>
      </section>
    );
  }

  return (
    <section aria-label={`${label} Trash actions`} className="mt-6 border-l-2 border-caution bg-caution/[0.06] px-4 py-4">
      <h2 className="text-sm font-semibold text-ink">
        {deletionPending ? "Permanent deletion pending" : `${label} is in Trash`}
      </h2>
      <p className="mt-1 max-w-2xl text-xs leading-5 text-ink-secondary">
        {deletionPending
          ? "The durable deletion worker is removing relational evidence and settling every private object obligation. This item cannot be restored."
          : kind === "base"
            ? "Future runs cannot use this base. Restore it with its Source memberships and sharing settings, or delete only the base permanently."
            : "Future runs cannot use this Source. Restore its previous Base memberships, or permanently remove every version and stored object."}
      </p>
      {trashedAt ? (
        <p className="mt-2 text-metadata text-ink-muted">
          Deleted {formatDate(trashedAt)}
          {purgeScheduledAt
            ? deletionPending
              ? " · permanent purge in progress"
              : ` · purge scheduled ${formatDate(purgeScheduledAt)}`
            : ""}
        </p>
      ) : null}
      {!deletionPending ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button className={surfaceButton} disabled={busy} onClick={onRestore} type="button">
            <RotateCcw className="size-4" aria-hidden="true" />
            Restore
          </button>
          <button
            className={`${quietButton} text-critical hover:bg-critical/10 hover:text-critical`}
            disabled={busy}
            onClick={onDelete}
            type="button"
          >
            <Trash2 className="size-4" aria-hidden="true" />
            Delete permanently
          </button>
        </div>
      ) : null}
    </section>
  );
}

function DetailHeader({
  busy,
  detail,
  entryRef,
  onRequestClose
}: {
  busy: boolean;
  detail: KnowledgeDetailView;
  entryRef: Ref<HTMLButtonElement>;
  onRequestClose(): void;
}) {
  const base = detail.base;
  return (
    <header className="shrink-0 border-b border-trace-subtle px-3 py-3 sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-5xl min-w-0 flex-wrap items-center gap-2 sm:gap-3">
        <button ref={entryRef} className={quietButton} disabled={busy} onClick={onRequestClose} type="button">
          <ArrowLeft className="size-4" aria-hidden="true" />
          Back to Knowledge
        </button>
        <div className="order-last min-w-0 w-full sm:order-none sm:w-auto sm:flex-1">
          <h1 className="break-words text-xl font-semibold leading-6 tracking-tight text-ink [overflow-wrap:anywhere]">{base?.name ?? "Knowledge base"}</h1>
          <p className="text-metadata text-ink-muted">
            {base
              ? `${scopeText(base)} · ${base.sourceCount} ${base.sourceCount === 1 ? "Source" : "Sources"} · updated ${formatDate(base.updatedAt)}`
              : "Loading"}
          </p>
        </div>
        {base?.owned && !base.trashed && !detail.dirty ? (
          <button
            className={surfaceButton}
            disabled={busy}
            onClick={() => detail.onArchiveToggle(!base.archived)}
            type="button"
          >
            {base.archived ? <RefreshCcw className="size-4" aria-hidden="true" /> : <Archive className="size-4" aria-hidden="true" />}
            {base.archived ? "Restore" : "Archive"}
          </button>
        ) : null}
        {base?.owned && !base.trashed && detail.dirty ? (
          <button className={primaryButton} disabled={busy} onClick={detail.onSave} type="button">
            {detail.actionId === "settings" ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}
            Save settings
          </button>
        ) : null}
      </div>
    </header>
  );
}

function BaseOverview({ base }: { base: KnowledgeBaseSummary }) {
  const state = base.readiness.state;
  const tone = state === "ready"
    ? "text-positive"
    : state === "trashed"
      ? "text-caution"
    : state === "needs_attention"
      ? "text-critical"
      : state === "processing"
        ? "text-proof"
        : "text-ink-muted";
  return (
    <section aria-labelledby="knowledge-readiness-title" className="border-y border-trace-subtle py-4" data-testid="knowledge-readiness-summary">
      <div className="flex min-w-0 items-start gap-3">
        <span className={`mt-0.5 ${tone}`} aria-hidden="true">
          {state === "ready" ? <CircleCheck className="size-5" />
            : state === "needs_attention" ? <TriangleAlert className="size-5" />
              : state === "processing" ? <LoaderCircle className="size-5 animate-spin motion-reduce:animate-none" />
                : state === "archived" ? <Archive className="size-5" />
                  : state === "trashed" ? <Trash2 className="size-5" />
                  : <BookOpen className="size-5" />}
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink" id="knowledge-readiness-title">{readinessText(base.readiness)}</h2>
          <p className="mt-1 text-xs leading-5 text-ink-secondary">
            {state === "ready" ? "All current Sources are ready for future chats."
              : state === "processing" ? "Ready Sources stay available while the remaining Sources are processed."
                : state === "needs_attention" ? "Ready Sources stay available. Open the affected Source below."
                  : state === "archived" ? "Restore this base to add Sources."
                    : state === "trashed" ? "This base is excluded from future runs until restored."
                    : "Add Sources to make this base available in future chats."}
          </p>
          {base.readiness.supportReference ? (
            <p className="mt-1 text-metadata text-ink-muted">Support reference {base.readiness.supportReference}</p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function BaseSettings({ busy, detail }: { busy: boolean; detail: KnowledgeDetailView }) {
  const base = detail.base!;
  return (
    <section aria-labelledby="knowledge-settings-title" className="border-t border-trace-subtle py-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-ink" id="knowledge-settings-title">Base settings</h2>
          <p className="mt-1 text-xs leading-5 text-ink-muted">Update how this base is named and described throughout Knowledge.</p>
        </div>
        {base.archived ? <span className="rounded-pill bg-control-surface px-2 py-1 text-metadata font-medium text-ink-secondary">Archived</span> : null}
      </div>
      {base.owned ? (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label className={fieldLabel} htmlFor="knowledge-detail-name">Name</label>
            <input
              className={fieldInput}
              disabled={busy}
              id="knowledge-detail-name"
              maxLength={KNOWLEDGE_BASE_NAME_MAX_LENGTH}
              onChange={(event) => detail.onChange({ name: event.currentTarget.value })}
              value={detail.draft.name}
            />
          </div>
          <div className="sm:row-span-2">
            <label className={fieldLabel} htmlFor="knowledge-detail-description">Description</label>
            <textarea
              className={fieldTextarea}
              disabled={busy}
              id="knowledge-detail-description"
              maxLength={KNOWLEDGE_BASE_DESCRIPTION_MAX_LENGTH}
              onChange={(event) => detail.onChange({ description: event.currentTarget.value })}
              rows={4}
              value={detail.draft.description}
            />
          </div>
          {detail.error ? <p className="text-sm text-critical sm:col-span-2" role="alert">{detail.error.text}</p> : null}
        </div>
      ) : (
        <dl className="mt-4 grid gap-4 sm:grid-cols-2">
          <div><dt className="text-metadata text-ink-muted">Owner</dt><dd className="mt-1 text-sm text-ink">{base.ownerDisplayName}</dd></div>
          <div><dt className="text-metadata text-ink-muted">Description</dt><dd className="mt-1 whitespace-pre-wrap text-sm leading-6 text-ink-secondary">{base.description || "No description"}</dd></div>
        </dl>
      )}
    </section>
  );
}

function hasFileTransfer(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

const activeUploadStates = new Set<KnowledgeUploadItem["state"]>([
  "processing",
  "queued",
  "upload_complete",
  "uploading"
]);

function uploadState(item: KnowledgeUploadItem): { label: string; tone: string } {
  switch (item.state) {
    case "ready":
      return { label: "Ready", tone: "text-positive" };
    case "ready_with_warnings":
      return { label: "Ready with warnings", tone: "text-caution" };
    case "reused":
      return { label: "Already in library", tone: "text-positive" };
    case "needs_attention":
      return { label: "Needs attention", tone: "text-critical" };
    case "cancelled":
      return { label: "Cancelled", tone: "text-ink-muted" };
    case "upload_complete":
      return { label: "Verifying", tone: "text-proof" };
    case "processing":
      return { label: "Processing", tone: "text-proof" };
    case "uploading":
      return { label: "Uploading", tone: "text-proof" };
    default:
      return { label: "Queued", tone: "text-ink-secondary" };
  }
}

function uploadFailureText(code: string | null): string | null {
  if (!code) return null;
  const messages: Record<string, string> = {
    knowledge_checksum_mismatch: "The uploaded bytes did not match this file.",
    knowledge_processing_failed: "Processing could not produce a usable Source.",
    knowledge_storage_unavailable: "Private storage is temporarily unavailable.",
    knowledge_upload_session_expired: "The upload session expired. Select the file to retry.",
    knowledge_upload_size_mismatch: "The uploaded size did not match this file.",
    unsupported_type: "The file type or content is not supported."
  };
  return messages[code] ?? "This file could not be completed. Select it to retry.";
}

function uploadBatchSummary(batch: KnowledgeUploadBatch): string {
  const counts = {
    attention: 0,
    cancelled: 0,
    processing: 0,
    ready: 0,
    transferring: 0
  };
  for (const item of batch.items) {
    if (item.state === "ready" || item.state === "ready_with_warnings" || item.state === "reused") {
      counts.ready += 1;
    } else if (item.state === "needs_attention") counts.attention += 1;
    else if (item.state === "cancelled") counts.cancelled += 1;
    else if (item.state === "processing") counts.processing += 1;
    else counts.transferring += 1;
  }
  return [
    counts.ready > 0 ? `${counts.ready} ready` : null,
    counts.processing > 0 ? `${counts.processing} processing` : null,
    counts.transferring > 0 ? `${counts.transferring} transferring` : null,
    counts.attention > 0
      ? `${counts.attention} ${counts.attention === 1 ? "needs" : "need"} attention`
      : null,
    counts.cancelled > 0 ? `${counts.cancelled} cancelled` : null
  ].filter(Boolean).join(" · ");
}

function UploadManifest({ busy, detail }: { busy: boolean; detail: KnowledgeDetailView }) {
  if (detail.uploadBatches.length === 0) return null;
  return (
    <section aria-labelledby="knowledge-upload-activity-title" className="mt-4 border-y border-trace-subtle">
      <h3 className="sr-only" id="knowledge-upload-activity-title">Upload activity</h3>
      {detail.uploadBatches.map((batch, index) => {
        const active = batch.items.some((item) => activeUploadStates.has(item.state));
        return (
          <details
            className="border-b border-trace-subtle last:border-b-0"
            key={batch.id}
            open={active || index === 0}
          >
            <summary className={`cursor-pointer py-3 text-xs text-ink-secondary ${focusRing}`}>
              <span className="font-semibold text-ink">{uploadBatchSummary(batch)}</span>
              <span className="ml-2 text-ink-muted">{formatDate(batch.createdAt)}</span>
            </summary>
            <ul className="divide-y divide-trace-subtle" aria-label={`Files added ${formatDate(batch.createdAt)}`}>
              {batch.items.map((item) => {
                const state = uploadState(item);
                const live = Object.prototype.hasOwnProperty.call(detail.uploadProgress, item.id);
                const uploadedBytes = detail.uploadProgress[item.id] ?? item.uploadedBytes;
                const percentage = Math.min(100, Math.round(uploadedBytes / item.byteSize * 100));
                const canReselect = !live && (
                  item.state === "queued" || item.state === "uploading" ||
                  item.state === "needs_attention" && item.sourceId === null
                );
                const canCancel = item.state === "queued" || item.state === "uploading" ||
                  item.state === "upload_complete";
                const inputId = `knowledge-upload-resume-${safeDomId(item.id)}`;
                const failure = detail.uploadErrors[item.id] ?? uploadFailureText(item.failureCode);
                return (
                  <li
                    className="grid min-w-0 grid-cols-[1.5rem_minmax(0,1fr)_auto] gap-x-2 gap-y-2 py-3"
                    data-testid={`knowledge-upload-item-${item.id}`}
                    key={item.id}
                  >
                    <span className={`pt-0.5 ${state.tone}`} aria-hidden="true">
                      {item.state === "ready" || item.state === "reused"
                        ? <CircleCheck className="size-4" />
                        : item.state === "ready_with_warnings" || item.state === "needs_attention"
                          ? <TriangleAlert className="size-4" />
                          : activeUploadStates.has(item.state)
                            ? <LoaderCircle className="size-4 animate-spin" />
                            : <Clock3 className="size-4" />}
                    </span>
                    <div className="min-w-0">
                      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <p className="min-w-0 break-words text-sm font-medium text-ink [overflow-wrap:anywhere]">
                          {item.fileName}
                        </p>
                        <p className={`text-metadata font-medium ${state.tone}`}>{state.label}</p>
                      </div>
                      <p className="mt-0.5 text-metadata text-ink-muted">
                        {formatBytes(item.byteSize)}{item.attemptNumber > 1 ? ` · attempt ${item.attemptNumber}` : ""}
                      </p>
                      {(live || item.state === "uploading" || item.state === "queued") ? (
                        <div
                          aria-label={`${item.fileName} upload progress`}
                          aria-valuemax={100}
                          aria-valuemin={0}
                          aria-valuenow={percentage}
                          className="mt-2 h-1.5 overflow-hidden rounded-full bg-control-surface"
                          role="progressbar"
                        >
                          <div className="h-full rounded-full bg-proof transition-[width]" style={{ width: `${percentage}%` }} />
                        </div>
                      ) : null}
                      {failure ? <p className="mt-1 text-xs leading-5 text-critical">{failure}</p> : null}
                    </div>
                    <div className="flex flex-wrap justify-end gap-1">
                      {canReselect ? (
                        <label className={`${quietButton} cursor-pointer`} htmlFor={inputId}>
                          <RotateCcw className="size-4" aria-hidden="true" />
                          {item.state === "needs_attention" ? "Retry" : "Resume"}
                          <input
                            accept={KNOWLEDGE_UPLOAD_ACCEPT}
                            className="sr-only"
                            disabled={busy}
                            id={inputId}
                            onChange={(event) => {
                              const file = event.currentTarget.files?.[0];
                              if (file) detail.onResumeUpload(batch.id, item.id, file);
                              event.currentTarget.value = "";
                            }}
                            type="file"
                          />
                        </label>
                      ) : null}
                      {canCancel ? (
                        <button
                          className={quietButton}
                          disabled={busy}
                          onClick={() => detail.onCancelUpload(batch.id, item.id)}
                          type="button"
                        >
                          Cancel
                        </button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </details>
        );
      })}
    </section>
  );
}

function safeDomId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/gu, "-");
}

function SourcesSection({
  busy,
  detail,
  onPreviewSource,
  onRequestRemove
}: {
  busy: boolean;
  detail: KnowledgeDetailView;
  onPreviewSource?(sourceId: string, trigger: HTMLElement): void;
  onRequestRemove(target: RemoveTarget): void;
}) {
  const [dragActive, setDragActive] = useState(false);
  const dragDepth = useRef(0);
  const base = detail.base!;
  const response = detail.sources!;
  const sources = response.sources;
  const pagination = response.pagination;
  const firstSource = pagination.totalItems === 0
    ? 0
    : (pagination.page - 1) * pagination.pageSize + 1;
  const lastSource = pagination.totalItems === 0 ? 0 : firstSource + sources.length - 1;
  const uploadDisabled = busy || base.archived || !base.owned;
  const acceptFiles = (files: FileList | null) => {
    if (!files || uploadDisabled) return;
    const selected = Array.from(files);
    if (selected.length > 0) detail.onUpload(selected);
  };
  return (
    <section aria-labelledby="knowledge-sources-title" className="border-t border-trace-subtle py-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-ink" id="knowledge-sources-title">Sources</h2>
          <p className="mt-1 text-xs leading-5 text-ink-muted">
            {pagination.totalItems === 0
              ? `0 ${pagination.query ? "matching " : ""}Sources`
              : `Showing ${firstSource}–${lastSource} of ${pagination.totalItems}${pagination.query ? " matching" : ""}`}
            {" · each Source has one version history across every base"}
          </p>
        </div>
        <button className={quietButton} disabled={busy} onClick={detail.onRefresh} type="button">
          <RefreshCcw className="size-4" aria-hidden="true" />
          Refresh status
        </button>
      </div>
      {base.owned ? (
        <div
          className={`mt-4 rounded-panel border border-dashed px-4 py-5 transition-colors ${
            dragActive ? "border-proof bg-control-selected" : "border-control-boundary bg-control-surface"
          } ${uploadDisabled ? "opacity-60" : ""}`}
          data-drop-active={dragActive || undefined}
          data-testid="knowledge-drop-zone"
          onDragEnter={(event) => {
            if (!hasFileTransfer(event)) return;
            event.preventDefault();
            dragDepth.current += 1;
            setDragActive(true);
          }}
          onDragLeave={(event) => {
            if (!hasFileTransfer(event)) return;
            event.preventDefault();
            dragDepth.current = Math.max(0, dragDepth.current - 1);
            if (dragDepth.current === 0) setDragActive(false);
          }}
          onDragOver={(event) => {
            if (!hasFileTransfer(event)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = uploadDisabled ? "none" : "copy";
          }}
          onDrop={(event) => {
            if (!hasFileTransfer(event)) return;
            event.preventDefault();
            dragDepth.current = 0;
            setDragActive(false);
            acceptFiles(event.dataTransfer.files);
          }}
        >
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink">
                {dragActive ? "Drop files to add Sources" : "Add Sources"}
              </p>
              <p className="mt-1 text-xs leading-5 text-ink-muted">
                {knowledgeUploadHelp(detail.maxUploadBytes)} Each file becomes a reusable Source.
              </p>
            </div>
            <label className={`${surfaceButton} ${uploadDisabled ? "pointer-events-none" : "cursor-pointer"}`}>
              <Upload className="size-4" aria-hidden="true" />
              Choose files
              <input
                accept={KNOWLEDGE_UPLOAD_ACCEPT}
                className="sr-only"
                disabled={uploadDisabled}
                multiple
                onChange={(event) => {
                  acceptFiles(event.currentTarget.files);
                  event.currentTarget.value = "";
                }}
                type="file"
              />
            </label>
          </div>
          {base.archived ? (
            <p className="mt-3 text-xs font-medium text-caution">
              Restore this base before adding Sources.
            </p>
          ) : null}
        </div>
      ) : null}
      <UploadManifest busy={busy} detail={detail} />
      <label className="relative mt-4 block w-full max-w-sm" htmlFor="knowledge-source-search-in-base">
        <span className="sr-only">Search Sources in this base</span>
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-muted"
        />
        <input
          autoComplete="off"
          className={`${fieldInput} pl-9`}
          disabled={busy}
          id="knowledge-source-search-in-base"
          maxLength={KNOWLEDGE_SOURCE_SEARCH_MAX_LENGTH}
          onChange={(event) => detail.onSourceQueryChange(event.currentTarget.value)}
          placeholder="Search Source names, files, or tags"
          type="search"
          value={detail.sourceQuery}
        />
      </label>
      {sources.length === 0 ? (
        <div className="py-10 text-center">
          <Files className="mx-auto size-6 text-ink-muted" aria-hidden="true" />
          <p className="mt-3 text-sm font-semibold text-ink">
            {detail.sourceQuery ? "No Sources match this search" : "No Sources in this base"}
          </p>
          <p className="mt-1 text-xs leading-5 text-ink-muted">
            {detail.sourceQuery
              ? "Try another name, filename, or tag. Source contents are not searched here."
              : "Add one or more files when you are ready."}
          </p>
        </div>
      ) : (
        <ul className="mt-4 divide-y divide-trace-subtle border-y border-trace-subtle" aria-label="Sources in this Knowledge base">
          {sources.map((source) => (
            <SourceMembershipRow
              key={source.id}
              baseId={base.id}
              baseName={base.name}
              busy={busy}
              detail={detail}
              onPreviewSource={onPreviewSource}
              onRequestRemove={onRequestRemove}
              source={source}
            />
          ))}
        </ul>
      )}
      {pagination.totalPages > 1 ? (
        <nav
          aria-label="Knowledge Source pages"
          className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-trace-subtle pt-4"
        >
          <p className="text-xs text-ink-muted">Page {pagination.page} of {pagination.totalPages}</p>
          <div className="flex gap-2">
            <button
              className={quietButton}
              disabled={busy || pagination.page <= 1}
              onClick={() => detail.onSourcePageChange(pagination.page - 1)}
              type="button"
            >
              Previous
            </button>
            <button
              className={quietButton}
              disabled={busy || pagination.page >= pagination.totalPages}
              onClick={() => detail.onSourcePageChange(pagination.page + 1)}
              type="button"
            >
              Next
            </button>
          </div>
        </nav>
      ) : null}
    </section>
  );
}

function SourceMembershipRow({
  baseId,
  baseName,
  busy,
  detail,
  onPreviewSource,
  onRequestRemove,
  source
}: {
  baseId: string;
  baseName: string;
  busy: boolean;
  detail: KnowledgeDetailView;
  onPreviewSource?(sourceId: string, trigger: HTMLElement): void;
  onRequestRemove(target: RemoveTarget): void;
  source: KnowledgeSourceSummary;
}) {
  const state = sourceStatus(source);
  const version = source.currentVersion;
  const actionPending = detail.actionId === `base-source:${source.id}:remove`;
  return (
    <li className="grid min-w-0 grid-cols-[1.5rem_minmax(0,1fr)] gap-2 py-4" data-testid={`knowledge-source-${source.id}`}>
      <span className={`pt-1 ${state.tone}`} aria-hidden="true">
        {source.readiness.state === "ready"
          ? source.readiness.warningCodes.length > 0
            ? <TriangleAlert className="size-4" />
            : <CircleCheck className="size-4" />
          : source.readiness.state === "needs_attention"
            ? <TriangleAlert className="size-4" />
            : <Clock3 className="size-4" />}
      </span>
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-1">
          <div className="min-w-0">
            <p className="break-words text-sm font-semibold text-ink [overflow-wrap:anywhere]">{source.name}</p>
            <p className="mt-0.5 break-words text-metadata text-ink-muted [overflow-wrap:anywhere]">
              {version?.fileName ?? "Waiting for first ready version"}
              {version ? ` · ${formatBytes(version.byteSize)}` : ""}
              {version?.pageCount !== null && version?.pageCount !== undefined
                ? ` · ${version.pageCount} page${version.pageCount === 1 ? "" : "s"}`
                : ""}
              {` · updated ${formatDate(source.updatedAt)}`}
            </p>
          </div>
          <p className={`text-metadata font-medium ${state.tone}`}>{state.label}</p>
        </div>
        {source.replacement.state === "processing" ? (
          <p className="mt-2 text-xs leading-5 text-ink-secondary">
            Replacement processing; the current ready version remains available.
          </p>
        ) : source.replacement.state === "needs_attention" ? (
          <p className="mt-2 text-xs leading-5 text-critical">
            Replacement needs attention. Open the Source to retry or replace it.
          </p>
        ) : source.readiness.state === "needs_attention" ? (
          <p className="mt-2 text-xs leading-5 text-critical">
            Processing needs attention. Open the Source to retry or replace it.
          </p>
        ) : null}
        {source.readiness.state === "ready" && source.readiness.warningCodes.length > 0 ? (
          <ul className="mt-2 list-disc space-y-1 pl-4 text-xs leading-5 text-ink-secondary">
            {processingWarningLabels(source.readiness.warningCodes).map((label) => (
              <li key={label}>{label}</li>
            ))}
          </ul>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-1">
          {onPreviewSource && version?.readiness.state === "ready" ? (
            <button
              className={quietButton}
              disabled={busy}
              onClick={(event) => onPreviewSource(source.id, event.currentTarget)}
              type="button"
            >
              <FileSearch className="size-4" aria-hidden="true" />
              Preview
            </button>
          ) : null}
          <button className={surfaceButton} disabled={busy} onClick={() => detail.onOpenSource(source.id)} type="button">
            <ArrowRight className="size-4" aria-hidden="true" />
            Open Source
          </button>
          {detail.base?.owned ? (
            <button
              className={`${quietButton} text-critical hover:bg-critical/10 hover:text-critical`}
              disabled={busy}
              onClick={() => onRequestRemove({
                baseId,
                baseName,
                kind: "membership",
                sourceId: source.id,
                sourceName: source.name
              })}
              type="button"
            >
              Remove from base
            </button>
          ) : null}
          {actionPending ? (
            <LoaderCircle className="m-2 size-4 animate-spin text-proof" aria-label="Source action in progress" />
          ) : null}
        </div>
      </div>
    </li>
  );
}

function PublicationSection({ busy, detail }: { busy: boolean; detail: KnowledgeDetailView }) {
  const base = detail.base!;
  const [scope, setScope] = useState<"group" | "installation">("group");
  const [groupId, setGroupId] = useState(detail.publishableGroups[0]?.id ?? "");
  const publications = base.publications ?? [];
  const canPublishGroup = detail.publishableGroups.length > 0;
  const effectiveGroupId = detail.publishableGroups.some((group) => group.id === groupId)
    ? groupId
    : detail.publishableGroups[0]?.id ?? "";
  const canPublish = scope === "installation"
    ? detail.canPublishInstallation
    : canPublishGroup && Boolean(effectiveGroupId);
  return (
    <section aria-labelledby="knowledge-publication-title" className="border-t border-trace-subtle py-6">
      <h2 className="text-base font-semibold text-ink" id="knowledge-publication-title">Publication</h2>
      <p className="mt-1 border-l-2 border-proof/45 pl-3 text-xs leading-5 text-ink-secondary" data-testid="knowledge-publication-disclosure">
        Publishing grants the selected audience live access to this base’s current and future content. Revoking stops future access; already accepted runs are unchanged.
      </p>
      {publications.length > 0 ? (
        <ul className="mt-4 divide-y divide-trace-subtle border-y border-trace-subtle" aria-label="Current Knowledge publications">
          {publications.map((publication) => (
            <li key={publication.id} className="flex min-w-0 flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="break-words text-sm font-medium text-ink [overflow-wrap:anywhere]">
                  {publication.scope === "installation"
                    ? "Entire installation"
                    : publication.scope === "project"
                      ? "Project publication"
                      : publication.groupName ?? "Group"}
                </p>
                <p className="mt-0.5 text-metadata text-ink-muted">
                  {publication.scope === "project"
                    ? "Project details stay private after membership loss · published"
                    : "Live access · updated"} {formatDate(publication.updatedAt)}
                </p>
              </div>
              <button
                className={`${quietButton} text-critical hover:bg-critical/10 hover:text-critical`}
                disabled={busy}
                onClick={() => detail.onRevokePublication(publication.id)}
                type="button"
              >
                {detail.actionId === `publication:${publication.id}` ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}
                Revoke
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-sm text-ink-muted">Private — no current publications.</p>
      )}
      <div className="mt-4 grid gap-3 sm:grid-cols-[12rem_minmax(0,1fr)_auto] sm:items-end">
        <div>
          <label className={fieldLabel} htmlFor="knowledge-publication-scope">Audience type</label>
          <select
            className={fieldInput}
            disabled={busy || base.archived}
            id="knowledge-publication-scope"
            onChange={(event) => setScope(event.currentTarget.value as "group" | "installation")}
            value={scope}
          >
            <option value="group">Group</option>
            {detail.canPublishInstallation ? <option value="installation">Installation</option> : null}
          </select>
        </div>
        <div>
          <label className={fieldLabel} htmlFor="knowledge-publication-group">Audience</label>
          {scope === "group" ? (
            <select
              className={fieldInput}
              disabled={busy || base.archived || !canPublishGroup}
              id="knowledge-publication-group"
              onChange={(event) => setGroupId(event.currentTarget.value)}
              value={effectiveGroupId}
            >
              {canPublishGroup ? detail.publishableGroups.map((group) => (
                <option key={group.id} value={group.id}>{group.name}</option>
              )) : <option value="">No eligible groups</option>}
            </select>
          ) : (
            <div className="flex min-h-touch items-center rounded-control bg-control-surface px-3 text-sm text-ink-secondary sm:min-h-control">Entire installation</div>
          )}
        </div>
        <button
          className={surfaceButton}
          disabled={busy || base.archived || !canPublish}
          onClick={() => detail.onPublish(
            scope === "installation"
              ? { groupId: null, scope }
              : { groupId: effectiveGroupId, scope }
          )}
          type="button"
        >
          {detail.actionId === "publication" ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}
          Publish
        </button>
      </div>
    </section>
  );
}
