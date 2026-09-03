import {
  ConfirmationDialog,
  DiscardChangesConfirmationDialog
} from "@/components/app-shell/ConfirmationDialog";
import { useBeforeUnloadGuard } from "@/components/app-shell/useBeforeUnloadGuard";
import { useDialogFocus } from "@/components/app-shell/useDialogFocus";
import type {
  KnowledgeCreateView,
  KnowledgeDetailView,
  KnowledgeLibraryNotice,
  KnowledgeLibraryView,
  KnowledgeListView,
  KnowledgeSourceDetailView
} from "@/components/knowledge/libraryViewContracts";
import {
  UiV2Button,
  UiV2Icon,
  UiV2IconButton,
  UiV2MenuItem,
  UiV2MenuSeparator,
  type UiV2IconName
} from "@/components/ui-v2";
import { UiV2ResponsiveMenu } from "@/components/ui-v2/ResponsiveMenuV2";
import { useMenuDismissalV2 } from "@/components/ui-v2/useMenuDismissalV2";
import {
  loadKnowledgeSourceViewer,
  knowledgeSourceOriginalUrl,
  knowledgeSourcePageUrl
} from "@/features/citations-v2/knowledgeCitationApi";
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
  KnowledgeSourceViewer,
  KnowledgeViewerBlock
} from "@/lib/contracts/knowledgeCitations";
import type {
  KnowledgeUploadBatch,
  KnowledgeUploadItem
} from "@/lib/contracts/knowledgeUploads";
import { knowledgeAggregateStatus } from "@/lib/domain/knowledgePresentation";
import { knowledgeProcessingNote } from "@/lib/domain/knowledgeProcessingWarnings";
import {
  KNOWLEDGE_UPLOAD_ACCEPT,
  KNOWLEDGE_UPLOAD_FORMAT_LABELS
} from "@/lib/domain/uploadFormats";
import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";

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
type BaseDialogKind = "rename" | "share";

type NormalizedPreviewState = Readonly<{
  key: string;
  status: "error" | "idle" | "loading" | "ready";
  value: KnowledgeSourceViewer | null;
}>;

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
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  const elapsed = date.getTime() - Date.now();
  const absolute = Math.abs(elapsed);
  const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (absolute < 60_000) return "just now";
  if (absolute < 3_600_000) return relative.format(Math.round(elapsed / 60_000), "minute");
  if (absolute < 86_400_000) return relative.format(Math.round(elapsed / 3_600_000), "hour");
  if (absolute < 604_800_000) return relative.format(Math.round(elapsed / 86_400_000), "day");
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

function fileTypeLabel(fileName: string): string {
  const extension = fileName.split(".").pop()?.trim().toLocaleUpperCase();
  return extension && extension !== fileName.toLocaleUpperCase() ? extension : "Document";
}

function formatBytes(value: number): string {
  if (value < 1_000) return `${value} B`;
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} kB`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)} MB`;
}

function isVisualPreviewFile(fileName: string): boolean {
  return /\.(?:gif|jpe?g|pdf|png|webp)$/iu.test(fileName);
}

function NormalizedDocumentPreview({ blocks }: Readonly<{
  blocks: readonly KnowledgeViewerBlock[];
}>) {
  return (
    <div
      aria-label="Normalized document preview"
      className="v2-knowledge-doc-normalized"
      data-testid="knowledge-normalized-preview"
    >
      {blocks.map((block, index) => (
        <section
          data-block-type={block.type}
          key={`${block.pageStart}:${block.pageEnd}:${block.type}:${index}`}
        >
          {block.headingPath.length > 0 ? (
            <small>{block.headingPath.join(" / ")}</small>
          ) : null}
          <p>{block.text || (block.type === "image" ? "Image region" : "")}</p>
        </section>
      ))}
    </div>
  );
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
      ? "Document details"
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
  trail?: readonly string[];
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
      label: view.sourceDetail?.source?.name ?? "Document",
      ...(view.sourceDetail?.parentLabel ? { trail: [view.sourceDetail.parentLabel] } : {})
    };
  }
  return { backLabel: "Back to Knowledge", key: "sources", label: "Documents" };
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
  view
}: {
  view: KnowledgeLibraryView;
}) {
  const [lifecycleTarget, setLifecycleTarget] = useState<LifecycleTarget | null>(null);
  const [removeTarget, setRemoveTarget] = useState<RemoveTarget | null>(null);
  const [baseDialog, setBaseDialog] = useState<BaseDialogKind | null>(null);
  const childDialogOpen = lifecycleTarget !== null || removeTarget !== null || baseDialog !== null;
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
            onOpenBaseDialog={setBaseDialog}
            onRequestLifecycle={setLifecycleTarget}
            onRequestRemove={setRemoveTarget}
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
          title="Remove document from this base?"
          tone="warning"
        >
          The document stays in your library and in its other bases. Future chats using this base will no longer include it; accepted chats are unchanged.
        </ConfirmationDialog>
      ) : null}
      {lifecycleTarget ? (
        <ConfirmationDialog
          confirmLabel={lifecycleTarget.action === "delete"
            ? "Delete permanently"
            : lifecycleTarget.action === "restore" ? "Restore document" : "Move to Trash"}
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
            ? `Delete this ${lifecycleTarget.kind === "base" ? "base" : "document"} permanently?`
            : lifecycleTarget.action === "restore"
              ? "Restore this document to its bases?"
            : `Move this ${lifecycleTarget.kind === "base" ? "base" : "document"} to Trash?`}
          tone={lifecycleTarget.action === "delete" ? "destructive" : "warning"}
        >
          {lifecycleTarget.action === "restore"
            ? `This document belongs to ${lifecycleTarget.membershipCount ?? 0} bases. Restoring it makes the current ready file available to future chats in each accessible base.`
            : lifecycleTarget.action === "delete"
            ? lifecycleTarget.kind === "base"
              ? "This cannot be undone. The base and its document memberships will be removed. The reusable documents stay in your Library. Past answers remain unchanged."
              : "This cannot be undone. The document, its history, and its stored files will be removed. Past answer text remains, but its cited evidence will no longer open."
            : lifecycleTarget.kind === "base"
              ? "Future chats stop using this base immediately. You can restore its document memberships and sharing settings from Trash."
              : "Future chats exclude this document from every base immediately. You can restore its previous memberships from Trash."}
        </ConfirmationDialog>
      ) : null}
      {baseDialog && view.detail?.base ? (
        <KnowledgeDialog
          label={baseDialog === "rename" ? "Rename and describe Knowledge base" : "Share Knowledge base"}
          onClose={() => {
            if (baseDialog === "rename") {
              view.detail?.onChange({
                description: view.detail.base?.description ?? "",
                name: view.detail.base?.name ?? ""
              });
            }
            setBaseDialog(null);
          }}
          title={baseDialog === "rename" ? "Rename and describe" : "Share with a group"}
        >
          {baseDialog === "rename" ? (
            <>
              <BaseSettings busy={view.busy} detail={view.detail} compact />
              <div className="v2-knowledge-form-actions">
                <UiV2Button disabled={view.busy} onClick={() => setBaseDialog(null)}>Cancel</UiV2Button>
                <UiV2Button
                  busy={view.detail.actionId === "settings"}
                  disabled={view.busy || !view.detail.dirty}
                  tone="primary"
                  onClick={() => {
                    view.detail?.onSave();
                    setBaseDialog(null);
                  }}
                >
                  Save changes
                </UiV2Button>
              </div>
            </>
          ) : (
            <PublicationSection busy={view.busy} detail={view.detail} compact />
          )}
        </KnowledgeDialog>
      ) : null}
    </>
  );
}

