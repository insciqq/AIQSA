import {
  ConfirmationDialog,
  DiscardChangesConfirmationDialog
} from "@/components/app-shell/ConfirmationDialog";
import { useBeforeUnloadGuard } from "@/components/app-shell/useBeforeUnloadGuard";
import type {
  KnowledgeCreateView,
  KnowledgeDetailView,
  KnowledgeLibraryNotice,
  KnowledgeLibraryView,
  KnowledgeListView,
  KnowledgeSourceDetailView
} from "@/components/knowledge/libraryViewContracts";
import { UiV2Button, UiV2Icon, type UiV2IconName } from "@/components/ui-v2";
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
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type ReactNode
} from "react";

/*
 * Knowledge inside the Library column (UX audit 2026-09-02 A14): the Sources
 * catalog, base creation, base detail and Source detail render as Library
 * sub-views under the Library's own crumb and Back control (`LibraryV2`
 * `subview`); this component owns only the content. Composition follows the
 * Library idiom — one resource heading, sections separated by a border,
 * rows without card chrome — and every color comes from the Signal tokens
 * through the `v2-knowledge-*` classes in `features/library-v2/knowledge.css`.
 * Behaviour (uploads, lifecycle, publication, membership actions, polling)
 * is unchanged; lifecycle and consequence dialogs remain dialogs.
 */

type StatusTone = "danger" | "live" | "neutral" | "ok" | "warn";

function processingWarningLabels(codes: readonly KnowledgeProcessingWarningCode[]): string[] {
  return codes.map((code) => KNOWLEDGE_PROCESSING_WARNING_LABELS[code]);
}

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

function taskDirty(view: KnowledgeLibraryView): boolean {
  return Boolean(view.task === "create"
    ? view.create?.dirty
    : view.task === "detail"
      ? view.detail?.dirty
      : view.task === "source-detail"
        ? view.sourceDetail?.dirty
        : false);
}

function taskExit(view: KnowledgeLibraryView): (() => void) | undefined {
  if (view.task === "create") return view.create?.onCancel;
  if (view.task === "detail") return view.detail?.onBack;
  if (view.task === "source-detail") return view.sourceDetail?.onBack;
  if (view.list.catalog === "sources") return () => view.list.onCatalogChange("bases");
  return view.onBackToChat;
}

function taskDiscardLabel(view: KnowledgeLibraryView): string {
  return view.task === "create"
    ? "Knowledge base draft"
    : view.task === "source-detail"
      ? "Source details"
      : "Knowledge base settings";
}

/** True while the view is a Library sub-view rather than the Bases list. */
export function isKnowledgeSubview(view: KnowledgeLibraryView): boolean {
  return view.task !== "list" || view.list.catalog === "sources";
}

/**
 * The Library crumb for the open Knowledge sub-view and the Back control that
 * leaves it: `Library / Knowledge / <label>` plus the task's own Back label.
 */
export function knowledgeSubviewChrome(view: KnowledgeLibraryView): Readonly<{
  backLabel: string;
  key: string;
  label: string;
}> {
  if (view.task === "create") {
    return { backLabel: "Back to Knowledge", key: "create", label: "New Knowledge base" };
  }
  if (view.task === "detail") {
    return {
      backLabel: "Back to Knowledge",
      key: `detail:${view.detail?.base?.id ?? ""}`,
      label: view.detail?.base?.name ?? "Knowledge base"
    };
  }
  if (view.task === "source-detail") {
    return {
      backLabel: view.sourceDetail?.backLabel ?? "Back to Knowledge",
      key: `source:${view.sourceDetail?.source?.id ?? ""}`,
      label: view.sourceDetail?.source?.name ?? "Source"
    };
  }
  return { backLabel: "Back to Knowledge", key: "sources", label: "Sources" };
}

/**
 * Leaving a Knowledge sub-view is owned here: a dirty draft asks for an
 * explicit discard before the task closes, whether the exit comes from the
 * Library's Back control, a tab change, or leaving the Library.
 */
export function useKnowledgeLibraryExit(view: KnowledgeLibraryView | null): Readonly<{
  confirmation: ReactNode;
  dirty: boolean;
  requestExit(after?: () => void): void;
}> {
  const [pending, setPending] = useState<(() => void) | null>(null);
  const dirty = view ? taskDirty(view) : false;
  const requestExit = (after?: () => void) => {
    if (!view || view.busy) return;
    const exit = taskExit(view);
    const run = () => {
      exit?.();
      after?.();
    };
    if (dirty) {
      setPending(() => run);
      return;
    }
    run();
  };
  const confirmation = pending && view ? (
    <DiscardChangesConfirmationDialog
      label={taskDiscardLabel(view)}
      onCancel={() => setPending(null)}
      onConfirm={() => {
        const run = pending;
        setPending(null);
        run();
      }}
    />
  ) : null;
  return { confirmation, dirty, requestExit };
}

