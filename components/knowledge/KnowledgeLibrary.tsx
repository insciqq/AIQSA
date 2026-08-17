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
  KnowledgeListView
} from "@/components/knowledge/libraryViewContracts";
import {
  KNOWLEDGE_BASE_DESCRIPTION_MAX_LENGTH,
  KNOWLEDGE_BASE_NAME_MAX_LENGTH,
  KNOWLEDGE_DOCUMENT_SEARCH_MAX_LENGTH,
  type KnowledgeBaseSummary,
  type KnowledgeDocumentStatus,
  type KnowledgeDocumentVersionStatus,
  type KnowledgeEmbeddingDeployment,
  type KnowledgeReindexProgress
} from "@/lib/contracts/knowledge";
import {
  Archive,
  ArrowLeft,
  BookOpen,
  FileText,
  LoaderCircle,
  Plus,
  RefreshCcw,
  RotateCcw,
  Search,
  Upload
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type Ref
} from "react";

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

type RemoveTarget = { documentId: string; fileName: string };

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

function deploymentLabel(deployment: KnowledgeEmbeddingDeployment): string {
  return `${deployment.connectionDisplayName} / ${deployment.modelDisplayName}`;
}

function scopeText(base: KnowledgeBaseSummary): string {
  if (base.owned) return "Yours";
  if (base.scope.kind === "group") return `Shared with ${base.scope.groupNames.join(", ")}`;
  return "Shared with the installation";
}

function hasTransientWork(detail: KnowledgeDetailView | null): boolean {
  if (!detail?.ingestion) return false;
  const transientDocument = detail.ingestion.documents.some((document) =>
    document.versions.some(
      (version) =>
        version.current &&
        (version.state === "queued" ||
          version.state === "parsing" ||
          version.state === "chunking" ||
          version.state === "embedding")
    )
  );
  return transientDocument || detail.ingestion.reindex?.status === "building" ||
    detail.ingestion.reindex?.status === "ready";
}