/* ---------- Shared pieces ---------- */

function KnowledgeDialog({
  children,
  label,
  onClose,
  title
}: Readonly<{
  children: ReactNode;
  label: string;
  onClose(): void;
  title: string;
}>) {
  const dialogRef = useDialogFocus<HTMLDivElement>({ onClose });
  return createPortal(
    <div className="v2-knowledge-dialog-layer" role="presentation" onMouseDown={onClose}>
      <div
        aria-label={label}
        aria-modal="true"
        className="v2-knowledge-dialog"
        ref={dialogRef}
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <h2>{title}</h2>
          <UiV2IconButton icon="close" label={`Close ${label}`} onClick={onClose} />
        </header>
        <div className="v2-knowledge-dialog-body">{children}</div>
      </div>
    </div>,
    document.body
  );
}

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
  onFiles,
  tone = "ghost"
}: {
  accept: string;
  busy?: boolean;
  children: ReactNode;
  disabled: boolean;
  icon: UiV2IconName;
  inputId?: string;
  multiple?: boolean;
  onFiles(files: FileList | null): void;
  tone?: "ghost" | "primary";
}) {
  return (
    <label
      aria-disabled={disabled || undefined}
      className="v2-button v2-focusable v2-knowledge-file-picker"
      data-disabled={disabled || undefined}
      data-tone={tone}
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
              <span className="v2-sr-only">Search documents</span>
              <UiV2Icon name="search" />
              <input
                disabled={busy}
                id="knowledge-search"
                onChange={(event) => list.onSourceQueryChange(event.currentTarget.value)}
                placeholder="Search documents"
                type="search"
                value={list.sourceQuery}
              />
            </label>
            <UiV2Button disabled={busy || !list.canCreate} icon="plus" tone="primary" onClick={list.onNewBase}>
              New base + files
            </UiV2Button>
          </>
        )}
        meta="Documents are reusable files. Add one document to several bases without uploading it again."
        title="Documents"
      />
      {notice ? <NoticeRow notice={notice} onDismiss={onDismissNotice} /> : null}
      <div aria-label="Document filters" className="v2-resource-filters" role="group">
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
        <TaskLoading label="Loading documents…" />
      ) : list.sourceDataState === "error" ? (
        <TaskFailure error={list.sourceDataError} onRetry={onRetry} />
      ) : sources.length === 0 ? (
        <div className="v2-knowledge-state">
          <UiV2Icon name="file" />
          <p>{filtered ? "No matching documents" : "No documents yet"}</p>
          <span>
            {filtered
              ? "Try another search or filter."
              : "Upload a file to a Knowledge base. It will appear here as a reusable document."}
          </span>
          {!filtered ? (
            <UiV2Button disabled={!list.canCreate} icon="plus" onClick={list.onNewBase}>
              Create a base and add files
            </UiV2Button>
          ) : null}
        </div>
      ) : (
        <>
          <ul aria-label="Knowledge documents" className="v2-knowledge-list">
            {sources.map((source) => (
              <SourceRow key={source.id} busy={busy} list={list} source={source} />
            ))}
          </ul>
          <Pagination
            busy={busy}
            label="Document pages"
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
      return source.canReprocess
        ? { label: "Ready · replacement needs attention", tone: "warn" }
        : { label: "Ready · replacement unavailable", tone: "warn" };
    }
    return { label: "Ready", tone: "ok" };
  }
  return source.readiness.state === "processing"
    ? { label: "Processing", tone: "live" }
    : source.canReprocess
      ? { label: "Needs attention", tone: "danger" }
      : { label: "Unavailable", tone: "danger" };
}