export function KnowledgeLibrary({
  onPreviewSource,
  view
}: {
  onPreviewSource?(sourceId: string, trigger: HTMLElement): void;
  view: KnowledgeLibraryView;
}) {
  const [lifecycleTarget, setLifecycleTarget] = useState<LifecycleTarget | null>(null);
  const [removeTarget, setRemoveTarget] = useState<RemoveTarget | null>(null);
  const childDialogOpen = lifecycleTarget !== null || removeTarget !== null;
  useBeforeUnloadGuard(taskDirty(view));

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
      <section
        aria-busy={view.busy || undefined}
        aria-hidden={childDialogOpen || undefined}
        aria-label="Knowledge"
        className="v2-knowledge"
        data-testid="knowledge-library"
        inert={childDialogOpen || undefined}
      >
        {view.task === "create" && view.create ? (
          <CreateTask
            busy={view.busy}
            create={view.create}
            notice={view.notice}
            onDismissNotice={view.onDismissNotice}
          />
        ) : view.task === "detail" && view.detail ? (
          <DetailTask
            busy={view.busy}
            detail={view.detail}
            notice={view.notice}
            onDismissNotice={view.onDismissNotice}
            onRequestLifecycle={setLifecycleTarget}
            onRequestRemove={setRemoveTarget}
            onPreviewSource={onPreviewSource}
            onRetry={view.onRetry}
          />
        ) : view.task === "source-detail" && view.sourceDetail ? (
          <SourceDetailTask
            busy={view.busy}
            detail={view.sourceDetail}
            notice={view.notice}
            onDismissNotice={view.onDismissNotice}
            onRequestLifecycle={setLifecycleTarget}
            onRequestRemove={setRemoveTarget}
            onPreviewSource={onPreviewSource}
            onRetry={view.onRetry}
          />
        ) : (
          <SourcesTask
            busy={view.busy}
            list={view.list}
            notice={view.notice}
            onDismissNotice={view.onDismissNotice}
            onRetry={view.onRetry}
          />
        )}
      </section>
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

/* ---------- Shared pieces ---------- */

function Spinner() {
  return <span className="v2-spinner" aria-hidden="true" />;
}

function StatusIcon({ name, spinning = false }: { name: UiV2IconName; spinning?: boolean }) {
  return spinning ? <Spinner /> : <UiV2Icon name={name} />;
}

/** Page-level heading of a sub-view: title, meta line, and the actions. */
function SubviewHeading({
  actions,
  meta,
  title
}: {
  actions?: ReactNode;
  meta: ReactNode;
  title: ReactNode;
}) {
  return (
    <header className="v2-resource-heading v2-knowledge-heading">
      <div>
        <h2>{title}</h2>
        <p>{meta}</p>
      </div>
      {actions ? <div className="v2-resource-heading-action">{actions}</div> : null}
    </header>
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
    <div
      aria-live={notice.kind === "error" ? "assertive" : "polite"}
      className="v2-knowledge-notice"
      data-testid="knowledge-library-notice"
      data-tone={notice.kind === "error" ? "danger" : "ok"}
      role={notice.kind === "error" ? "alert" : "status"}
    >
      <span>{notice.text}</span>
      <UiV2Button onClick={onDismiss}>Dismiss</UiV2Button>
    </div>
  );
}

function TaskFailure({ error, onRetry }: { error: string | null; onRetry(): void }) {
  return (
    <div className="v2-knowledge-state" data-tone="danger">
      <UiV2Icon name="alert" />
      <p role="alert">Knowledge didn’t load</p>
      <span>{error ?? "Try loading Knowledge again."}</span>
      <UiV2Button icon="regenerate" onClick={onRetry}>Retry</UiV2Button>
    </div>
  );
}

function TaskLoading({ label }: { label: string }) {
  return (
    <div className="v2-knowledge-state" role="status">
      <Spinner />
      <p>{label}</p>
    </div>
  );
}

function Callout({
  children,
  role,
  title,
  tone = "info"
}: {
  children: ReactNode;
  role?: "status";
  title: string;
  tone?: "danger" | "info" | "warn";
}) {
  return (
    <div className="v2-knowledge-callout" data-tone={tone} role={role}>
      <p className="v2-knowledge-callout-title">{title}</p>
      {children}
    </div>
  );
}

/** A file picker that reads as a button: the label wraps the sr-only input. */
function FilePickerLabel({
  accept,
  busy = false,
  children,
  disabled,
  icon,
  inputId,
  multiple = false,
  onFiles
}: {
  accept: string;
  busy?: boolean;
  children: ReactNode;
  disabled: boolean;
  icon: UiV2IconName;
  inputId?: string;
  multiple?: boolean;
  onFiles(files: FileList | null): void;
}) {
  return (
    <label
      aria-disabled={disabled || undefined}
      className="v2-button v2-focusable v2-knowledge-file-picker"
      data-disabled={disabled || undefined}
      data-tone="ghost"
      htmlFor={inputId}
    >
      {busy ? <Spinner /> : <UiV2Icon name={icon} />}
      <span>{children}</span>
      <input
        accept={accept}
        className="v2-sr-only"
        disabled={disabled}
        id={inputId}
        multiple={multiple}
        onChange={(event) => {
          onFiles(event.currentTarget.files);
          event.currentTarget.value = "";
        }}
        type="file"
      />
    </label>
  );
}

function Pagination({
  busy,
  label,
  onPageChange,
  page,
  totalPages
}: {
  busy: boolean;
  label: string;
  onPageChange(page: number): void;
  page: number;
  totalPages: number;
}) {
  if (totalPages <= 1) return null;
  return (
    <nav aria-label={label} className="v2-knowledge-pagination">
      <p>Page {page} of {totalPages}</p>
      <div>
        <UiV2Button disabled={busy || page <= 1} onClick={() => onPageChange(page - 1)}>Previous</UiV2Button>
        <UiV2Button disabled={busy || page >= totalPages} onClick={() => onPageChange(page + 1)}>Next</UiV2Button>
      </div>
    </nav>
  );
}

/* ---------- Sources catalog ---------- */

const SOURCE_FILTERS: readonly (readonly [KnowledgeSourceFilter, string])[] = [
  ["all", "All"],
  ["yours", "Yours"],
  ["shared", "Shared"],
  ["trash", "Trash"]
];

function SourcesTask({
  busy,
  list,
  notice,
  onDismissNotice,
  onRetry
}: {
  busy: boolean;
  list: KnowledgeListView;
  notice: KnowledgeLibraryNotice | null;
  onDismissNotice(): void;
  onRetry(): void;
}) {
  const sources = list.sourceData?.sources ?? [];
  const filtered = Boolean(list.sourceQuery) || list.sourceFilter !== "all";
  return (
    <>
      <SubviewHeading
        actions={(
          <>
            <label className="v2-resource-search" htmlFor="knowledge-search">
              <span className="v2-sr-only">Search Sources</span>
              <UiV2Icon name="search" />
              <input
                disabled={busy}
                id="knowledge-search"
                onChange={(event) => list.onSourceQueryChange(event.currentTarget.value)}
                placeholder="Search Sources"
                type="search"
                value={list.sourceQuery}
              />
            </label>
            <UiV2Button disabled={busy || !list.canCreate} icon="plus" tone="primary" onClick={list.onNewBase}>
              New base + files
            </UiV2Button>
          </>
        )}
        meta="Sources are reusable files. Add one Source to several bases without uploading it again."
        title="Sources"
      />
      {notice ? <NoticeRow notice={notice} onDismiss={onDismissNotice} /> : null}
      <div aria-label="Source filters" className="v2-resource-filters" role="group">
        {SOURCE_FILTERS.map(([filter, label]) => (
          <button
            aria-pressed={list.sourceFilter === filter}
            className="v2-resource-filter v2-focusable"
            data-selected={list.sourceFilter === filter || undefined}
            disabled={busy}
            key={filter}
            type="button"
            onClick={() => list.onSourceFilterChange(filter)}
          >
            {label}
          </button>
        ))}
      </div>
      {list.sourceDataState === "loading" ? (
        <TaskLoading label="Loading Sources…" />
      ) : list.sourceDataState === "error" ? (
        <TaskFailure error={list.sourceDataError} onRetry={onRetry} />
      ) : sources.length === 0 ? (
        <div className="v2-knowledge-state">
          <UiV2Icon name="file" />
          <p>{filtered ? "No matching Sources" : "No Sources yet"}</p>
          <span>
            {filtered
              ? "Try another search or filter."
              : "Upload a file to a Knowledge base. It will appear here when its Source identity is available."}
          </span>
          {!filtered ? (
            <UiV2Button disabled={!list.canCreate} icon="plus" onClick={list.onNewBase}>
              Create a base and add files
            </UiV2Button>
          ) : null}
        </div>
      ) : (
        <>
          <ul aria-label="Knowledge Sources" className="v2-knowledge-list">
            {sources.map((source) => (
              <SourceRow key={source.id} busy={busy} list={list} source={source} />
            ))}
          </ul>
          <Pagination
            busy={busy}
            label="Source pages"
            onPageChange={list.onSourcePageChange}
            page={list.sourceData?.pagination.page ?? 1}
            totalPages={list.sourceData?.pagination.totalPages ?? 0}
          />
        </>
      )}
    </>
  );
}

function sourceStatus(source: KnowledgeSourceSummary): { label: string; tone: StatusTone } {
  if (source.deletionPending) return { label: "Deletion pending", tone: "danger" };
  if (source.trashed) return { label: "In Trash", tone: "warn" };
  if (source.readiness.state === "ready") {
    if (source.replacement.state === "processing") {
      return { label: "Ready · replacement processing", tone: "live" };
    }
    if (source.replacement.state === "needs_attention") {
      return { label: "Ready · replacement needs attention", tone: "danger" };
    }
    return source.readiness.warningCodes.length > 0
      ? { label: "Ready with warnings", tone: "warn" }
      : { label: "Ready", tone: "ok" };
  }
  return source.readiness.state === "processing"
    ? { label: "Processing", tone: "live" }
    : { label: "Needs attention", tone: "danger" };
}

function sourceIcon(source: KnowledgeSourceSummary): { name: UiV2IconName; spinning: boolean } {
  if (source.trashed) return { name: "trash", spinning: false };
  if (source.readiness.state === "ready") {
    return { name: source.readiness.warningCodes.length > 0 ? "alert" : "check", spinning: false };
  }
  if (source.readiness.state === "processing") return { name: "history", spinning: true };
  return { name: "alert", spinning: false };
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
  const icon = sourceIcon(source);
  return (
    <li className="v2-knowledge-row" data-testid={`knowledge-source-${source.id}`}>
      <button
        className="v2-knowledge-row-button v2-focusable"
        disabled={busy}
        type="button"
        onClick={() => list.onOpenSource(source.id)}
      >
        <span className="v2-knowledge-row-icon" data-tone={status.tone} aria-hidden="true">
          <StatusIcon name={icon.name} spinning={icon.spinning} />
        </span>
        <span className="v2-knowledge-row-main">
          <span className="v2-knowledge-row-title">
            <span className="v2-knowledge-row-name">{source.name}</span>
            <span className="v2-knowledge-status" data-tone={status.tone}>{status.label}</span>
          </span>
          {source.description ? <span className="v2-knowledge-row-description">{source.description}</span> : null}
          {source.tags.length > 0 ? (
            <span className="v2-knowledge-tags" aria-label="Source tags">
              {source.tags.slice(0, 4).map((tag) => <span className="v2-knowledge-tag" key={tag}>{tag}</span>)}
              {source.tags.length > 4 ? <span className="v2-knowledge-tag-more">+{source.tags.length - 4}</span> : null}
            </span>
          ) : null}
          <span className="v2-knowledge-meta">
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

/* ---------- Base creation ---------- */

function hasFileTransfer(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

function useDropZone(onFiles: (files: FileList) => void, disabled: boolean) {
  const [dragActive, setDragActive] = useState(false);
  const dragDepth = useRef(0);
  return {
    dragActive,
    handlers: {
      onDragEnter(event: DragEvent<HTMLElement>) {
        if (!hasFileTransfer(event)) return;
        event.preventDefault();
        dragDepth.current += 1;
        setDragActive(true);
      },
      onDragLeave(event: DragEvent<HTMLElement>) {
        if (!hasFileTransfer(event)) return;
        event.preventDefault();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragActive(false);
      },
      onDragOver(event: DragEvent<HTMLElement>) {
        if (!hasFileTransfer(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = disabled ? "none" : "copy";
      },
      onDrop(event: DragEvent<HTMLElement>) {
        if (!hasFileTransfer(event)) return;
        event.preventDefault();
        dragDepth.current = 0;
        setDragActive(false);
        onFiles(event.dataTransfer.files);
      }
    }
  };
}

function CreateTask({
  busy,
  create,
  notice,
  onDismissNotice
}: {
  busy: boolean;
  create: KnowledgeCreateView;
  notice: KnowledgeLibraryNotice | null;
  onDismissNotice(): void;
}) {
  const addFiles = (files: FileList | readonly File[] | null) => {
    if (!files || busy) return;
    const known = new Set(create.draft.files.map(
      ({ lastModified, name, size }) => `${name} ${size} ${lastModified}`
    ));
    const additions = Array.from(files).filter((file) => {
      const key = `${file.name} ${file.size} ${file.lastModified}`;
      if (known.has(key)) return false;
      known.add(key);
      return true;
    });
    if (additions.length > 0) create.onChange({ files: [...create.draft.files, ...additions] });
  };
  const drop = useDropZone(addFiles, busy);
  return (
    <>
      <SubviewHeading meta="Private until you publish it" title="New Knowledge base" />
      {notice ? <NoticeRow notice={notice} onDismiss={onDismissNotice} /> : null}
      <form
        className="v2-knowledge-form-page"
        onSubmit={(event) => {
          event.preventDefault();
          create.onSave();
        }}
      >
        <section aria-labelledby="knowledge-create-identity" className="v2-knowledge-section">
          <div className="v2-knowledge-section-head">
            <div>
              <h3 id="knowledge-create-identity">Identity</h3>
              <p>Use a name people will recognize when this base is shared.</p>
            </div>
          </div>
          <div className="v2-knowledge-form">
            <div className="v2-knowledge-field">
              <label htmlFor="knowledge-create-name">Name</label>
              <input
                autoComplete="off"
                className="v2-knowledge-input"
                disabled={busy}
                id="knowledge-create-name"
                maxLength={KNOWLEDGE_BASE_NAME_MAX_LENGTH}
                onChange={(event) => create.onChange({ name: event.currentTarget.value })}
                required
                value={create.draft.name}
              />
            </div>
            <div className="v2-knowledge-field">
              <label htmlFor="knowledge-create-description">Description</label>
              <textarea
                className="v2-knowledge-input"
                disabled={busy}
                id="knowledge-create-description"
                maxLength={KNOWLEDGE_BASE_DESCRIPTION_MAX_LENGTH}
                onChange={(event) => create.onChange({ description: event.currentTarget.value })}
                rows={4}
                value={create.draft.description}
              />
            </div>
          </div>
        </section>
        <section aria-labelledby="knowledge-create-files" className="v2-knowledge-section">
          <div className="v2-knowledge-section-head">
            <div>
              <h3 id="knowledge-create-files">Files <span className="v2-knowledge-optional">(optional)</span></h3>
              <p>Start empty or add files now. {knowledgeUploadHelp(create.maxUploadBytes)} Each file shows its own processing state.</p>
            </div>
          </div>
          <div
            className="v2-knowledge-dropzone"
            data-drop-active={drop.dragActive || undefined}
            data-testid="knowledge-create-drop-zone"
            {...drop.handlers}
          >
            <p>{drop.dragActive ? "Drop files here" : "Drop files here, or choose from your device"}</p>
            <FilePickerLabel
              accept={KNOWLEDGE_UPLOAD_ACCEPT}
              disabled={busy}
              icon="attach"
              multiple
              onFiles={addFiles}
            >
              Choose files
            </FilePickerLabel>
          </div>
          {create.draft.files.length > 0 ? (
            <ul aria-label="Files selected for this Knowledge base" className="v2-knowledge-list v2-knowledge-file-list">
              {create.draft.files.map((file, fileIndex) => (
                <li key={`${file.name}-${file.size}-${file.lastModified}`}>
                  <span>{file.name} · {formatBytes(file.size)}</span>
                  <UiV2Button
                    aria-label={`Remove ${file.name}`}
                    disabled={busy}
                    onClick={() => create.onChange({
                      files: create.draft.files.filter((_, index) => index !== fileIndex)
                    })}
                  >
                    Remove
                  </UiV2Button>
                </li>
              ))}
            </ul>
          ) : null}
          {create.progress ? (
            <p className="v2-knowledge-progress-line" role="status">
              <Spinner />
              Uploading {create.progress.current} of {create.progress.total}: <span>{create.progress.fileName}</span>
            </p>
          ) : null}
        </section>
        {create.error ? <p className="v2-knowledge-error" role="alert">{create.error.text}</p> : null}
        <div className="v2-knowledge-form-actions">
          <UiV2Button disabled={busy} onClick={() => create.onCancel()}>Cancel</UiV2Button>
          <UiV2Button busy={create.saving} disabled={busy} tone="primary" type="submit">
            Create knowledge base
          </UiV2Button>
        </div>
      </form>
    </>
  );
}

/* ---------- Base detail ---------- */

function DetailTask({
  busy,
  detail,
  notice,
  onDismissNotice,
  onRequestLifecycle,
  onRequestRemove,
  onPreviewSource,
  onRetry
}: {
  busy: boolean;
  detail: KnowledgeDetailView;
  notice: KnowledgeLibraryNotice | null;
  onDismissNotice(): void;
  onRequestLifecycle(target: LifecycleTarget): void;
  onRequestRemove(target: RemoveTarget): void;
  onPreviewSource?(sourceId: string, trigger: HTMLElement): void;
  onRetry(): void;
}) {
  const base = detail.base;
  const heading = (
    <SubviewHeading
      actions={base?.owned && !base.trashed ? (
        detail.dirty ? (
          <UiV2Button busy={detail.actionId === "settings"} disabled={busy} tone="primary" onClick={detail.onSave}>
            Save settings
          </UiV2Button>
        ) : (
          <UiV2Button
            disabled={busy}
            icon={base.archived ? "regenerate" : "archive"}
            onClick={() => detail.onArchiveToggle(!base.archived)}
          >
            {base.archived ? "Restore" : "Archive"}
          </UiV2Button>
        )
      ) : undefined}
      meta={base
        ? `${scopeText(base)} · ${base.sourceCount} ${base.sourceCount === 1 ? "Source" : "Sources"} · updated ${formatDate(base.updatedAt)}`
        : "Loading"}
      title={base?.name ?? "Knowledge base"}
    />
  );
  if (detail.dataState === "loading") {
    return <>{heading}<TaskLoading label="Loading Knowledge base…" /></>;
  }
  if (detail.dataState === "error" || !base || !detail.sources) {
    return <>{heading}<TaskFailure error={detail.dataError} onRetry={onRetry} /></>;
  }
  return (
    <>
      {heading}
      {notice ? <NoticeRow notice={notice} onDismiss={onDismissNotice} /> : null}
      {!base.owned ? (
        <Callout title="Read-only shared base">
          <p>{scopeText(base)}. The owner controls files, processing, and access.</p>
        </Callout>
      ) : null}
      <BaseOverview base={base} />
      {base.owned ? (
        <LifecycleSection
          busy={busy}
          deletionPending={base.deletionPending}
          kind="base"
          name={base.name}
          onDelete={() => onRequestLifecycle({ action: "delete", kind: "base", name: base.name })}
          onRestore={detail.onRestore}
          onTrash={() => onRequestLifecycle({ action: "trash", kind: "base", name: base.name })}
          purgeScheduledAt={base.purgeScheduledAt}
          trashed={base.trashed}
          trashedAt={base.trashedAt}
        />
      ) : null}
      {!base.trashed ? <BaseSettings busy={busy} detail={detail} /> : null}
      {!base.trashed ? (
        <SourcesSection
          busy={busy}
          detail={detail}
          onPreviewSource={onPreviewSource}
          onRequestRemove={onRequestRemove}
        />
      ) : null}
      {base.owned && !base.trashed ? <PublicationSection busy={busy} detail={detail} /> : null}
    </>
  );
}

/** The exact readiness sentence of a base ("1 ready · 1 processing"). */
export function knowledgeReadinessText(readiness: KnowledgeReadiness): string {
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

function baseTone(state: KnowledgeReadiness["state"]): StatusTone {
  if (state === "ready") return "ok";
  if (state === "trashed") return "warn";
  if (state === "needs_attention") return "danger";
  if (state === "processing") return "live";
  return "neutral";
}

function baseIcon(state: KnowledgeReadiness["state"]): { name: UiV2IconName; spinning: boolean } {
  if (state === "ready") return { name: "check", spinning: false };
  if (state === "needs_attention") return { name: "alert", spinning: false };
  if (state === "processing") return { name: "history", spinning: true };
  if (state === "archived") return { name: "archive", spinning: false };
  if (state === "trashed") return { name: "trash", spinning: false };
  return { name: "book", spinning: false };
}

function BaseOverview({ base }: { base: KnowledgeBaseSummary }) {
  const state = base.readiness.state;
  const icon = baseIcon(state);
  return (
    <section
      aria-labelledby="knowledge-readiness-title"
      className="v2-knowledge-section v2-knowledge-readiness"
      data-testid="knowledge-readiness-summary"
    >
      <span className="v2-knowledge-row-icon" data-tone={baseTone(state)} aria-hidden="true">
        <StatusIcon name={icon.name} spinning={icon.spinning} />
      </span>
      <div>
        <h3 id="knowledge-readiness-title">{knowledgeReadinessText(base.readiness)}</h3>
        <p>
          {state === "ready" ? "All current Sources are ready for future chats."
            : state === "processing" ? "Ready Sources stay available while the remaining Sources are processed."
              : state === "needs_attention" ? "Ready Sources stay available. Open the affected Source below."
                : state === "archived" ? "Restore this base to add Sources."
                  : state === "trashed" ? "This base is excluded from future runs until restored."
                  : "Add Sources to make this base available in future chats."}
        </p>
        {base.readiness.supportReference ? (
          <p className="v2-knowledge-meta">Support reference {base.readiness.supportReference}</p>
        ) : null}
      </div>
    </section>
  );
}

function BaseSettings({ busy, detail }: { busy: boolean; detail: KnowledgeDetailView }) {
  const base = detail.base!;
  return (
    <section aria-labelledby="knowledge-settings-title" className="v2-knowledge-section">
      <div className="v2-knowledge-section-head">
        <div>
          <h3 id="knowledge-settings-title">Base settings</h3>
          <p>Update how this base is named and described throughout Knowledge.</p>
        </div>
        {base.archived ? <span className="v2-knowledge-tag">Archived</span> : null}
      </div>
      {base.owned ? (
        <div className="v2-knowledge-form">
          <div className="v2-knowledge-field">
            <label htmlFor="knowledge-detail-name">Name</label>
            <input
              className="v2-knowledge-input"
              disabled={busy}
              id="knowledge-detail-name"
              maxLength={KNOWLEDGE_BASE_NAME_MAX_LENGTH}
              onChange={(event) => detail.onChange({ name: event.currentTarget.value })}
              value={detail.draft.name}
            />
          </div>
          <div className="v2-knowledge-field">
            <label htmlFor="knowledge-detail-description">Description</label>
            <textarea
              className="v2-knowledge-input"
              disabled={busy}
              id="knowledge-detail-description"
              maxLength={KNOWLEDGE_BASE_DESCRIPTION_MAX_LENGTH}
              onChange={(event) => detail.onChange({ description: event.currentTarget.value })}
              rows={4}
              value={detail.draft.description}
            />
          </div>
          {detail.error ? <p className="v2-knowledge-error v2-knowledge-form-wide" role="alert">{detail.error.text}</p> : null}
        </div>
      ) : (
        <dl className="v2-knowledge-dl">
          <div><dt>Owner</dt><dd>{base.ownerDisplayName}</dd></div>
          <div><dt>Description</dt><dd className="v2-knowledge-prewrap">{base.description || "No description"}</dd></div>
        </dl>
      )}
    </section>
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
      <section aria-label={`${label} lifecycle`} className="v2-knowledge-section">
        <div className="v2-knowledge-section-head">
          <div>
            <h3>Trash</h3>
            <p>
              {kind === "base"
                ? "Stop future runs from using this base while keeping its Sources and settings recoverable."
                : "Stop future runs from using this Source in every base while keeping it recoverable."}
            </p>
          </div>
          <UiV2Button
            aria-label={`Move ${name} to Trash`}
            disabled={busy}
            icon="trash"
            tone="destructive"
            onClick={onTrash}
          >
            Move to Trash
          </UiV2Button>
        </div>
      </section>
    );
  }

  return (
    <section aria-label={`${label} Trash actions`} className="v2-knowledge-section">
      <div className="v2-knowledge-callout" data-tone="warn">
        <h3 className="v2-knowledge-callout-title">
          {deletionPending ? "Permanent deletion pending" : `${label} is in Trash`}
        </h3>
        <p>
          {deletionPending
            ? "The durable deletion worker is removing relational evidence and settling every private object obligation. This item cannot be restored."
            : kind === "base"
              ? "Future runs cannot use this base. Restore it with its Source memberships and sharing settings, or delete only the base permanently."
              : "Future runs cannot use this Source. Restore its previous Base memberships, or permanently remove every version and stored object."}
        </p>
        {trashedAt ? (
          <p className="v2-knowledge-meta">
            Deleted {formatDate(trashedAt)}
            {purgeScheduledAt
              ? deletionPending
                ? " · permanent purge in progress"
                : ` · purge scheduled ${formatDate(purgeScheduledAt)}`
              : ""}
          </p>
        ) : null}
        {!deletionPending ? (
          <div className="v2-knowledge-actions">
            <UiV2Button disabled={busy} icon="regenerate" onClick={onRestore}>Restore</UiV2Button>
            <UiV2Button disabled={busy} icon="trash" tone="destructive" onClick={onDelete}>
              Delete permanently
            </UiV2Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/* ---------- Uploads ---------- */

const activeUploadStates = new Set<KnowledgeUploadItem["state"]>([
  "processing",
  "queued",
  "upload_complete",
  "uploading"
]);

function uploadState(item: KnowledgeUploadItem): { label: string; tone: StatusTone } {
  switch (item.state) {
    case "ready":
      return { label: "Ready", tone: "ok" };
    case "ready_with_warnings":
      return { label: "Ready with warnings", tone: "warn" };
    case "reused":
      return { label: "Already in library", tone: "ok" };
    case "needs_attention":
      return { label: "Needs attention", tone: "danger" };
    case "cancelled":
      return { label: "Cancelled", tone: "neutral" };
    case "upload_complete":
      return { label: "Verifying", tone: "live" };
    case "processing":
      return { label: "Processing", tone: "live" };
    case "uploading":
      return { label: "Uploading", tone: "live" };
    default:
      return { label: "Queued", tone: "neutral" };
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

function safeDomId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/gu, "-");
}

function UploadManifest({ busy, detail }: { busy: boolean; detail: KnowledgeDetailView }) {
  if (detail.uploadBatches.length === 0) return null;
  return (
    <section aria-labelledby="knowledge-upload-activity-title" className="v2-knowledge-uploads">
      <h4 className="v2-sr-only" id="knowledge-upload-activity-title">Upload activity</h4>
      {detail.uploadBatches.map((batch, index) => {
        const active = batch.items.some((item) => activeUploadStates.has(item.state));
        return (
          <details className="v2-knowledge-details" key={batch.id} open={active || index === 0}>
            <summary className="v2-focusable">
              <UiV2Icon name="chevron-right" />
              <span>{uploadBatchSummary(batch)}</span>
              <span className="v2-knowledge-meta">{formatDate(batch.createdAt)}</span>
            </summary>
            <ul aria-label={`Files added ${formatDate(batch.createdAt)}`} className="v2-knowledge-list">
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
                const transferring = activeUploadStates.has(item.state);
                return (
                  <li
                    className="v2-knowledge-row v2-knowledge-row-with-actions"
                    data-testid={`knowledge-upload-item-${item.id}`}
                    key={item.id}
                  >
                    <span className="v2-knowledge-row-icon" data-tone={state.tone} aria-hidden="true">
                      {item.state === "ready" || item.state === "reused"
                        ? <UiV2Icon name="check" />
                        : item.state === "ready_with_warnings" || item.state === "needs_attention"
                          ? <UiV2Icon name="alert" />
                          : transferring
                            ? <Spinner />
                            : <UiV2Icon name="history" />}
                    </span>
                    <div className="v2-knowledge-row-main">
                      <div className="v2-knowledge-row-title">
                        <span className="v2-knowledge-row-name">{item.fileName}</span>
                        <span className="v2-knowledge-status" data-tone={state.tone}>{state.label}</span>
                      </div>
                      <p className="v2-knowledge-meta">
                        {formatBytes(item.byteSize)}{item.attemptNumber > 1 ? ` · attempt ${item.attemptNumber}` : ""}
                      </p>
                      {(live || item.state === "uploading" || item.state === "queued") ? (
                        <div
                          aria-label={`${item.fileName} upload progress`}
                          aria-valuemax={100}
                          aria-valuemin={0}
                          aria-valuenow={percentage}
                          className="v2-knowledge-progress"
                          role="progressbar"
                        >
                          <div style={{ width: `${percentage}%` }} />
                        </div>
                      ) : null}
                      {failure ? <p className="v2-knowledge-error">{failure}</p> : null}
                    </div>
                    <div className="v2-knowledge-row-actions">
                      {canReselect ? (
                        <FilePickerLabel
                          accept={KNOWLEDGE_UPLOAD_ACCEPT}
                          disabled={busy}
                          icon="regenerate"
                          inputId={inputId}
                          onFiles={(files) => {
                            const file = files?.[0];
                            if (file) detail.onResumeUpload(batch.id, item.id, file);
                          }}
                        >
                          {item.state === "needs_attention" ? "Retry" : "Resume"}
                        </FilePickerLabel>
                      ) : null}
                      {canCancel ? (
                        <UiV2Button disabled={busy} onClick={() => detail.onCancelUpload(batch.id, item.id)}>
                          Cancel
                        </UiV2Button>
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

/* ---------- Sources inside a base ---------- */

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
  const drop = useDropZone(acceptFiles, uploadDisabled);
  return (
    <section aria-labelledby="knowledge-sources-title" className="v2-knowledge-section">
      <div className="v2-knowledge-section-head">
        <div>
          <h3 id="knowledge-sources-title">Sources</h3>
          <p>
            {pagination.totalItems === 0
              ? `0 ${pagination.query ? "matching " : ""}Sources`
              : `Showing ${firstSource}–${lastSource} of ${pagination.totalItems}${pagination.query ? " matching" : ""}`}
            {" · each Source has one version history across every base"}
          </p>
        </div>
        <UiV2Button className="v2-knowledge-quiet-action" disabled={busy} onClick={detail.onRefresh}>
          Refresh status
        </UiV2Button>
      </div>
      {base.owned ? (
        <div
          className="v2-knowledge-dropzone"
          data-disabled={uploadDisabled || undefined}
          data-drop-active={drop.dragActive || undefined}
          data-testid="knowledge-drop-zone"
          {...drop.handlers}
        >
          <div>
            <p>{drop.dragActive ? "Drop files to add Sources" : "Add Sources"}</p>
            <span>{knowledgeUploadHelp(detail.maxUploadBytes)} Each file becomes a reusable Source.</span>
            {base.archived ? (
              <span className="v2-knowledge-dropzone-note">Restore this base before adding Sources.</span>
            ) : null}
          </div>
          <FilePickerLabel
            accept={KNOWLEDGE_UPLOAD_ACCEPT}
            disabled={uploadDisabled}
            icon="attach"
            multiple
            onFiles={acceptFiles}
          >
            Choose files
          </FilePickerLabel>
        </div>
      ) : null}
      <UploadManifest busy={busy} detail={detail} />
      <label className="v2-resource-search v2-knowledge-search" htmlFor="knowledge-source-search-in-base">
        <span className="v2-sr-only">Search Sources in this base</span>
        <UiV2Icon name="search" />
        <input
          autoComplete="off"
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
        <div className="v2-knowledge-state">
          <UiV2Icon name="file" />
          <p>{detail.sourceQuery ? "No Sources match this search" : "No Sources in this base"}</p>
          <span>
            {detail.sourceQuery
              ? "Try another name, filename, or tag. Source contents are not searched here."
              : "Add one or more files when you are ready."}
          </span>
        </div>
      ) : (
        <ul aria-label="Sources in this Knowledge base" className="v2-knowledge-list">
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
      <Pagination
        busy={busy}
        label="Knowledge Source pages"
        onPageChange={detail.onSourcePageChange}
        page={pagination.page}
        totalPages={pagination.totalPages}
      />
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
    <li className="v2-knowledge-row" data-testid={`knowledge-source-${source.id}`}>
      <span className="v2-knowledge-row-icon" data-tone={state.tone} aria-hidden="true">
        {source.readiness.state === "ready"
          ? <UiV2Icon name={source.readiness.warningCodes.length > 0 ? "alert" : "check"} />
          : source.readiness.state === "needs_attention"
            ? <UiV2Icon name="alert" />
            : <UiV2Icon name="history" />}
      </span>
      <div className="v2-knowledge-row-main">
        <div className="v2-knowledge-row-title">
          <span className="v2-knowledge-row-name">{source.name}</span>
          <span className="v2-knowledge-status" data-tone={state.tone}>{state.label}</span>
        </div>
        <p className="v2-knowledge-meta">
          {version?.fileName ?? "Waiting for first ready version"}
          {version ? ` · ${formatBytes(version.byteSize)}` : ""}
          {version?.pageCount !== null && version?.pageCount !== undefined
            ? ` · ${version.pageCount} page${version.pageCount === 1 ? "" : "s"}`
            : ""}
          {` · updated ${formatDate(source.updatedAt)}`}
        </p>
        {source.replacement.state === "processing" ? (
          <p className="v2-knowledge-row-note">
            Replacement processing; the current ready version remains available.
          </p>
        ) : source.replacement.state === "needs_attention" ? (
          <p className="v2-knowledge-row-note" data-tone="danger">
            Replacement needs attention. Open the Source to retry or replace it.
          </p>
        ) : source.readiness.state === "needs_attention" ? (
          <p className="v2-knowledge-row-note" data-tone="danger">
            Processing needs attention. Open the Source to retry or replace it.
          </p>
        ) : null}
        {source.readiness.state === "ready" && source.readiness.warningCodes.length > 0 ? (
          <ul className="v2-knowledge-warnings">
            {processingWarningLabels(source.readiness.warningCodes).map((label) => (
              <li key={label}>{label}</li>
            ))}
          </ul>
        ) : null}
        <div className="v2-knowledge-actions">
          {onPreviewSource && version?.readiness.state === "ready" ? (
            <UiV2Button
              disabled={busy}
              icon="file"
              onClick={(event) => onPreviewSource(source.id, event.currentTarget)}
            >
              Preview
            </UiV2Button>
          ) : null}
          <UiV2Button disabled={busy} icon="chevron-right" onClick={() => detail.onOpenSource(source.id)}>
            Open Source
          </UiV2Button>
          {detail.base?.owned ? (
            <UiV2Button
              disabled={busy}
              tone="destructive"
              onClick={() => onRequestRemove({
                baseId,
                baseName,
                kind: "membership",
                sourceId: source.id,
                sourceName: source.name
              })}
            >
              Remove from base
            </UiV2Button>
          ) : null}
          {actionPending ? (
            <span className="v2-spinner v2-knowledge-action-spinner" aria-label="Source action in progress" role="status" />
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
    <section aria-labelledby="knowledge-publication-title" className="v2-knowledge-section">
      <div className="v2-knowledge-section-head">
        <div>
          <h3 id="knowledge-publication-title">Publication</h3>
          <p data-testid="knowledge-publication-disclosure">
            Publishing grants the selected audience live access to this base’s current and future content. Revoking stops future access; already accepted runs are unchanged.
          </p>
        </div>
      </div>
      {publications.length > 0 ? (
        <ul aria-label="Current Knowledge publications" className="v2-knowledge-list">
          {publications.map((publication) => (
            <li className="v2-knowledge-row v2-knowledge-row-plain" key={publication.id}>
              <div className="v2-knowledge-row-main">
                <span className="v2-knowledge-row-name">
                  {publication.scope === "installation"
                    ? "Entire installation"
                    : publication.scope === "project"
                      ? "Project publication"
                      : publication.groupName ?? "Group"}
                </span>
                <p className="v2-knowledge-meta">
                  {publication.scope === "project"
                    ? "Project details stay private after membership loss · published"
                    : "Live access · updated"} {formatDate(publication.updatedAt)}
                </p>
              </div>
              <UiV2Button
                busy={detail.actionId === `publication:${publication.id}`}
                disabled={busy}
                tone="destructive"
                onClick={() => detail.onRevokePublication(publication.id)}
              >
                Revoke
              </UiV2Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="v2-knowledge-empty">Private — no current publications.</p>
      )}
      <div className="v2-knowledge-form v2-knowledge-publish">
        <div className="v2-knowledge-field">
          <label htmlFor="knowledge-publication-scope">Audience type</label>
          <select
            className="v2-knowledge-input"
            disabled={busy || base.archived}
            id="knowledge-publication-scope"
            onChange={(event) => setScope(event.currentTarget.value as "group" | "installation")}
            value={scope}
          >
            <option value="group">Group</option>
            {detail.canPublishInstallation ? <option value="installation">Installation</option> : null}
          </select>
        </div>
        <div className="v2-knowledge-field">
          <label htmlFor="knowledge-publication-group">Audience</label>
          {scope === "group" ? (
            <select
              className="v2-knowledge-input"
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
            <div className="v2-knowledge-input v2-knowledge-input-static" id="knowledge-publication-group">Entire installation</div>
          )}
        </div>
        <UiV2Button
          busy={detail.actionId === "publication"}
          disabled={busy || base.archived || !canPublish}
          onClick={() => detail.onPublish(
            scope === "installation"
              ? { groupId: null, scope }
              : { groupId: effectiveGroupId, scope }
          )}
        >
          Publish
        </UiV2Button>
      </div>
    </section>
  );
}

/* ---------- Source detail ---------- */

function SourceDetailTask({
  busy,
  detail,
  notice,
  onDismissNotice,
  onRequestLifecycle,
  onRequestRemove,
  onPreviewSource,
  onRetry
}: {
  busy: boolean;
  detail: KnowledgeSourceDetailView;
  notice: KnowledgeLibraryNotice | null;
  onDismissNotice(): void;
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
  const heading = (
    <SubviewHeading
      actions={source ? (
        <>
          {onPreviewSource && source.currentVersion?.readiness.state === "ready" ? (
            <UiV2Button
              disabled={busy}
              icon="file"
              onClick={(event) => onPreviewSource(source.id, event.currentTarget)}
            >
              Preview
            </UiV2Button>
          ) : null}
          <UiV2Button className="v2-knowledge-quiet-action" disabled={busy} onClick={detail.onRefresh}>
            Refresh
          </UiV2Button>
        </>
      ) : undefined}
      meta={source?.trashed ? "In Trash · excluded from future runs" : "Reusable across Knowledge bases"}
      title={source?.name ?? "Source"}
    />
  );
  if (detail.dataState === "loading") {
    return <>{heading}<TaskLoading label="Loading Source…" /></>;
  }
  if (detail.dataState === "error" || !source) {
    return <>{heading}<TaskFailure error={detail.dataError} onRetry={onRetry} /></>;
  }
  const status = sourceStatus(source);
  const reprocessAvailable = source.readiness.state === "needs_attention" ||
    source.replacement.state === "needs_attention";
  const validSelectedBaseIds = selectedBaseIds.filter((id) =>
    source.eligibleBases.some((base) => base.id === id)
  );
  return (
    <>
      {heading}
      {notice ? <NoticeRow notice={notice} onDismiss={onDismissNotice} /> : null}
      {!source.owned ? (
        <Callout title="Read-only shared Source">
          <p>Shared by {source.ownerDisplayName}. You can use it through the listed bases; only its owner can edit or move it.</p>
        </Callout>
      ) : null}

      <section aria-labelledby="knowledge-source-overview-title" className="v2-knowledge-section">
        <div className="v2-knowledge-section-head">
          <div>
            <h3 id="knowledge-source-overview-title">Current Source</h3>
            <p>One canonical file identity, reused wherever you add it.</p>
          </div>
          <span className="v2-knowledge-status" data-tone={status.tone}>{status.label}</span>
        </div>
        <dl className="v2-knowledge-dl v2-knowledge-dl-four">
          <div>
            <dt>Current file</dt>
            <dd>{source.currentVersion?.fileName ?? "No ready file"}</dd>
          </div>
          <div>
            <dt>Size</dt>
            <dd>{source.currentVersion ? formatBytes(source.currentVersion.byteSize) : "Unavailable"}</dd>
          </div>
          <div>
            <dt>Used in</dt>
            <dd>{source.membershipCount} {source.membershipCount === 1 ? "base" : "bases"}</dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>{formatDate(source.updatedAt)}</dd>
          </div>
        </dl>
        {source.readiness.state === "needs_attention" &&
        source.replacement.state !== "needs_attention" ? (
          <Callout role="status" title="Processing needs attention" tone="danger">
            <p>
              Retry processing here or replace the file with a corrected copy.
              {source.readiness.supportReference
                ? ` Support reference ${source.readiness.supportReference}.`
                : ""}
            </p>
          </Callout>
        ) : null}
        {source.replacement.state === "processing" ? (
          <Callout role="status" title="Replacement processing">
            <p>The current ready version stays available until the replacement is ready.</p>
          </Callout>
        ) : source.replacement.state === "needs_attention" ? (
          <Callout role="status" title="Replacement needs attention" tone="danger">
            <p>
              Retry the replacement or upload a different file. The current ready version is unchanged.
              {source.replacement.supportReference
                ? ` Support reference ${source.replacement.supportReference}.`
                : ""}
            </p>
          </Callout>
        ) : null}
        {source.readiness.state === "ready" && source.readiness.warningCodes.length > 0 ? (
          <Callout role="status" title="Ready with warnings" tone="warn">
            <ul className="v2-knowledge-warnings">
              {processingWarningLabels(source.readiness.warningCodes).map((label) => (
                <li key={label}>{label}</li>
              ))}
            </ul>
          </Callout>
        ) : null}
        {source.owned && !source.trashed && !source.deletionPending ? (
          <div className="v2-knowledge-actions">
            {reprocessAvailable ? (
              <UiV2Button
                busy={detail.actionId === "source:reprocess"}
                disabled={busy}
                icon="regenerate"
                onClick={detail.onReprocess}
              >
                Retry processing
              </UiV2Button>
            ) : null}
            <FilePickerLabel
              accept={KNOWLEDGE_UPLOAD_ACCEPT}
              busy={detail.actionId === "source:replace"}
              disabled={busy || source.replacement.state === "processing"}
              icon="attach"
              inputId="knowledge-source-replace"
              onFiles={(files) => {
                const file = files?.[0];
                if (file) detail.onReplace(file);
              }}
            >
              Replace file
            </FilePickerLabel>
            <p className="v2-knowledge-actions-note">
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

      {!source.trashed ? (
        <section aria-labelledby="knowledge-source-details-title" className="v2-knowledge-section">
          <div className="v2-knowledge-section-head">
            <div><h3 id="knowledge-source-details-title">Details</h3></div>
          </div>
          {source.owned ? (
            <form
              className="v2-knowledge-form"
              onSubmit={(event) => {
                event.preventDefault();
                detail.onSave();
              }}
            >
              <div className="v2-knowledge-field">
                <label htmlFor="knowledge-source-name">Name</label>
                <input
                  className="v2-knowledge-input"
                  disabled={busy}
                  id="knowledge-source-name"
                  maxLength={KNOWLEDGE_SOURCE_NAME_MAX_LENGTH}
                  onChange={(event) => detail.onChange({ name: event.currentTarget.value })}
                  required
                  value={detail.draft.name}
                />
              </div>
              <div className="v2-knowledge-field">
                <label htmlFor="knowledge-source-tags">Tags</label>
                <input
                  className="v2-knowledge-input"
                  disabled={busy}
                  id="knowledge-source-tags"
                  maxLength={KNOWLEDGE_SOURCE_TAG_MAX_COUNT * (KNOWLEDGE_SOURCE_TAG_MAX_LENGTH + 2)}
                  onChange={(event) => detail.onChange({ tags: event.currentTarget.value })}
                  placeholder="product, policy, onboarding"
                  value={detail.draft.tags}
                />
                <span className="v2-knowledge-field-note">Comma-separated · up to {KNOWLEDGE_SOURCE_TAG_MAX_COUNT}</span>
              </div>
              <div className="v2-knowledge-field v2-knowledge-form-wide">
                <label htmlFor="knowledge-source-description">Description</label>
                <textarea
                  className="v2-knowledge-input"
                  disabled={busy}
                  id="knowledge-source-description"
                  maxLength={KNOWLEDGE_SOURCE_DESCRIPTION_MAX_LENGTH}
                  onChange={(event) => detail.onChange({ description: event.currentTarget.value })}
                  rows={4}
                  value={detail.draft.description}
                />
              </div>
              {detail.error ? <p className="v2-knowledge-error v2-knowledge-form-wide" role="alert">{detail.error.text}</p> : null}
              <div className="v2-knowledge-form-actions v2-knowledge-form-wide">
                <UiV2Button
                  busy={detail.actionId === "source:settings"}
                  disabled={busy || !detail.dirty}
                  tone="primary"
                  type="submit"
                >
                  Save details
                </UiV2Button>
              </div>
            </form>
          ) : (
            <dl className="v2-knowledge-dl">
              <div><dt>Owner</dt><dd>{source.ownerDisplayName}</dd></div>
              <div><dt>Description</dt><dd className="v2-knowledge-prewrap">{source.description || "No description"}</dd></div>
            </dl>
          )}
        </section>
      ) : null}

      {!source.trashed ? (
        <section aria-labelledby="knowledge-source-bases-title" className="v2-knowledge-section">
          <div className="v2-knowledge-section-head">
            <div>
              <h3 id="knowledge-source-bases-title">Knowledge bases</h3>
              <p>These memberships determine where Chat, Project, and Assistant Knowledge selection can use this Source.</p>
            </div>
          </div>
          {source.memberships.length === 0 ? (
            <p className="v2-knowledge-empty">Not currently used by a base.</p>
          ) : (
            <ul aria-label="Source Base memberships" className="v2-knowledge-list">
              {source.memberships.map((base) => (
                <li className="v2-knowledge-row v2-knowledge-row-plain" key={base.id}>
                  <div className="v2-knowledge-row-main">
                    <span className="v2-knowledge-row-name">{base.name}</span>
                    <p className="v2-knowledge-meta">
                      {base.archived ? "Archived base" : "Available for future selection"}
                    </p>
                  </div>
                  {source.owned ? (
                    <UiV2Button
                      busy={detail.actionId === `source:remove:${base.id}`}
                      disabled={busy}
                      tone="destructive"
                      onClick={() => onRequestRemove({
                        baseId: base.id,
                        baseName: base.name,
                        kind: "membership",
                        sourceId: source.id,
                        sourceName: source.name
                      })}
                    >
                      Remove from base
                    </UiV2Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {source.owned && source.eligibleBases.length > 0 ? (
            <div className="v2-knowledge-membership-tools">
              <fieldset className="v2-knowledge-fieldset">
                <legend>Add to bases</legend>
                <p>Reuse this Source without another upload.</p>
                <div className="v2-knowledge-checklist">
                  {source.eligibleBases.map((base) => (
                    <label key={base.id}>
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
                      <span>{base.name}</span>
                    </label>
                  ))}
                </div>
                <UiV2Button
                  busy={detail.actionId === "source:add"}
                  disabled={busy || validSelectedBaseIds.length === 0}
                  icon="plus"
                  onClick={() => {
                    detail.onAddToBases(validSelectedBaseIds);
                    setSelectedBaseIds([]);
                  }}
                >
                  Add to selected
                </UiV2Button>
              </fieldset>
              {source.memberships.length > 0 ? (
                <div className="v2-knowledge-fieldset">
                  <h4>Move Source</h4>
                  <p>Move removes one membership and adds another in one action.</p>
                  <div className="v2-knowledge-move">
                    <div className="v2-knowledge-field">
                      <label htmlFor="knowledge-source-move-from">From</label>
                      <select
                        className="v2-knowledge-input"
                        disabled={busy}
                        id="knowledge-source-move-from"
                        onChange={(event) => setMoveFromBaseId(event.currentTarget.value)}
                        value={effectiveMoveFrom}
                      >
                        {source.memberships.map((base) => <option key={base.id} value={base.id}>{base.name}</option>)}
                      </select>
                    </div>
                    <UiV2Icon className="v2-knowledge-move-arrow" name="chevron-right" />
                    <div className="v2-knowledge-field">
                      <label htmlFor="knowledge-source-move-to">To</label>
                      <select
                        className="v2-knowledge-input"
                        disabled={busy}
                        id="knowledge-source-move-to"
                        onChange={(event) => setMoveToBaseId(event.currentTarget.value)}
                        value={effectiveMoveTo}
                      >
                        {source.eligibleBases.map((base) => <option key={base.id} value={base.id}>{base.name}</option>)}
                      </select>
                    </div>
                  </div>
                  <UiV2Button
                    busy={detail.actionId?.startsWith("source:move:") ?? false}
                    disabled={busy || !effectiveMoveFrom || !effectiveMoveTo}
                    icon="chevron-right"
                    onClick={() => detail.onMove(effectiveMoveFrom, effectiveMoveTo)}
                  >
                    Move Source
                  </UiV2Button>
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      <section aria-labelledby="knowledge-source-history-title" className="v2-knowledge-section">
        <details className="v2-knowledge-details">
          <summary className="v2-focusable" id="knowledge-source-history-title">
            <UiV2Icon name="chevron-right" />
            <span>Version history · {source.versions.length}</span>
          </summary>
          <p className="v2-knowledge-details-note">
            Replacements create versions. Existing accepted chats keep the version they used.
          </p>
          <ul aria-label="Source versions" className="v2-knowledge-list">
            {source.versions.map((version) => {
              const versionStatus = version.readiness.state === "ready"
                ? version.readiness.warningCodes.length > 0 ? "Ready with warnings" : "Ready"
                : version.readiness.state === "processing"
                  ? "Processing"
                  : "Needs attention";
              return (
                <li className="v2-knowledge-row v2-knowledge-row-plain" key={version.versionNumber}>
                  <div className="v2-knowledge-row-main">
                    <span className="v2-knowledge-row-name">Version {version.versionNumber} · {version.fileName}</span>
                    <p className="v2-knowledge-meta">{formatBytes(version.byteSize)} · {formatDate(version.createdAt)}</p>
                  </div>
                  <span className="v2-knowledge-status" data-tone="neutral">
                    {version.isCurrent ? "Current · " : version.isPending ? "Replacement · " : ""}{versionStatus}
                  </span>
                </li>
              );
            })}
          </ul>
        </details>
      </section>
    </>
  );
}