export function KnowledgeLibrary({
  restoreFocus,
  view
}: {
  restoreFocus?(): HTMLElement | null;
  view: KnowledgeLibraryView;
}) {
  const [discardConfirmationOpen, setDiscardConfirmationOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<RemoveTarget | null>(null);
  const taskEntryRef = useRef<HTMLButtonElement>(null);
  const childDialogOpen = discardConfirmationOpen || removeTarget !== null;
  const dirty = view.task === "create" ? view.create?.dirty : view.task === "detail" ? view.detail?.dirty : false;
  useBeforeUnloadGuard(Boolean(dirty));
  const closeTask = view.task === "create"
    ? view.create?.onCancel
    : view.task === "detail"
      ? view.detail?.onBack
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

  const transientSignature = view.detail?.ingestion
    ? JSON.stringify({
        documents: view.detail.ingestion.documents.map((document) =>
          document.versions.map((version) => [version.id, version.state, version.embeddedChunks])
        ),
        reindex: view.detail.ingestion.reindex?.status ?? null
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
            onRequestRemove={setRemoveTarget}
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
          label={view.task === "create" ? "Knowledge base draft" : "Knowledge base settings"}
          onCancel={() => setDiscardConfirmationOpen(false)}
          onConfirm={() => {
            setDiscardConfirmationOpen(false);
            closeTask?.();
          }}
        />
      ) : null}
      {removeTarget ? (
        <ConfirmationDialog
          confirmLabel="Remove document"
          dialogLabel={`Remove ${removeTarget.fileName} from this Knowledge base`}
          icon="x"
          onCancel={() => setRemoveTarget(null)}
          onConfirm={() => {
            view.detail?.onRemoveDocument(removeTarget.documentId);
            setRemoveTarget(null);
          }}
          testId="remove-knowledge-document-confirmation"
          title="Remove document from this base?"
          tone="warning"
        >
          This closes the document’s current visibility. Historical version identity and accepted-run bindings are retained.
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
  ["archived", "Archived"]
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
        base.ownerDisplayName,
        base.activeGeneration.embeddingDeployment?.connectionDisplayName ?? "",
        base.activeGeneration.embeddingDeployment?.modelDisplayName ?? ""
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
            <span className="sr-only">Search Knowledge bases</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-muted" aria-hidden="true" />
            <input
              className={`${fieldInput} pl-9`}
              disabled={busy}
              id="knowledge-search"
              onChange={(event) => list.onQueryChange(event.currentTarget.value)}
              placeholder="Search Knowledge"
              type="search"
              value={list.query}
            />
          </label>
          <button className={`${primaryButton} col-start-3 row-start-1 sm:col-start-4`} disabled={busy} onClick={list.onNewBase} type="button">
            <Plus className="size-4" aria-hidden="true" />
            New base
          </button>
        </div>
      </header>
      {notice ? <NoticeRow notice={notice} onDismiss={onDismissNotice} /> : null}
      {dataState === "loading" ? (
        <TaskLoading label="Loading Knowledge…" />
      ) : dataState === "error" ? (
        <TaskFailure error={dataError} onRetry={onRetry} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4 sm:px-6 lg:px-8">
          <div className="mx-auto w-full max-w-6xl">
            <div aria-label="Knowledge filters" className="flex flex-wrap gap-2" role="group">
              {FILTERS.map(([filter, label]) => (
                <button
                  key={filter}
                  aria-pressed={list.filter === filter}
                  className={filterButton(list.filter === filter)}
                  disabled={busy}
                  onClick={() => list.onFilterChange(filter)}
                  type="button"
                >
                  {label}
                </button>
              ))}
            </div>
            {list.knowledgeBases.length === 0 ? (
              <div className="py-16 text-center">
                <BookOpen className="mx-auto size-7 text-ink-muted" aria-hidden="true" />
                <p className="mt-3 text-sm font-semibold text-ink">No Knowledge bases yet</p>
                <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-ink-muted">
                  Create a private base, then add documents and let indexing build its retrieval index.
                </p>
                <button className={`${surfaceButton} mt-4`} onClick={list.onNewBase} type="button">
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

function BaseRow({ base, busy, list }: { base: KnowledgeBaseSummary; busy: boolean; list: KnowledgeListView }) {
  const caughtUp = base.activeGeneration.indexedContentRevision >= base.contentRevision;
  const deployment = base.activeGeneration.embeddingDeployment;
  return (
    <li className="group flex min-w-0 items-stretch gap-1 bg-answer-paper hover:bg-control-hover/50" data-testid={`knowledge-base-${base.id}`}>
      <button
        className={`grid min-w-0 flex-1 grid-cols-[1.75rem_minmax(0,1fr)] gap-3 px-2 py-4 text-left sm:px-3 ${focusRing}`}
        disabled={busy}
        onClick={() => list.onOpenBase(base.id)}
        type="button"
      >
        <span className="flex min-h-full flex-col items-center pt-0.5" aria-hidden="true">
          <span className={`size-2.5 rounded-full ${base.archived ? "bg-ink-muted" : caughtUp ? "bg-positive" : "bg-caution"}`} />
          <span className="mt-1 min-h-6 w-px flex-1 bg-trace-strong" />
          <span className="mt-1 size-1.5 rounded-full bg-proof" />
        </span>
        <span className="min-w-0">
          <span className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-1">
            <span className="break-words text-sm font-semibold leading-5 text-ink [overflow-wrap:anywhere]">{base.name}</span>
            <span className={`text-metadata font-medium ${base.archived ? "text-ink-muted" : caughtUp ? "text-positive" : "text-caution"}`}>
              {base.archived ? "Archived" : caughtUp ? "Index ready" : "Indexing changes"}
            </span>
          </span>
          {base.description ? (
            <span className="mt-1 line-clamp-2 block break-words text-xs leading-5 text-ink-secondary [overflow-wrap:anywhere]">
              {base.description}
            </span>
          ) : null}
          <span className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-metadata text-ink-muted">
            <span>{scopeText(base)}</span>
            <span>Content revision {base.contentRevision}</span>
            <span>Indexed revision {base.activeGeneration.indexedContentRevision}</span>
            {deployment ? <span>{deploymentLabel(deployment)}</span> : null}
          </span>
        </span>
      </button>
      {base.owned ? (
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

function EgressDisclosure({ deployment }: { deployment: KnowledgeEmbeddingDeployment | null }) {
  return (
    <p className="mt-3 border-l-2 border-proof/45 pl-3 text-xs leading-5 text-ink-secondary" data-testid="knowledge-egress-disclosure">
      {deployment
        ? `Indexing sends this base’s document text to ${deployment.connectionDisplayName} / ${deployment.modelDisplayName} for embedding. This happens outside chat runs and repeats when the base is reindexed.`
        : "Choose an available embedding deployment to see the exact indexing destination."}
    </p>
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
  const deployment = create.embeddingDeployments.find(
    (candidate) => candidate.id === create.draft.embeddingDeploymentId
  ) ?? null;
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
          <section aria-labelledby="knowledge-create-index" className="mt-8 border-t border-trace-subtle pt-6">
            <h2 className="text-base font-semibold text-ink" id="knowledge-create-index">Index destination</h2>
            <p className="mt-1 text-xs leading-5 text-ink-muted">The selected deployment fixes this base’s initial vector space.</p>
            {create.embeddingDeployments.length > 0 ? (
              <div className="mt-4">
                <label className={fieldLabel} htmlFor="knowledge-create-deployment">Embedding deployment</label>
                <select
                  className={fieldInput}
                  disabled={busy}
                  id="knowledge-create-deployment"
                  onChange={(event) => create.onChange({ embeddingDeploymentId: event.currentTarget.value })}
                  value={create.draft.embeddingDeploymentId}
                >
                  {create.embeddingDeployments.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>{deploymentLabel(candidate)}</option>
                  ))}
                </select>
              </div>
            ) : (
              <p className="mt-4 rounded-control border border-caution/35 bg-caution/10 px-3 py-2 text-sm text-ink-secondary" role="alert">
                No entitled embedding deployment supports Knowledge indexing. Ask an administrator to configure access.
              </p>
            )}
            <EgressDisclosure deployment={deployment} />
          </section>
          {create.error ? (
            <p className="mt-6 text-sm text-critical" role="alert">{create.error.text}</p>
          ) : null}
          <div className="mt-8 flex flex-wrap justify-end gap-2 border-t border-trace-subtle pt-4">
            <button className={quietButton} disabled={busy} onClick={onRequestClose} type="button">Cancel</button>
            <button className={primaryButton} disabled={busy || create.embeddingDeployments.length === 0} type="submit">
              {create.saving ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}
              Create base
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
  onRequestRemove,
  onRetry
}: {
  busy: boolean;
  detail: KnowledgeDetailView;
  entryRef: Ref<HTMLButtonElement>;
  notice: KnowledgeLibraryNotice | null;
  onDismissNotice(): void;
  onRequestClose(): void;
  onRequestRemove(target: RemoveTarget): void;
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
  if (detail.dataState === "error" || !detail.base || !detail.ingestion) {
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
                {scopeText(detail.base)}. The owner controls documents, indexing, and publication.
              </p>
            </div>
          ) : null}
          <RevisionSpine detail={detail} />
          <BaseSettings busy={busy} detail={detail} />
          <DocumentsSection busy={busy} detail={detail} onRequestRemove={onRequestRemove} />
          {detail.base.owned ? (
            <>
              <ReindexSection busy={busy} detail={detail} />
              <PublicationSection busy={busy} detail={detail} />
            </>
          ) : null}
        </div>
      </div>
    </div>
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
            {base ? `${scopeText(base)} · Content revision ${base.contentRevision}` : "Loading"}
          </p>
        </div>
        {base?.owned && !detail.dirty ? (
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
        {base?.owned && detail.dirty ? (
          <button className={primaryButton} disabled={busy} onClick={detail.onSave} type="button">
            {detail.actionId === "settings" ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}
            Save settings
          </button>
        ) : null}
      </div>
    </header>
  );
}

function RevisionSpine({ detail }: { detail: KnowledgeDetailView }) {
  const base = detail.base!;
  const generation = base.activeGeneration;
  const deployment = generation.embeddingDeployment;
  const caughtUp = generation.indexedContentRevision >= base.contentRevision;
  return (
    <section aria-labelledby="knowledge-lifecycle-title" className="pb-6">
      <h2 className="text-base font-semibold text-ink" id="knowledge-lifecycle-title">Index lifecycle</h2>
      <ol className="mt-4 grid gap-0 sm:grid-cols-3" data-testid="knowledge-revision-spine">
        <LifecycleStep
          detail={`Revision ${base.contentRevision}`}
          first
          label="Current content"
          tone="proof"
        />
        <LifecycleStep
          detail={`Revision ${generation.indexedContentRevision} · generation ${generation.id.slice(0, 8)}`}
          label={caughtUp ? "Active index" : "Index catching up"}
          tone={caughtUp ? "positive" : "caution"}
        />
        <LifecycleStep
          detail={deployment ? deploymentLabel(deployment) : "Destination hidden by access policy"}
          label="Embedding space"
          last
          tone="muted"
        />
      </ol>
    </section>
  );
}

function LifecycleStep({
  detail,
  first = false,
  label,
  last = false,
  tone
}: {
  detail: string;
  first?: boolean;
  label: string;
  last?: boolean;
  tone: "caution" | "muted" | "positive" | "proof";
}) {
  const dot = tone === "positive" ? "bg-positive" : tone === "caution" ? "bg-caution" : tone === "proof" ? "bg-proof" : "bg-ink-muted";
  return (
    <li className="grid min-w-0 grid-cols-[1.5rem_minmax(0,1fr)] gap-2 sm:grid-cols-1 sm:grid-rows-[1.25rem_auto] sm:gap-1">
      <span className="relative flex h-full min-h-12 items-start justify-center sm:min-h-0 sm:items-center" aria-hidden="true">
        {!first ? <span className="absolute bottom-1/2 top-0 w-px bg-trace-strong sm:bottom-auto sm:left-0 sm:right-1/2 sm:top-1/2 sm:h-px sm:w-auto" /> : null}
        <span className={`relative z-10 mt-1 size-2.5 rounded-full sm:mt-0 ${dot}`} />
        {!last ? <span className="absolute bottom-0 top-1/2 w-px bg-trace-strong sm:bottom-auto sm:left-1/2 sm:right-0 sm:top-1/2 sm:h-px sm:w-auto" /> : null}
      </span>
      <span className="min-w-0 pb-4 sm:px-2 sm:pb-0 sm:text-center">
        <span className="block text-xs font-semibold text-ink">{label}</span>
        <span className="mt-0.5 block break-words text-metadata text-ink-muted [overflow-wrap:anywhere]">{detail}</span>
      </span>
    </li>
  );
}

function BaseSettings({ busy, detail }: { busy: boolean; detail: KnowledgeDetailView }) {
  const base = detail.base!;
  return (
    <section aria-labelledby="knowledge-settings-title" className="border-t border-trace-subtle py-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-ink" id="knowledge-settings-title">Base settings</h2>
          <p className="mt-1 text-xs leading-5 text-ink-muted">Identity changes do not rewrite indexed content or accepted bindings.</p>
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

function DocumentsSection({
  busy,
  detail,
  onRequestRemove
}: {
  busy: boolean;
  detail: KnowledgeDetailView;
  onRequestRemove(target: RemoveTarget): void;
}) {
  const [dragActive, setDragActive] = useState(false);
  const dragDepth = useRef(0);
  const base = detail.base!;
  const ingestion = detail.ingestion!;
  const documents = ingestion.documents;
  const pagination = ingestion.pagination;
  const activeDocuments = documents.filter((document) => !document.archived);
  const removedDocuments = documents.filter((document) => document.archived);
  const firstDocument = pagination.totalItems === 0
    ? 0
    : (pagination.page - 1) * pagination.pageSize + 1;
  const lastDocument = pagination.totalItems === 0
    ? 0
    : firstDocument + documents.length - 1;
  const uploadDisabled = busy || base.archived || !base.owned;
  const acceptFiles = (files: FileList | null) => {
    if (!files || uploadDisabled) return;
    const selected = Array.from(files);
    if (selected.length > 0) detail.onUpload(selected);
  };
  return (
    <section aria-labelledby="knowledge-documents-title" className="border-t border-trace-subtle py-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-ink" id="knowledge-documents-title">Documents</h2>
          <p className="mt-1 text-xs leading-5 text-ink-muted">
            {pagination.totalItems === 0
              ? `0 ${pagination.query ? "matching " : ""}documents`
              : `Showing ${firstDocument}–${lastDocument} of ${pagination.totalItems}${pagination.query ? " matching" : ""}`}
            {documents.length > 0
              ? ` · ${activeDocuments.length} current · ${removedDocuments.length} removed on this page`
              : ""}
            {" · metadata and lifecycle only"}
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
              <p className="text-sm font-semibold text-ink">{dragActive ? "Drop documents to add them" : "Add documents"}</p>
              <p className="mt-1 text-xs leading-5 text-ink-muted">
                Select several supported files or drag them here. Each receives its own truthful indexing status.
              </p>
            </div>
            <label className={`${surfaceButton} ${uploadDisabled ? "pointer-events-none" : "cursor-pointer"}`}>
              <Upload className="size-4" aria-hidden="true" />
              Choose files
              <input
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
          {base.archived ? <p className="mt-3 text-xs font-medium text-caution">Restore this base before adding documents.</p> : null}
          {detail.upload ? (
            <p className="mt-3 flex items-center gap-2 text-xs text-ink-secondary" role="status">
              <LoaderCircle className="size-4 animate-spin text-proof" aria-hidden="true" />
              Uploading {detail.upload.current} of {detail.upload.total}: <span className="min-w-0 truncate">{detail.upload.fileName}</span>
            </p>
          ) : null}
        </div>
      ) : null}
      <label className="relative mt-4 block w-full max-w-sm" htmlFor="knowledge-document-search">
        <span className="sr-only">Search documents by filename</span>
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-muted"
        />
        <input
          autoComplete="off"
          className={`${fieldInput} pl-9`}
          disabled={busy}
          id="knowledge-document-search"
          maxLength={KNOWLEDGE_DOCUMENT_SEARCH_MAX_LENGTH}
          onChange={(event) => detail.onDocumentQueryChange(event.currentTarget.value)}
          placeholder="Search filenames"
          type="search"
          value={detail.documentQuery}
        />
      </label>
      {documents.length === 0 ? (
        <div className="py-10 text-center">
          <FileText className="mx-auto size-6 text-ink-muted" aria-hidden="true" />
          <p className="mt-3 text-sm font-semibold text-ink">
            {detail.documentQuery ? "No documents match this filename" : "No current documents"}
          </p>
          <p className="mt-1 text-xs leading-5 text-ink-muted">
            {detail.documentQuery
              ? "Try another filename. Search is case-insensitive and does not inspect document contents."
              : "This base is valid and returns an honest empty retrieval result."}
          </p>
        </div>
      ) : (
        <ul className="mt-4 divide-y divide-trace-subtle border-y border-trace-subtle" aria-label="Current Knowledge documents">
          {activeDocuments.map((document) => (
            <DocumentRow
              key={document.id}
              busy={busy}
              detail={detail}
              document={document}
              onRequestRemove={onRequestRemove}
            />
          ))}
        </ul>
      )}
      {removedDocuments.length > 0 ? (
        <details className="mt-4 border-t border-trace-subtle pt-3">
          <summary className={`cursor-pointer text-xs font-medium text-ink-secondary ${focusRing}`}>
            Removed document history ({removedDocuments.length})
          </summary>
          <ul className="mt-3 divide-y divide-trace-subtle" aria-label="Removed Knowledge documents">
            {removedDocuments.map((document) => (
              <DocumentRow key={document.id} busy={busy} detail={detail} document={document} onRequestRemove={onRequestRemove} />
            ))}
          </ul>
        </details>
      ) : null}
      {pagination.totalPages > 1 ? (
        <nav
          aria-label="Knowledge document pages"
          className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-trace-subtle pt-4"
        >
          <p className="text-xs text-ink-muted">
            Page {pagination.page} of {pagination.totalPages}
          </p>
          <div className="flex gap-2">
            <button
              className={quietButton}
              disabled={busy || pagination.page <= 1}
              onClick={() => detail.onDocumentPageChange(pagination.page - 1)}
              type="button"
            >
              Previous
            </button>
            <button
              className={quietButton}
              disabled={busy || pagination.page >= pagination.totalPages}
              onClick={() => detail.onDocumentPageChange(pagination.page + 1)}
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

function currentVersion(document: KnowledgeDocumentStatus): KnowledgeDocumentVersionStatus | null {
  return document.versions.find((version) => version.id === document.currentVersionId) ??
    document.versions.find((version) => version.current) ??
    document.versions[0] ?? null;
}

function versionState(version: KnowledgeDocumentVersionStatus): { label: string; tone: string } {
  if (version.state === "ready") {
    return { label: `${version.totalChunks ?? version.embeddedChunks} chunks ready`, tone: "text-positive" };
  }
  if (version.state === "failed") return { label: "Indexing failed", tone: "text-critical" };
  if (version.state === "embedding") {
    return {
      label: version.totalChunks === null
        ? "Embedding chunks"
        : `Embedding ${version.embeddedChunks} of ${version.totalChunks} chunks`,
      tone: "text-proof"
    };
  }
  return {
    label: version.state === "queued" ? "Queued" : version.state === "parsing" ? "Parsing" : "Chunking",
    tone: "text-proof"
  };
}

function safeDomId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/gu, "-");
}

function DocumentRow({
  busy,
  detail,
  document,
  onRequestRemove
}: {
  busy: boolean;
  detail: KnowledgeDetailView;
  document: KnowledgeDocumentStatus;
  onRequestRemove(target: RemoveTarget): void;
}) {
  const version = currentVersion(document);
  if (!version) return null;
  const state = versionState(version);
  const replacementId = `knowledge-replace-${safeDomId(document.id)}`;
  const actionPending = detail.actionId?.startsWith(`document:${document.id}:`) ?? false;
  return (
    <li className="grid min-w-0 grid-cols-[1.5rem_minmax(0,1fr)] gap-2 py-4" data-testid={`knowledge-document-${document.id}`}>
      <span className="flex min-h-full flex-col items-center pt-1" aria-hidden="true">
        <span className={`size-2.5 rounded-full ${document.archived ? "bg-ink-muted" : version.state === "failed" ? "bg-critical" : version.state === "ready" ? "bg-positive" : "bg-proof"}`} />
        <span className="mt-1 min-h-5 w-px flex-1 bg-trace-strong" />
        <span className="mt-1 size-1.5 rounded-full bg-ink-muted" />
      </span>
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-1">
          <div className="min-w-0">
            <p className="break-words text-sm font-semibold text-ink [overflow-wrap:anywhere]">{version.fileName || "Untitled document"}</p>
            <p className="mt-0.5 text-metadata text-ink-muted">
              Version {version.versionNumber} · {formatBytes(version.byteSize)}
              {version.pageCount !== null ? ` · ${version.pageCount} page${version.pageCount === 1 ? "" : "s"}` : ""}
            </p>
          </div>
          <p className={`text-metadata font-medium ${document.archived ? "text-ink-muted" : state.tone}`}>
            {document.archived ? "Removed" : state.label}
          </p>
        </div>
        {version.errorCode ? (
          <p className="mt-2 break-words font-mono text-metadata text-critical [overflow-wrap:anywhere]">Code: {version.errorCode}</p>
        ) : null}
        {!document.archived && detail.base?.owned ? (
          <div className="mt-3 flex flex-wrap gap-1">
            {version.state === "failed" && version.current ? (
              <button
                className={surfaceButton}
                disabled={busy}
                onClick={() => detail.onRetryDocument(document.id, version.id)}
                type="button"
              >
                {detail.actionId === `document:${document.id}:retry` ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <RotateCcw className="size-4" aria-hidden="true" />}
                Retry
              </button>
            ) : null}
            <label className={`${quietButton} ${busy ? "pointer-events-none" : "cursor-pointer"}`} htmlFor={replacementId}>
              <Upload className="size-4" aria-hidden="true" />
              New version
            </label>
            <input
              className="sr-only"
              disabled={busy}
              id={replacementId}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) detail.onReplaceDocument(document.id, file);
                event.currentTarget.value = "";
              }}
              type="file"
            />
            <button
              className={`${quietButton} text-critical hover:bg-critical/10 hover:text-critical`}
              disabled={busy}
              onClick={() => onRequestRemove({ documentId: document.id, fileName: version.fileName || "document" })}
              type="button"
            >
              Remove
            </button>
            {actionPending ? <LoaderCircle className="m-2 size-4 animate-spin text-proof" aria-label="Document action in progress" /> : null}
          </div>
        ) : null}
        <VersionHistory document={document} />
      </div>
    </li>
  );
}

function VersionHistory({ document }: { document: KnowledgeDocumentStatus }) {
  const versions = [...document.versions].sort((left, right) => right.versionNumber - left.versionNumber);
  return (
    <details className="mt-3">
      <summary className={`cursor-pointer text-xs font-medium text-ink-secondary ${focusRing}`}>
        Version history ({versions.length})
      </summary>
      <ol className="mt-3 border-l border-trace-strong pl-4">
        {versions.map((version) => {
          const state = versionState(version);
          return (
            <li key={version.id} className="relative pb-4 last:pb-0">
              <span className="absolute -left-[1.19rem] top-1.5 size-1.5 rounded-full bg-proof" aria-hidden="true" />
              <div className="flex flex-wrap justify-between gap-2">
                <p className="text-xs font-semibold text-ink">Version {version.versionNumber}{version.current ? " · Current" : ""}</p>
                <p className={`text-metadata ${state.tone}`}>{state.label}</p>
              </div>
              <p className="mt-0.5 text-metadata text-ink-muted">
                {formatDate(version.createdAt)} · visible {version.visibleFromRevision === null ? "never" : `from revision ${version.visibleFromRevision}`}
                {version.visibleUntilRevision === null ? "" : ` before revision ${version.visibleUntilRevision}`}
              </p>
            </li>
          );
        })}
      </ol>
    </details>
  );
}

function reindexLabel(progress: KnowledgeReindexProgress): string {
  if (progress.status === "building") return "Building shadow index";
  if (progress.status === "ready") return "Finalizing index switch";
  if (progress.status === "failed") return "Reindex failed";
  if (progress.status === "active") return "Index active";
  return "Index retired";
}

function ReindexSection({ busy, detail }: { busy: boolean; detail: KnowledgeDetailView }) {
  const base = detail.base!;
  const initial = base.activeGeneration.embeddingDeploymentId ?? detail.embeddingDeployments[0]?.id ?? "";
  const [deploymentId, setDeploymentId] = useState(initial);
  const effectiveDeploymentId = detail.embeddingDeployments.some(
    (deployment) => deployment.id === deploymentId
  )
    ? deploymentId
    : initial;
  const deployment = detail.embeddingDeployments.find(
    (candidate) => candidate.id === effectiveDeploymentId
  ) ?? null;
  const progress = detail.ingestion?.reindex ?? null;
  const transient = progress?.status === "building" || progress?.status === "ready";
  return (
    <section aria-labelledby="knowledge-reindex-title" className="border-t border-trace-subtle py-6">
      <h2 className="text-base font-semibold text-ink" id="knowledge-reindex-title">Reindex</h2>
      <p className="mt-1 text-xs leading-5 text-ink-muted">Build a fenced shadow generation, then switch only after every current document settles.</p>
      {progress ? (
        <div className={`mt-4 border-l-2 pl-3 ${progress.status === "failed" ? "border-critical/45" : transient ? "border-proof/45" : "border-positive/45"}`} role="status">
          <p className="text-sm font-semibold text-ink">{reindexLabel(progress)}</p>
          <p className="mt-1 text-xs leading-5 text-ink-secondary">
            {progress.completedDocuments} completed · {progress.failedDocuments} failed · {progress.totalDocuments} total · target revision {progress.targetContentRevision}
          </p>
          {progress.errorCode ? <p className="mt-1 font-mono text-metadata text-critical">Code: {progress.errorCode}</p> : null}
        </div>
      ) : null}
      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <label className={fieldLabel} htmlFor="knowledge-reindex-deployment">Embedding deployment</label>
          <select
            className={fieldInput}
            disabled={busy || base.archived || transient}
            id="knowledge-reindex-deployment"
            onChange={(event) => setDeploymentId(event.currentTarget.value)}
            value={effectiveDeploymentId}
          >
            {detail.embeddingDeployments.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>{deploymentLabel(candidate)}</option>
            ))}
          </select>
        </div>
        <button
          className={surfaceButton}
          disabled={busy || base.archived || transient || !effectiveDeploymentId}
          onClick={() => detail.onReindex(effectiveDeploymentId)}
          type="button"
        >
          {detail.actionId === "reindex" ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <RefreshCcw className="size-4" aria-hidden="true" />}
          Start reindex
        </button>
      </div>
      <EgressDisclosure deployment={deployment} />
    </section>
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
        Publishing grants the selected audience live access to this base’s current and future content. Revoking stops future run admission; runs accepted earlier keep their admitted revision.
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