function sourceIcon(source: KnowledgeSourceSummary): { name: UiV2IconName; spinning: boolean } {
  if (source.trashed) return { name: "trash", spinning: false };
  if (source.readiness.state === "ready") {
    return { name: "check", spinning: false };
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
          {source.readiness.state === "ready" && source.readiness.warningCodes.length > 0 ? (
            <span className="v2-knowledge-row-note">
              {knowledgeProcessingNote(source.readiness.warningCodes)}
            </span>
          ) : null}
          {source.tags.length > 0 ? (
            <span className="v2-knowledge-tags" aria-label="Document tags">
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
      ({ lastModified, name, size }) => `${name}:${size}:${lastModified}`
    ));
    const additions = Array.from(files).filter((file) => {
      const key = `${file.name}:${file.size}:${file.lastModified}`;
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

function BaseActionsMenu({
  busy,
  detail,
  onOpenDialog,
  onRequestTrash
}: Readonly<{
  busy: boolean;
  detail: KnowledgeDetailView;
  onOpenDialog(dialog: BaseDialogKind): void;
  onRequestTrash(): void;
}>) {
  const [open, setOpen] = useState(false);
  const { menuRef, triggerRef } = useMenuDismissalV2({
    onClose: () => setOpen(false),
    open
  });
  const base = detail.base!;
  return (
    <span className="v2-knowledge-menu-wrap">
      <UiV2IconButton
        ref={triggerRef}
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={busy}
        icon="more"
        label={`More actions for ${base.name}`}
        onClick={() => setOpen((value) => !value)}
      />
      {open ? (
        <UiV2ResponsiveMenu
          anchorRef={triggerRef}
          label={`Actions for ${base.name}`}
          menuRef={menuRef}
          onClose={() => setOpen(false)}
        >
          <UiV2MenuItem icon="edit" onClick={() => {
            setOpen(false);
            onOpenDialog("rename");
          }}>
            Rename and describe…
          </UiV2MenuItem>
          <UiV2MenuItem icon="share" onClick={() => {
            setOpen(false);
            onOpenDialog("share");
          }}>
            Share with a group…
          </UiV2MenuItem>
          <UiV2MenuItem icon={base.archived ? "regenerate" : "archive"} onClick={() => {
            setOpen(false);
            detail.onArchiveToggle(!base.archived);
          }}>
            {base.archived ? "Restore from Archive" : "Archive"}
          </UiV2MenuItem>
          <UiV2MenuSeparator />
          <UiV2MenuItem icon="trash" tone="destructive" onClick={() => {
            setOpen(false);
            onRequestTrash();
          }}>
            Move to Trash
          </UiV2MenuItem>
        </UiV2ResponsiveMenu>
      ) : null}
    </span>
  );
}

function DetailTask({
  busy,
  detail,
  notice,
  onDismissNotice,
  onOpenBaseDialog,
  onRequestLifecycle,
  onRequestRemove,
  onRetry
}: {
  busy: boolean;
  detail: KnowledgeDetailView;
  notice: KnowledgeLibraryNotice | null;
  onDismissNotice(): void;
  onOpenBaseDialog(dialog: BaseDialogKind): void;
  onRequestLifecycle(target: LifecycleTarget): void;
  onRequestRemove(target: RemoveTarget): void;
  onRetry(): void;
}) {
  const base = detail.base;
  const fileInputId = "knowledge-base-add-files";
  const aggregate = base ? knowledgeReadinessText(base.readiness, base.purgeScheduledAt) : "Loading";
  const sharing = base?.publications?.length
    ? base.publications.some((publication) => publication.scope === "installation")
      ? "Shared with the installation"
      : `Shared with ${base.publications[0]?.groupName ?? "a group"}`
    : "Private";
  const heading = (
    <SubviewHeading
      actions={base?.owned && !base.trashed ? (
        <>
          <FilePickerLabel
            accept={KNOWLEDGE_UPLOAD_ACCEPT}
            disabled={busy || base.archived}
            icon="plus"
            inputId={fileInputId}
            multiple
            tone="primary"
            onFiles={(files) => {
              if (files?.length) detail.onUpload(Array.from(files));
            }}
          >
            Add files
          </FilePickerLabel>
          <BaseActionsMenu
            busy={busy}
            detail={detail}
            onOpenDialog={onOpenBaseDialog}
            onRequestTrash={() => onRequestLifecycle({ action: "trash", kind: "base", name: base.name })}
          />
        </>
      ) : undefined}
      meta={base
        ? `${aggregate} · ${base.sourceCount} ${base.sourceCount === 1 ? "document" : "documents"} · updated ${formatDate(base.updatedAt)} · ${sharing}`
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
      {base.owned && (base.trashed || base.deletionPending) ? (
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
      {!base.trashed ? (
        <SourcesSection
          busy={busy}
          detail={detail}
          onRequestRemove={onRequestRemove}
        />
      ) : null}
    </>
  );
}

/** The exact aggregate status sentence shared by every Knowledge surface. */
export function knowledgeReadinessText(
  readiness: KnowledgeReadiness,
  purgeScheduledAt: string | null = null
): string {
  return knowledgeAggregateStatus({
    attentionDocuments: readiness.attentionSources,
    processingDocuments: readiness.processingSources,
    purgeScheduledAt,
    readyDocuments: readiness.readySources,
    state: readiness.state
  }).label;
}

function BaseSettings({
  busy,
  compact = false,
  detail
}: {
  busy: boolean;
  compact?: boolean;
  detail: KnowledgeDetailView;
}) {
  const base = detail.base!;
  const fields = base.owned ? (
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
  );
  if (compact) return fields;
  return (
    <section aria-labelledby="knowledge-settings-title" className="v2-knowledge-section">
      <div className="v2-knowledge-section-head">
        <div>
          <h3 id="knowledge-settings-title">Base settings</h3>
          <p>Update how this base is named and described throughout Knowledge.</p>
        </div>
        {base.archived ? <span className="v2-knowledge-tag">Archived</span> : null}
      </div>
      {fields}
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
  const label = kind === "base" ? "Knowledge base" : "Document";
  if (!trashed) return null;

  return (
    <section aria-label={`${label} Trash actions`} className="v2-knowledge-section">
      <div className="v2-knowledge-callout" data-tone="warn">
        <h3 className="v2-knowledge-callout-title">
          {deletionPending ? "Permanent deletion pending" : `${label} is in Trash`}
        </h3>
        <p>
          {deletionPending
            ? "Deleting permanently… This cannot be undone, and this item can no longer be restored."
            : kind === "base"
              ? "Future runs cannot use this base. Restore it with its document memberships and sharing settings, or delete only the base permanently."
              : "Future runs cannot use this document. Restore its previous base memberships, or permanently remove every version and stored object."}
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
      return { label: "Ready", tone: "ok" };
    case "reused":
      return { label: "Already added", tone: "ok" };
    case "needs_attention":
      return { label: "Needs attention", tone: "danger" };
    case "cancelled":
      return { label: "Cancelled", tone: "neutral" };
    case "upload_complete":
      return { label: "Uploading", tone: "live" };
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
    knowledge_processing_failed: "Processing could not produce a usable document.",
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
                      {item.state === "ready" || item.state === "ready_with_warnings" || item.state === "reused"
                        ? <UiV2Icon name="check" />
                        : item.state === "needs_attention"
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
                        {formatBytes(item.byteSize)}
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
  onRequestRemove
}: {
  busy: boolean;
  detail: KnowledgeDetailView;
  onRequestRemove(target: RemoveTarget): void;
}) {
  const [filter, setFilter] = useState<"all" | "needs_attention" | "processing">("all");
  const base = detail.base!;
  const response = detail.sources!;
  const sources = response.sources;
  const visibleSources = sources.filter((source) => filter === "all" || source.readiness.state === filter ||
    filter === "needs_attention" && source.replacement.state === "needs_attention");
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
          <h3 id="knowledge-sources-title">Documents</h3>
          <p>
            {pagination.totalItems === 0
              ? `0 ${pagination.query ? "matching " : ""}documents`
              : `Showing ${firstSource}–${lastSource} of ${pagination.totalItems}${pagination.query ? " matching" : ""}`}
          </p>
        </div>
      </div>
      <div className="v2-knowledge-document-toolbar">
        <div aria-label="Document status filter" className="v2-resource-filters" role="group">
          {([
            ["all", `All ${pagination.totalItems}`],
            ["needs_attention", `Needs attention ${base.readiness.attentionSources}`],
            ["processing", `Processing ${base.readiness.processingSources}`]
          ] as const).map(([value, label]) => (
            <button
              aria-pressed={filter === value}
              className="v2-resource-filter v2-focusable"
              data-selected={filter === value || undefined}
              disabled={busy}
              key={value}
              type="button"
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="v2-resource-search v2-knowledge-search" htmlFor="knowledge-source-search-in-base">
          <span className="v2-sr-only">Search documents in this base</span>
          <UiV2Icon name="search" />
          <input
            autoComplete="off"
            disabled={busy}
            id="knowledge-source-search-in-base"
            maxLength={KNOWLEDGE_SOURCE_SEARCH_MAX_LENGTH}
            onChange={(event) => detail.onSourceQueryChange(event.currentTarget.value)}
            placeholder="Search documents…"
            type="search"
            value={detail.sourceQuery}
          />
        </label>
      </div>
      <UploadManifest busy={busy} detail={detail} />
      {visibleSources.length === 0 ? (
        <div className="v2-knowledge-state">
          <UiV2Icon name="file" />
          <p>{detail.sourceQuery
            ? `No documents match “${detail.sourceQuery}”`
            : filter === "needs_attention"
              ? "No documents need attention"
              : filter === "processing"
                ? "No documents are processing"
                : "No documents in this base"}</p>
          <span>
            {detail.sourceQuery
              ? "Try another name, filename, or tag."
              : "Add one or more files when you are ready."}
          </span>
        </div>
      ) : (
        <ul aria-label="Documents in this Knowledge base" className="v2-knowledge-list">
          {visibleSources.map((source) => (
            <SourceMembershipRow
              key={source.id}
              baseId={base.id}
              baseName={base.name}
              busy={busy}
              detail={detail}
              onRequestRemove={onRequestRemove}
              source={source}
            />
          ))}
        </ul>
      )}
      <Pagination
        busy={busy}
        label="Knowledge document pages"
        onPageChange={detail.onSourcePageChange}
        page={pagination.page}
        totalPages={pagination.totalPages}
      />
      {base.owned ? (
        <div
          className="v2-knowledge-dropzone"
          data-disabled={uploadDisabled || undefined}
          data-drop-active={drop.dragActive || undefined}
          data-testid="knowledge-drop-zone"
          {...drop.handlers}
        >
          <div>
            <p>{drop.dragActive ? "Drop files to add them" : "Drop files here to add documents"}</p>
            <span>PDF, Office files, text, images, and data files · up to {formatBytes(detail.maxUploadBytes)} each.</span>
            <details className="v2-knowledge-supported-formats">
              <summary>Supported formats</summary>
              <span>{KNOWLEDGE_UPLOAD_FORMAT_LABELS.join(", ")}</span>
            </details>
            {base.archived ? (
              <span className="v2-knowledge-dropzone-note">Restore this base before adding documents.</span>
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
      <p className="v2-knowledge-membership-note">
        A document can live in several bases. Removing it here does not delete the file.
      </p>
    </section>
  );
}

function SourceMembershipRow({
  baseId,
  baseName,
  busy,
  detail,
  onRequestRemove,
  source
}: {
  baseId: string;
  baseName: string;
  busy: boolean;
  detail: KnowledgeDetailView;
  onRequestRemove(target: RemoveTarget): void;
  source: KnowledgeSourceSummary;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { menuRef, triggerRef } = useMenuDismissalV2({
    onClose: () => setMenuOpen(false),
    open: menuOpen
  });
  const state = sourceStatus(source);
  const version = source.currentVersion;
  const actionPending = detail.actionId === `base-source:${source.id}:remove`;
  return (
    <li className="v2-knowledge-row v2-knowledge-document-row" data-testid={`knowledge-source-${source.id}`}>
      <span className="v2-knowledge-row-icon" data-tone={state.tone} aria-hidden="true">
        {source.readiness.state === "ready"
          ? <UiV2Icon name="check" />
          : source.readiness.state === "needs_attention"
            ? <UiV2Icon name="alert" />
            : <UiV2Icon name="history" />}
      </span>
      <button
        className="v2-knowledge-row-main v2-knowledge-document-open v2-focusable"
        disabled={busy}
        type="button"
        onClick={() => detail.onOpenSource(source.id)}
      >
        <div className="v2-knowledge-row-title">
          <span className="v2-knowledge-row-name">{source.name}</span>
        </div>
        <p className="v2-knowledge-meta">
          {version ? `${fileTypeLabel(version.fileName)} · ${formatBytes(version.byteSize)}` : "Waiting for a ready file"}
          {version?.pageCount !== null && version?.pageCount !== undefined
            ? ` · ${version.pageCount} page${version.pageCount === 1 ? "" : "s"}`
            : ""}
          {` · added ${formatDate(source.updatedAt)}`}
        </p>
        {source.replacement.state === "processing" ? (
          <p className="v2-knowledge-row-note">
            Replacement processing; the current ready version remains available.
          </p>
        ) : source.replacement.state === "needs_attention" ? (
          <p className="v2-knowledge-row-note" data-tone={source.canReprocess ? "danger" : undefined}>
            {source.canReprocess
              ? "Replacement needs attention. Open the document to reprocess or replace it."
              : "Replacement unavailable. The current ready version remains available."}
          </p>
        ) : source.readiness.state === "needs_attention" ? (
          <p className="v2-knowledge-row-note" data-tone="danger">
            {source.canReprocess
              ? "Processing needs attention. Open the document to reprocess or replace it."
              : "This document is unavailable."}
          </p>
        ) : null}
        {source.readiness.state === "ready" && source.readiness.warningCodes.length > 0 ? (
          <p className="v2-knowledge-row-note"><UiV2Icon name="alert" />
            {knowledgeProcessingNote(source.readiness.warningCodes)}
          </p>
        ) : null}
      </button>
      <div className="v2-knowledge-document-controls">
        <span className="v2-knowledge-status" data-tone={state.tone}>{state.label}</span>
        {version?.readiness.state === "ready" ? (
          <UiV2Button disabled={busy} onClick={() => detail.onOpenSource(source.id)}>Preview</UiV2Button>
        ) : null}
        <UiV2IconButton
          ref={triggerRef}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          disabled={busy}
          icon="more"
          label={`More actions for ${source.name}`}
          onClick={() => setMenuOpen((open) => !open)}
        />
        {menuOpen ? (
          <UiV2ResponsiveMenu
            anchorRef={triggerRef}
            label={`Actions for ${source.name}`}
            menuRef={menuRef}
            onClose={() => setMenuOpen(false)}
          >
            <UiV2MenuItem icon="file" onClick={() => {
              setMenuOpen(false);
              detail.onOpenSource(source.id);
            }}>
              Open document
            </UiV2MenuItem>
            {detail.base?.owned ? (
              <>
                <UiV2MenuSeparator />
                <UiV2MenuItem icon="close" tone="destructive" onClick={() => {
                  setMenuOpen(false);
                  onRequestRemove({
                    baseId,
                    baseName,
                    kind: "membership",
                    sourceId: source.id,
                    sourceName: source.name
                  });
                }}>
                  Remove from base
                </UiV2MenuItem>
              </>
            ) : null}
          </UiV2ResponsiveMenu>
        ) : null}
        {actionPending ? (
          <span className="v2-spinner v2-knowledge-action-spinner" aria-label="Document action in progress" role="status" />
        ) : null}
      </div>
    </li>
  );
}

function PublicationSection({
  busy,
  compact = false,
  detail
}: {
  busy: boolean;
  compact?: boolean;
  detail: KnowledgeDetailView;
}) {
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
    <section
      aria-labelledby="knowledge-publication-title"
      className={compact ? "v2-knowledge-publication-dialog" : "v2-knowledge-section"}
    >
      <div className="v2-knowledge-section-head">
        <div>
          <h3 id="knowledge-publication-title">Publication</h3>
          <p data-testid="knowledge-publication-disclosure">
            Publishing grants the selected audience live access to this base’s current and future content. Revoking stops future access; work already in progress and past answers are unchanged.
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

type SourceDialogKind = "bases" | "details";

function SourceActionsMenu({
  busy,
  onOpenDialog,
  onReprocess,
  onTrash,
  reprocessAvailable,
  source
}: Readonly<{
  busy: boolean;
  onOpenDialog(dialog: SourceDialogKind): void;
  onReprocess(): void;
  onTrash(): void;
  reprocessAvailable: boolean;
  source: KnowledgeSourceSummary;
}>) {
  const [open, setOpen] = useState(false);
  const { menuRef, triggerRef } = useMenuDismissalV2({
    onClose: () => setOpen(false),
    open
  });
  return (
    <span className="v2-knowledge-menu-wrap">
      <UiV2IconButton
        ref={triggerRef}
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={busy}
        icon="more"
        label={`More actions for ${source.name}`}
        onClick={() => setOpen((value) => !value)}
      />
      {open ? (
        <UiV2ResponsiveMenu
          anchorRef={triggerRef}
          label={`Actions for ${source.name}`}
          menuRef={menuRef}
          onClose={() => setOpen(false)}
        >
          <UiV2MenuItem icon="edit" onClick={() => {
            setOpen(false);
            onOpenDialog("details");
          }}>
            Rename and describe…
          </UiV2MenuItem>
          <UiV2MenuItem icon="layers" onClick={() => {
            setOpen(false);
            onOpenDialog("bases");
          }}>
            Manage bases…
          </UiV2MenuItem>
          {reprocessAvailable ? (
            <UiV2MenuItem icon="regenerate" onClick={() => {
              setOpen(false);
              onReprocess();
            }}>
              Reprocess
            </UiV2MenuItem>
          ) : null}
          <UiV2MenuSeparator />
          <UiV2MenuItem icon="trash" tone="destructive" onClick={() => {
            setOpen(false);
            onTrash();
          }}>
            Move to Trash
          </UiV2MenuItem>
        </UiV2ResponsiveMenu>
      ) : null}
    </span>
  );
}

function SourceDetailTask({
  busy,
  detail,
  notice,
  onDismissNotice,
  onRequestLifecycle,
  onRequestRemove,
  onRetry
}: {
  busy: boolean;
  detail: KnowledgeSourceDetailView;
  notice: KnowledgeLibraryNotice | null;
  onDismissNotice(): void;
  onRequestLifecycle(target: LifecycleTarget): void;
  onRequestRemove(target: RemoveTarget): void;
  onRetry(): void;
}) {
  const [dialog, setDialog] = useState<SourceDialogKind | null>(null);
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
  const currentVersion = source?.currentVersion ?? null;
  const sourceId = source?.id ?? null;
  const pageCount = Math.max(1, currentVersion?.pageCount ?? 1);
  const previewKey = `${source?.id ?? ""}:${currentVersion?.versionNumber ?? ""}:${currentVersion?.fileName ?? ""}`;
  const [preview, setPreview] = useState({ key: previewKey, page: 1, pageFailed: false });
  const [normalizedPreviewRetry, setNormalizedPreviewRetry] = useState(0);
  const [normalizedPreview, setNormalizedPreview] = useState<NormalizedPreviewState>({
    key: previewKey,
    status: "idle",
    value: null
  });
  const page = preview.key === previewKey ? preview.page : 1;
  const pageFailed = preview.key === previewKey ? preview.pageFailed : false;
  const needsNormalizedPreview = Boolean(
    source && currentVersion?.readiness.state === "ready" &&
    !isVisualPreviewFile(currentVersion.fileName)
  );
  const activeNormalizedPreview = normalizedPreview.key === previewKey
    ? normalizedPreview
    : { key: previewKey, status: "loading" as const, value: null };
  useEffect(() => {
    if (!sourceId || !needsNormalizedPreview) return;
    const controller = new AbortController();
    void loadKnowledgeSourceViewer(sourceId, controller.signal).then((value) => {
      if (!controller.signal.aborted) {
        setNormalizedPreview({ key: previewKey, status: "ready", value });
      }
    }).catch(() => {
      if (!controller.signal.aborted) {
        setNormalizedPreview({ key: previewKey, status: "error", value: null });
      }
    });
    return () => controller.abort();
  }, [needsNormalizedPreview, normalizedPreviewRetry, previewKey, sourceId]);
  const reprocessAvailable = Boolean(source?.canReprocess && (
    source.readiness.state === "needs_attention" || source.replacement.state === "needs_attention"
  ));
  const heading = (
    <SubviewHeading
      actions={source ? (
        <>
          {source.owned && !source.trashed && !source.deletionPending ? (
            <FilePickerLabel
              accept={KNOWLEDGE_UPLOAD_ACCEPT}
              busy={detail.actionId === "source:replace"}
              disabled={busy || source.replacement.state === "processing"}
              icon="attach"
              inputId="knowledge-source-replace"
              tone="primary"
              onFiles={(files) => {
                const file = files?.[0];
                if (file) detail.onReplace(file);
              }}
            >
              Replace file
            </FilePickerLabel>
          ) : null}
          {source.owned && !source.trashed && !source.deletionPending ? (
            <SourceActionsMenu
              busy={busy}
              onOpenDialog={setDialog}
              onReprocess={detail.onReprocess}
              onTrash={() => onRequestLifecycle({ action: "trash", kind: "source", name: source.name })}
              reprocessAvailable={reprocessAvailable}
              source={source}
            />
          ) : null}
        </>
      ) : undefined}
      meta={source?.trashed
        ? "In Trash · excluded from future chats"
        : source && currentVersion
          ? `${sourceStatus(source).label} · ${fileTypeLabel(currentVersion.fileName)} · ${formatBytes(currentVersion.byteSize)}${currentVersion.pageCount ? ` · ${currentVersion.pageCount} pages` : ""} · in ${source.membershipCount} ${source.membershipCount === 1 ? "base" : "bases"}`
          : "Waiting for a ready file"}
      title={source?.name ?? "Document"}
    />
  );
  if (detail.dataState === "loading") {
    return <>{heading}<TaskLoading label="Loading document…" /></>;
  }
  if (detail.dataState === "error" || !source) {
    return <>{heading}<TaskFailure error={detail.dataError} onRetry={onRetry} /></>;
  }
  const status = sourceStatus(source);
  const retryableVersionNumber = reprocessAvailable
    ? (source.versions.find((version) => version.isPending) ??
        source.versions.find((version) => version.isCurrent))?.versionNumber
    : undefined;
  const validSelectedBaseIds = selectedBaseIds.filter((id) =>
    source.eligibleBases.some((base) => base.id === id)
  );
  return (
    <>
      {heading}
      {notice ? <NoticeRow notice={notice} onDismiss={onDismissNotice} /> : null}
      {!source.owned ? (
        <Callout title="Read-only shared document">
          <p>Shared by {source.ownerDisplayName}. You can use it through the listed bases; only its owner can edit or move it.</p>
        </Callout>
      ) : null}

      <div className="v2-knowledge-doc-layout">
        <section aria-label="Document preview" className="v2-knowledge-doc-preview">
          <div className="v2-knowledge-doc-toolbar">
            {currentVersion?.fileName.toLocaleLowerCase().endsWith(".pdf") && currentVersion.pageCount ? (
              <label>
                <span>Page</span>
                <select
                  aria-label="Preview page"
                  className="v2-knowledge-input"
                  value={page}
                  onChange={(event) => {
                    setPreview({
                      key: previewKey,
                      page: Number(event.currentTarget.value),
                      pageFailed: false
                    });
                  }}
                >
                  {Array.from({ length: pageCount }, (_, index) => index + 1).map((value) => (
                    <option key={value} value={value}>{value}</option>
                  ))}
                </select>
                <span>of {pageCount}</span>
              </label>
            ) : <span>{currentVersion ? fileTypeLabel(currentVersion.fileName) : "Preview"}</span>}
            <div>
              {currentVersion?.fileName.toLocaleLowerCase().endsWith(".pdf") ? (
                <>
                  <UiV2Button
                    aria-label="Previous page"
                    disabled={page <= 1}
                    onClick={() => {
                      setPreview({ key: previewKey, page: Math.max(1, page - 1), pageFailed: false });
                    }}
                  >
                    Previous
                  </UiV2Button>
                  <UiV2Button
                    aria-label="Next page"
                    disabled={page >= pageCount}
                    onClick={() => {
                      setPreview({
                        key: previewKey,
                        page: Math.min(pageCount, page + 1),
                        pageFailed: false
                      });
                    }}
                  >
                    Next
                  </UiV2Button>
                </>
              ) : null}
              {currentVersion?.readiness.state === "ready" ? (
                <a
                  className="v2-button v2-focusable"
                  data-tone="ghost"
                  href={`${knowledgeSourceOriginalUrl(source.id)}${currentVersion.fileName.toLocaleLowerCase().endsWith(".pdf") ? `#page=${page}` : ""}`}
                  rel="noreferrer"
                  target="_blank"
                >
                  <UiV2Icon name="download" />
                  <span>Open original</span>
                </a>
              ) : null}
            </div>
          </div>
          <div className="v2-knowledge-doc-canvas">
            {currentVersion?.readiness.state === "ready" &&
            currentVersion.fileName.toLocaleLowerCase().endsWith(".pdf") && !pageFailed ? (
              // The authenticated same-app route renders one bounded page and keeps frame denial intact.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                alt={`${currentVersion.fileName}, page ${page}`}
                src={knowledgeSourcePageUrl(source.id, page)}
                onError={() => setPreview({ key: previewKey, page, pageFailed: true })}
              />
            ) : currentVersion?.readiness.state === "ready" &&
              /\.(?:gif|jpe?g|png|webp)$/iu.test(currentVersion.fileName) ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img alt={currentVersion.fileName} src={knowledgeSourceOriginalUrl(source.id)} />
            ) : needsNormalizedPreview && activeNormalizedPreview.status === "ready" &&
              activeNormalizedPreview.value?.blocks.length ? (
              <NormalizedDocumentPreview blocks={activeNormalizedPreview.value.blocks} />
            ) : needsNormalizedPreview &&
              (activeNormalizedPreview.status === "idle" || activeNormalizedPreview.status === "loading") ? (
              <div className="v2-knowledge-doc-preview-unavailable" role="status">
                <UiV2Icon name="file" />
                <strong>Preparing preview…</strong>
                <p>Loading the document&apos;s indexed text.</p>
              </div>
            ) : (
              <div className="v2-knowledge-doc-preview-unavailable" role="status">
                <UiV2Icon name="file" />
                <strong>{pageFailed ? "Page preview unavailable" : "Preview unavailable"}</strong>
                <p>{pageFailed
                  ? "Try another page or open the original in a new tab."
                  : needsNormalizedPreview
                    ? "The indexed text could not be loaded. The original is still available."
                    : "This document is not ready for preview yet."}</p>
                {needsNormalizedPreview ? (
                  <UiV2Button onClick={() => {
                    setNormalizedPreview({ key: previewKey, status: "loading", value: null });
                    setNormalizedPreviewRetry((attempt) => attempt + 1);
                  }}>
                    Retry preview
                  </UiV2Button>
                ) : null}
              </div>
            )}
          </div>
        </section>
        <aside className="v2-knowledge-doc-sidebar" aria-label="Document details">

      <section aria-labelledby="knowledge-source-overview-title" className="v2-knowledge-section">
        <div className="v2-knowledge-section-head">
          <div>
            <h3 id="knowledge-source-overview-title">Processing notes</h3>
          </div>
          <span className="v2-knowledge-status" data-tone={status.tone}>{status.label}</span>
        </div>
        {source.readiness.state === "needs_attention" &&
        source.replacement.state !== "needs_attention" ? (
          <Callout
            role="status"
            title={reprocessAvailable ? "Processing needs attention" : "Document unavailable"}
            tone="danger"
          >
            <p>
              {reprocessAvailable
                ? "Reprocess this document or replace the file with a corrected copy."
                : "Processing did not produce a usable document. You can replace the file."}
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
          <Callout
            role="status"
            title={reprocessAvailable ? "Replacement needs attention" : "Replacement unavailable"}
            tone={reprocessAvailable ? "danger" : "warn"}
          >
            <p>
              {reprocessAvailable
                ? "Reprocess the replacement or upload a different file. The current ready version is unchanged."
                : "The replacement could not be used. The current ready version is unchanged."}
              {source.replacement.supportReference
                ? ` Support reference ${source.replacement.supportReference}.`
                : ""}
            </p>
          </Callout>
        ) : null}
        {source.readiness.state === "ready" && source.readiness.warningCodes.length > 0 ? (
          <Callout role="status" title="Processing note">
            <p>{knowledgeProcessingNote(source.readiness.warningCodes)}</p>
          </Callout>
        ) : null}
        {source.owned && !source.trashed && !source.deletionPending && reprocessAvailable ? (
          <div className="v2-knowledge-actions">
            <UiV2Button
              busy={detail.actionId === "source:reprocess"}
              disabled={busy}
              icon="regenerate"
              onClick={detail.onReprocess}
            >
              Reprocess this document
            </UiV2Button>
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
          <dl className="v2-knowledge-dl">
            <div><dt>Added</dt><dd>{currentVersion ? formatDate(currentVersion.createdAt) : "Unavailable"}</dd></div>
            <div><dt>Updated</dt><dd>{formatDate(source.updatedAt)}</dd></div>
            <div><dt>Pages</dt><dd>{currentVersion?.pageCount ?? "Unavailable"}</dd></div>
            <div><dt>Used in</dt><dd>{source.membershipCount} {source.membershipCount === 1 ? "base" : "bases"}</dd></div>
            {!source.owned ? <div><dt>Owner</dt><dd>{source.ownerDisplayName}</dd></div> : null}
            {source.description ? <div><dt>Description</dt><dd className="v2-knowledge-prewrap">{source.description}</dd></div> : null}
          </dl>
          {source.tags.length > 0 ? (
            <div aria-label="Document tags" className="v2-knowledge-tags">
              {source.tags.map((tag) => <span className="v2-knowledge-tag" key={tag}>{tag}</span>)}
            </div>
          ) : null}
        </section>
      ) : null}

      {!source.trashed ? (
        <section aria-labelledby="knowledge-source-bases-title" className="v2-knowledge-section">
          <div className="v2-knowledge-section-head">
            <div>
              <h3 id="knowledge-source-bases-title">In bases</h3>
            </div>
          </div>
          {source.memberships.length === 0 ? (
            <p className="v2-knowledge-empty">Not currently used by a base.</p>
          ) : (
            <ul aria-label="Document base memberships" className="v2-knowledge-list">
              {source.memberships.map((base) => (
                <li className="v2-knowledge-row v2-knowledge-row-plain" key={base.id}>
                  <div className="v2-knowledge-row-main">
                    <span className="v2-knowledge-row-name">{base.name}</span>
                    <p className="v2-knowledge-meta">
                      {base.archived ? "Archived base" : "Available for future selection"}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <section aria-labelledby="knowledge-source-history-title" className="v2-knowledge-section">
        <details className="v2-knowledge-details">
          <summary className="v2-focusable" id="knowledge-source-history-title">
            <UiV2Icon name="chevron-right" />
            <span>History · {Math.max(0, source.versions.filter((version) => !version.isCurrent).length)} earlier {source.versions.filter((version) => !version.isCurrent).length === 1 ? "version" : "versions"}</span>
          </summary>
          <p className="v2-knowledge-details-note">
            Replacements create versions. Existing accepted chats keep the version they used.
          </p>
          <ul aria-label="Document versions" className="v2-knowledge-list">
            {source.versions.map((version) => {
              const versionStatus = version.readiness.state === "ready"
                ? "Ready"
                : version.readiness.state === "processing"
                  ? "Processing"
                  : version.versionNumber === retryableVersionNumber
                    ? "Needs attention"
                    : "Unavailable";
              return (
                <li className="v2-knowledge-row v2-knowledge-row-plain" key={version.versionNumber}>
                  <div className="v2-knowledge-row-main">
                    <span className="v2-knowledge-row-name">
                      {version.isCurrent ? "Current" : version.isPending ? "Replacement" : `Uploaded ${formatDate(version.createdAt)}`} · {version.fileName}
                    </span>
                    <p className="v2-knowledge-meta">{formatBytes(version.byteSize)} · uploaded {formatDate(version.createdAt)}</p>
                  </div>
                  <span className="v2-knowledge-status" data-tone="neutral">
                    {versionStatus}
                  </span>
                </li>
              );
            })}
          </ul>
        </details>
      </section>
        </aside>
      </div>
      {dialog === "details" ? (
        <KnowledgeDialog
          label="Edit document details"
          title="Rename and describe"
          onClose={() => {
            detail.onChange({
              description: source.description,
              name: source.name,
              tags: source.tags.join(", ")
            });
            setDialog(null);
          }}
        >
          <form
            className="v2-knowledge-form"
            onSubmit={(event) => {
              event.preventDefault();
              detail.onSave();
              setDialog(null);
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
              <UiV2Button disabled={busy} type="button" onClick={() => setDialog(null)}>Cancel</UiV2Button>
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
        </KnowledgeDialog>
      ) : null}
      {dialog === "bases" ? (
        <KnowledgeDialog label="Manage document bases" title="Manage bases" onClose={() => setDialog(null)}>
          <div className="v2-knowledge-membership-dialog">
            <section aria-labelledby="knowledge-current-bases">
              <h3 id="knowledge-current-bases">In bases</h3>
              {source.memberships.length ? (
                <ul aria-label="Current base memberships" className="v2-knowledge-list">
                  {source.memberships.map((base) => (
                    <li className="v2-knowledge-row v2-knowledge-row-plain" key={base.id}>
                      <span className="v2-knowledge-row-name">{base.name}</span>
                      <UiV2Button
                        busy={detail.actionId === `source:remove:${base.id}`}
                        disabled={busy}
                        tone="destructive"
                        onClick={() => {
                          setDialog(null);
                          onRequestRemove({
                            baseId: base.id,
                            baseName: base.name,
                            kind: "membership",
                            sourceId: source.id,
                            sourceName: source.name
                          });
                        }}
                      >
                        Remove
                      </UiV2Button>
                    </li>
                  ))}
                </ul>
              ) : <p className="v2-knowledge-empty">Not currently used by a base.</p>}
            </section>
            <fieldset className="v2-knowledge-fieldset">
              <legend>Add to bases</legend>
              <p>Reuse this document without uploading it again.</p>
              {source.eligibleBases.length ? (
                <>
                  <div className="v2-knowledge-checklist">
                    {source.eligibleBases.map((base) => (
                      <label key={base.id}>
                        <input
                          checked={validSelectedBaseIds.includes(base.id)}
                          disabled={busy}
                          type="checkbox"
                          onChange={(event) => {
                            const checked = event.currentTarget.checked;
                            setSelectedBaseIds((current) => checked
                              ? [...current, base.id]
                              : current.filter((id) => id !== base.id));
                          }}
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
                </>
              ) : <p className="v2-knowledge-empty">This document is already in every available base.</p>}
            </fieldset>
            {source.memberships.length > 0 && source.eligibleBases.length > 0 ? (
              <section aria-labelledby="knowledge-move-document" className="v2-knowledge-fieldset">
                <h3 id="knowledge-move-document">Move document</h3>
                <p>Move removes one base membership and adds another.</p>
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
                  Move document
                </UiV2Button>
              </section>
            ) : null}
          </div>
        </KnowledgeDialog>
      ) : null}
    </>
  );
}
