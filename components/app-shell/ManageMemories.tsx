import {
  applyMemorySearch,
  beginCreateMemory,
  beginDeleteExplicitMemories,
  beginEditMemory,
  beginMoveMemory,
  cancelMemoryDraft,
  clearMemorySearch,
  changeMemoryFactState,
  confirmDeleteExplicitMemories,
  discardMemoryManagerDraft,
  forgetCurrentMemory,
  loadMoreMemoryEvidence,
  memoryDraftIsValid,
  openMemoryDetail,
  openMemoryManager,
  moveMemoryScope,
  refreshMemoryDeletionStatus,
  refreshMemoryList,
  resolveMemoryConflictChoice,
  resolveMemoryConflictCorrection,
  saveMemoryChanges,
  saveNewMemory,
  showMemoryList,
  submitMemoryFeedback,
  toggleMemoryPinned,
  undoLastMemoryFeedback,
  undoLastForgottenMemory,
  useMemoryManagerStore,
  type MemoryManagerScreen
} from "@/components/app-shell/memoryManagerStore";
import { useWorkspaceStore, workspaceNavigationChats } from "@/components/app-shell/workspaceStore";
import { fetchAssistantList } from "@/components/assistants/assistantsApi";
import { listArchivedChats } from "@/components/app-shell/chatLifecycleApi";
import {
  memoryFactStateLabel,
  memoryModalityLabel,
  memorySensitivityLabel,
  memoryUiCopy
} from "@/components/app-shell/memoryUiCopy";
import { MemoryHistorySearch } from "@/components/app-shell/MemoryHistorySearch";
import { memoryHistoryUiCopy } from "@/components/app-shell/memoryHistoryUiCopy";
import {
  MEMORY_FEEDBACK_COMMENT_MAX_LENGTH,
  MEMORY_MODALITIES,
  MEMORY_QUERY_MAX_LENGTH,
  MEMORY_STATEMENT_MAX_LENGTH,
  type MemoryDeletionStatus,
  type MemoryEvidenceItem,
  type MemorySummary,
  type MemoryScopeSelection,
  type MemoryUiLocale
} from "@/lib/contracts/memory";
import { resolveMemoryCopy } from "@/lib/contracts/memoryCopy";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  FileClock,
  FolderInput,
  History,
  Pin,
  PinOff,
  Plus,
  RotateCw,
  Search,
  Trash2,
  Undo2,
  X
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode
} from "react";

const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-overlay-surface";
const coarsePointerTarget =
  "[@media(hover:none)]:!min-h-touch [@media(pointer:coarse)]:!min-h-touch";
const secondaryButton =
  `inline-flex min-h-touch items-center justify-center gap-2 rounded-control border border-trace-subtle bg-control-surface px-3 text-sm font-semibold text-ink-secondary hover:bg-control-hover hover:text-ink disabled:cursor-not-allowed disabled:text-ink-disabled disabled:opacity-60 sm:min-h-control ${coarsePointerTarget} ${focusRing}`;
const quietButton =
  `inline-flex min-h-touch items-center justify-center gap-2 rounded-control px-3 text-sm font-semibold text-ink-secondary hover:bg-control-hover hover:text-ink disabled:cursor-not-allowed disabled:text-ink-disabled disabled:opacity-60 sm:min-h-control ${coarsePointerTarget} ${focusRing}`;
const primaryButton =
  `inline-flex min-h-touch items-center justify-center gap-2 rounded-control bg-proof px-4 text-sm font-semibold text-proof-contrast hover:bg-proof-hover disabled:cursor-not-allowed disabled:bg-control-surface disabled:text-ink-disabled sm:min-h-control ${coarsePointerTarget} ${focusRing}`;
const destructiveButton =
  `inline-flex min-h-touch items-center justify-center gap-2 rounded-control bg-critical px-4 text-sm font-semibold text-proof-contrast hover:bg-critical/90 disabled:cursor-not-allowed disabled:opacity-60 sm:min-h-control ${coarsePointerTarget} ${focusRing}`;

function t(locale: MemoryUiLocale, key: Parameters<typeof memoryUiCopy>[1]): string {
  return memoryUiCopy(locale, key);
}

function formatDate(locale: MemoryUiLocale, value: string | null): string {
  if (!value) return t(locale, "manager.never");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t(locale, "manager.notSet");
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function indexingLabel(locale: MemoryUiLocale, value: MemorySummary["indexingState"]): string {
  const labels = {
    DEGRADED: "Fallback search only",
    HYBRID_READY: "Lexical and vector search ready",
    LEXICAL_READY: "Lexical search ready",
    VECTOR_PENDING: "Lexical search ready; vector pending"
  } as const;
  return labels[value];
}

function versionStateLabel(
  locale: MemoryUiLocale,
  value: "ACTIVE" | "CONFLICTING" | "ORPHANED" | "SUPERSEDED" | "EXPIRED" | "RETRACTED" | "FORGOTTEN"
): string {
  const labels = {
    ACTIVE: "Current",
    CONFLICTING: "Conflicting",
    EXPIRED: "Expired",
    FORGOTTEN: "Forgotten",
    ORPHANED: "Source unavailable",
    RETRACTED: "Retracted",
    SUPERSEDED: "Superseded"
  } as const;
  return labels[value];
}

function feedbackTypeLabel(
  locale: MemoryUiLocale,
  value: "CORRECT" | "INCORRECT" | "NOT_USEFUL" | "WRONG_SCOPE" | "OUTDATED" | "TOO_SENSITIVE"
): string {
  const labels = {
    CORRECT: "Correct",
    INCORRECT: "Incorrect",
    NOT_USEFUL: "Not useful",
    OUTDATED: "Outdated",
    TOO_SENSITIVE: "Too sensitive",
    WRONG_SCOPE: "Wrong scope"
  } as const;
  return labels[value];
}

function lifecycleOperationLabel(locale: MemoryUiLocale, value: string): string {
  const labels: Readonly<Record<string, string>> = {
    AUTO_PROPOSE: "Automatic proposal",
    CONFLICT: "Conflict detected",
    EDIT: "User correction",
    EXPIRE: "Expired",
    EXPLICIT_SAVE: "Explicit save",
    FORGET: "Forgotten",
    INDEX_SWITCH: "Index switched",
    PIN: "Pinned",
    PROMOTE: "Promoted",
    REBUILD: "Rebuilt",
    REINFORCE: "Evidence reinforced",
    RETRACT: "Retracted",
    SCOPE_CHANGE: "Scope changed",
    SOURCE_INVALIDATE: "Source invalidated",
    SUPERSEDE: "Superseded",
    UNPIN: "Unpinned",
    USER_FEEDBACK: "Private feedback"
  };
  return labels[value] ?? value;
}

function scopeLabel(locale: MemoryUiLocale, scope: MemoryScopeSelection): string {
  if (scope.type === "GLOBAL_USER") return t(locale, "manager.global");
  const labels = { ASSISTANT: "Assistant", CHAT: "Chat", FOLDER: "Folder" } as const;
  return `${labels[scope.type]} · ${scope.targetId}`;
}

function mutationErrorText(locale: MemoryUiLocale, code: string | null): string | null {
  if (!code) return null;
  if (code === "memory_secret_rejected") return t(locale, "manager.secretRejected");
  if (code === "memory_version_stale") return t(locale, "manager.draftStale");
  return t(locale, "manager.mutationError");
}

function ScreenBack({ locale, onClick }: { locale: MemoryUiLocale; onClick(): void }) {
  return (
    <button className={`${quietButton} -ml-2 md:hidden`} onClick={onClick} type="button">
      <ArrowLeft className="size-4" aria-hidden="true" />
      {t(locale, "manager.backToList")}
    </button>
  );
}

function LiveNotice({ locale }: { locale: MemoryUiLocale }) {
  const notice = useMemoryManagerStore((state) => state.notice);
  const lastFeedbackUndo = useMemoryManagerStore((state) => state.lastFeedbackUndo);
  const lastForgetUndo = useMemoryManagerStore((state) => state.lastForgetUndo);
  const mutationState = useMemoryManagerStore((state) => state.mutationState);
  const [expiredForgetDeletionId, setExpiredForgetDeletionId] = useState<string | null>(null);
  useEffect(() => {
    if (notice !== "forgotten" || !lastForgetUndo) return;
    const remaining = Date.parse(lastForgetUndo.undo.expiresAt) - Date.now();
    const delay = Number.isFinite(remaining)
      ? Math.min(Math.max(remaining, 0), 2_147_483_647)
      : 0;
    const deletionId = lastForgetUndo.undo.deletionId;
    const timer = window.setTimeout(() => setExpiredForgetDeletionId(deletionId), delay);
    return () => window.clearTimeout(timer);
  }, [lastForgetUndo, notice]);
  const forgetUndoAvailable = Boolean(
    notice === "forgotten" &&
    lastForgetUndo &&
    expiredForgetDeletionId !== lastForgetUndo.undo.deletionId
  );
  if (!notice) return <div className="sr-only" aria-live="polite" />;
  const text = notice === "forgotten"
    ? t(locale, "manager.forgotten")
    : notice === "forget_restored"
      ? t(locale, "manager.forgetRestored")
    : notice === "saved_use_off"
      ? t(locale, "manager.savedUseOff")
      : notice === "feedback_recorded"
        ? t(locale, "manager.feedbackRecorded")
        : notice === "feedback_retracted"
          ? t(locale, "manager.feedbackRetracted")
          : notice === "resolved"
            ? t(locale, "manager.resolved")
            : t(locale, "manager.saved");
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-y border-positive/30 bg-positive/10 px-3 py-2 text-sm leading-5 text-ink-secondary"
      role="status"
    >
      <Check className="mt-0.5 size-4 shrink-0 text-positive" aria-hidden="true" />
      <span className="min-w-0 flex-1">{text}</span>
      {notice === "feedback_recorded" && lastFeedbackUndo ? (
        <button
          className={`inline-flex min-h-control items-center gap-1.5 rounded-control px-2 font-semibold text-proof hover:bg-positive/15 disabled:opacity-60 ${focusRing}`}
          disabled={mutationState !== null}
          type="button"
          onClick={() => void undoLastMemoryFeedback().catch(() => undefined)}
        >
          <Undo2 className="size-3.5" aria-hidden="true" />
          {t(locale, "manager.undo")}
        </button>
      ) : null}
      {notice === "forgotten" && forgetUndoAvailable ? (
        <button
          className={`inline-flex min-h-control items-center gap-1.5 rounded-control px-2 font-semibold text-proof hover:bg-positive/15 disabled:opacity-60 ${focusRing}`}
          disabled={mutationState !== null}
          type="button"
          onClick={() => void undoLastForgottenMemory().catch(() => undefined)}
        >
          <Undo2 className="size-3.5" aria-hidden="true" />
          {t(locale, "manager.undo")}
        </button>
      ) : null}
    </div>
  );
}

const MANAGE_MEMORY_STATES = [
  "ACTIVE",
  "CONFLICTED",
  "ORPHANED",
  "EXPIRED",
  "RETRACTED"
] as const;

type ScopeTargetOption = Readonly<{
  archived?: boolean;
  id: string;
  label: string;
  type: Exclude<MemoryScopeSelection["type"], "GLOBAL_USER">;
}>;

function encodedScope(scope: MemoryScopeSelection): string {
  return scope.type === "GLOBAL_USER" ? "GLOBAL_USER" : `${scope.type}:${scope.targetId}`;
}

function decodedScope(value: string): MemoryScopeSelection | null {
  if (value === "GLOBAL_USER") return { type: "GLOBAL_USER" };
  const separator = value.indexOf(":");
  const type = value.slice(0, separator);
  const targetId = value.slice(separator + 1);
  return separator > 0 && targetId && ["FOLDER", "ASSISTANT", "CHAT"].includes(type)
    ? { targetId, type: type as "FOLDER" | "ASSISTANT" | "CHAT" }
    : null;
}

function MemoryScopePicker({
  id,
  locale,
  onChange,
  value
}: {
  id: string;
  locale: MemoryUiLocale;
  onChange(scope: MemoryScopeSelection): void;
  value: MemoryScopeSelection;
}) {
  const folders = useWorkspaceStore((state) => state.folders);
  const workspaceChats = useWorkspaceStore((state) => state.chats);
  const chats = useMemo(() => workspaceNavigationChats(workspaceChats), [workspaceChats]);
  const [remoteTargets, setRemoteTargets] = useState<ScopeTargetOption[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    async function loadTargets(): Promise<void> {
      const archivedPromise = (async (): Promise<ScopeTargetOption[]> => {
        const options: ScopeTargetOption[] = [];
        let cursor: string | null = null;
        let pages = 0;
        do {
          const page = await listArchivedChats(cursor);
          options.push(...page.chats.map((chat) => ({
            archived: true,
            id: chat.id,
            label: chat.title,
            type: "CHAT" as const
          })));
          cursor = page.nextCursor;
          pages += 1;
        } while (cursor && pages < 25);
        return options;
      })().catch(() => []);
      const [assistants, archivedTargets] = await Promise.all([
        fetchAssistantList(),
        archivedPromise
      ]);
      const options = [...archivedTargets];
      if (assistants.ok) {
        options.push(...assistants.data.assistants
          .filter((assistant) => assistant.owned && !assistant.archived)
          .map((assistant) => ({ id: assistant.id, label: assistant.name, type: "ASSISTANT" as const })));
      }
      if (active) setRemoteTargets(options);
    }
    void loadTargets().catch(() => undefined).finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, []);

  const targets = useMemo<ScopeTargetOption[]>(() => [
    ...folders.map((folder) => ({ id: folder.id, label: folder.name, type: "FOLDER" as const })),
    ...chats.map((chat) => ({ id: chat.id, label: chat.title, type: "CHAT" as const })),
    ...remoteTargets
  ].filter((target, index, all) =>
    all.findIndex((candidate) => candidate.type === target.type && candidate.id === target.id) === index
  ), [chats, folders, remoteTargets]);
  const current = encodedScope(value);
  const currentAvailable = value.type === "GLOBAL_USER" || targets.some(
    (target) => encodedScope({ targetId: target.id, type: target.type }) === current
  );

  return (
    <div>
      <label className="text-sm font-semibold text-ink" htmlFor={id}>
        {t(locale, "manager.scope")}
      </label>
      <select
        className={`mt-2 min-h-control w-full rounded-control border border-trace-subtle bg-control-surface px-3 text-sm text-ink ${coarsePointerTarget} ${focusRing}`}
        id={id}
        value={current}
        onChange={(event) => {
          const scope = decodedScope(event.target.value);
          if (scope) onChange(scope);
        }}
      >
        <option value="GLOBAL_USER">{t(locale, "manager.global")}</option>
        {!currentAvailable ? (
          <option value={current} disabled>Source or scope unavailable</option>
        ) : null}
        {folders.length ? (
          <optgroup label="Folders">
            {targets.filter((target) => target.type === "FOLDER").map((target) => (
              <option key={`folder:${target.id}`} value={encodedScope({ targetId: target.id, type: "FOLDER" })}>{target.label}</option>
            ))}
          </optgroup>
        ) : null}
        {targets.some((target) => target.type === "ASSISTANT") ? (
          <optgroup label="Assistants">
            {targets.filter((target) => target.type === "ASSISTANT").map((target) => (
              <option key={`assistant:${target.id}`} value={encodedScope({ targetId: target.id, type: "ASSISTANT" })}>{target.label}</option>
            ))}
          </optgroup>
        ) : null}
        {targets.some((target) => target.type === "CHAT") ? (
          <optgroup label="Chats">
            {targets.filter((target) => target.type === "CHAT").map((target) => (
              <option key={`chat:${target.id}`} value={encodedScope({ targetId: target.id, type: "CHAT" })}>
                {target.label}{target.archived ? " (archived)" : ""}
              </option>
            ))}
          </optgroup>
        ) : null}
      </select>
      <p className="mt-1 text-xs leading-5 text-ink-muted">
        {loading
          ? "Loading available scopes…"
          : "Scope controls where this memory is available."}
      </p>
    </div>
  );
}

function MemoryListPane({ locale }: { locale: MemoryUiLocale }) {
  const deletionStatus = useMemoryManagerStore((state) => state.deletionStatus);
  const factStateFilter = useMemoryManagerStore((state) => state.factStateFilter);
  const listError = useMemoryManagerStore((state) => state.listError);
  const listLoadState = useMemoryManagerStore((state) => state.listLoadState);
  const memories = useMemoryManagerStore((state) => state.memories);
  const nextCursor = useMemoryManagerStore((state) => state.nextCursor);
  const queryApplied = useMemoryManagerStore((state) => state.queryApplied);
  const queryInput = useMemoryManagerStore((state) => state.queryInput);
  const setQueryInput = useMemoryManagerStore((state) => state.setQueryInput);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void applyMemorySearch().catch(() => undefined);
  };

  return (
    <div className="min-w-0 md:border-r md:border-trace-subtle" data-testid="memory-list-pane">
      <form className="border-b border-trace-subtle p-3" onSubmit={submit} role="search">
        <label className="text-xs font-semibold text-ink-secondary" htmlFor="memory-search-input">
          {t(locale, "manager.searchLabel")}
        </label>
        <div className="mt-2 flex min-w-0 gap-2">
          <div className="relative min-w-0 flex-1">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-muted"
              aria-hidden="true"
            />
            <input
              className={`min-h-control w-full rounded-control border border-trace-subtle bg-control-surface py-2 pl-9 pr-9 text-sm text-ink placeholder:text-ink-disabled ${coarsePointerTarget} ${focusRing}`}
              id="memory-search-input"
              maxLength={MEMORY_QUERY_MAX_LENGTH}
              placeholder={t(locale, "manager.searchPlaceholder")}
              type="search"
              value={queryInput}
              onChange={(event) => setQueryInput(event.target.value)}
            />
            {queryInput ? (
              <button
                className={`absolute right-1 top-1/2 grid size-9 -translate-y-1/2 place-items-center rounded-control text-ink-muted hover:bg-control-hover hover:text-ink ${focusRing}`}
                type="button"
                aria-label={t(locale, "manager.clearSearch")}
                onClick={() => void clearMemorySearch().catch(() => undefined)}
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            ) : null}
          </div>
          <button className={secondaryButton} disabled={!queryInput.trim()} type="submit">
            {t(locale, "manager.searchAction")}
          </button>
        </div>
      </form>

      <div className="flex gap-1 overflow-x-auto border-b border-trace-subtle px-3 py-2" role="group" aria-label="Memory state">
        {MANAGE_MEMORY_STATES.map((state) => (
          <button
            className={`min-h-control shrink-0 rounded-control px-3 text-xs font-semibold ${
              factStateFilter === state
                ? "bg-control-selected text-proof"
                : "text-ink-secondary hover:bg-control-hover hover:text-ink"
            } ${focusRing}`}
            key={state}
            type="button"
            aria-pressed={factStateFilter === state}
            onClick={() => void changeMemoryFactState(state).catch(() => undefined)}
          >
            {memoryFactStateLabel(locale, state)}
          </button>
        ))}
      </div>

      <div aria-live="polite" aria-busy={listLoadState === "loading"}>
        {listLoadState === "loading" && memories.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-ink-muted">{t(locale, "manager.loading")}</p>
        ) : null}
        {listError && memories.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <p className="text-sm text-critical" role="alert">{t(locale, "manager.loadError")}</p>
            <button
              className={`${secondaryButton} mt-3`}
              type="button"
              onClick={() => void refreshMemoryList().catch(() => undefined)}
            >
              <RotateCw className="size-4" aria-hidden="true" />
              {t(locale, "manager.retry")}
            </button>
          </div>
        ) : null}
        {listLoadState !== "loading" && !listError && memories.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-ink-muted">
            {queryApplied ? t(locale, "manager.noResults") : t(locale, "manager.empty")}
          </p>
        ) : null}
        {memories.length > 0 ? (
          <ul className="divide-y divide-trace-subtle" aria-label={t(locale, "manager.title")}>
            {memories.map((memory) => (
              <li key={memory.id}>
                <button
                  className={`group flex min-h-touch w-full items-start gap-3 px-3 py-3 text-left hover:bg-control-hover ${focusRing}`}
                  type="button"
                  onClick={() => void openMemoryDetail(memory.id).catch(() => undefined)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      {memory.pinned ? <Pin className="size-3.5 shrink-0 text-proof" aria-label={t(locale, "manager.pinned")} /> : null}
                      <span className="line-clamp-3 whitespace-pre-wrap text-sm font-medium leading-5 text-ink">
                        {memory.displayText ?? t(locale, "manager.notSet")}
                      </span>
                    </span>
                    <span className="mt-1.5 flex flex-wrap gap-x-2 gap-y-1 text-xs text-ink-muted">
                      <span>{memoryFactStateLabel(locale, memory.factState)}</span>
                      <span aria-hidden="true">·</span>
                      <span>{memory.sourceMode === "AUTOMATIC" ? t(locale, "manager.automatic") : t(locale, "manager.explicit")}</span>
                      <span aria-hidden="true">·</span>
                      <span>{memoryModalityLabel(locale, memory.modality)}</span>
                      {(memory.deferredCandidateCount ?? 0) > 0 ? (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>{memory.deferredCandidateCount} {t(locale, "manager.deferred")}</span>
                        </>
                      ) : null}
                      <span aria-hidden="true">·</span>
                      <span>{formatDate(locale, memory.updatedAt)}</span>
                    </span>
                  </span>
                  <ChevronRight className="mt-1 size-4 shrink-0 text-ink-muted group-hover:text-ink" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {nextCursor ? (
          <div className="border-t border-trace-subtle p-3 text-center">
            <button
              className={secondaryButton}
              disabled={listLoadState === "loading"}
              type="button"
              onClick={() => void refreshMemoryList({ append: true }).catch(() => undefined)}
            >
              {listLoadState === "loading" ? t(locale, "manager.loadingMore") : t(locale, "manager.loadMore")}
            </button>
          </div>
        ) : null}
      </div>

      <div className="border-t border-trace-subtle px-3 py-4">
        {deletionStatus ? (
          <button
            className={`mb-3 flex min-h-touch w-full items-center justify-between gap-3 rounded-control px-2 text-left text-sm text-ink-secondary hover:bg-control-hover ${focusRing}`}
            type="button"
            onClick={beginDeleteExplicitMemories}
          >
            <span className="inline-flex items-center gap-2">
              <FileClock className="size-4 text-caution" aria-hidden="true" />
              {t(locale, "manager.deleteProgress")}
            </span>
            <span className="font-mono text-xs text-ink-muted">{deletionStatus.state}</span>
          </button>
        ) : null}
        <h4 className="text-sm font-semibold text-ink">{t(locale, "manager.deleteHeading")}</h4>
        <p className="mt-1 text-xs leading-5 text-ink-muted">{t(locale, "manager.deleteDescription")}</p>
        <button
          className={`mt-2 inline-flex min-h-touch items-center gap-2 rounded-control px-2 text-sm font-semibold text-critical hover:bg-critical/10 sm:min-h-control ${coarsePointerTarget} ${focusRing}`}
          type="button"
          onClick={beginDeleteExplicitMemories}
        >
          <Trash2 className="size-4" aria-hidden="true" />
          {resolveMemoryCopy(locale, "bulkDelete.explicit.action")}
        </button>
      </div>
    </div>
  );
}

function MetadataRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-2 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-3">
      <dt className="text-xs font-medium text-ink-muted">{label}</dt>
      <dd className="min-w-0 break-words text-sm text-ink-secondary">{children}</dd>
    </div>
  );
}

function EvidenceItem({ item, locale }: { item: MemoryEvidenceItem; locale: MemoryUiLocale }) {
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className={item.stance === "SUPPORTS" ? "font-semibold text-positive" : "font-semibold text-caution"}>
          {item.stance === "SUPPORTS" ? t(locale, "manager.supports") : t(locale, "manager.contradicts")}
        </span>
        <span className="text-ink-muted">
          {item.sourceType === "MESSAGE"
            ? t(locale, "manager.evidenceMessage")
            : item.sourceType === "EPISODE"
              ? t(locale, "manager.evidenceEpisode")
              : t(locale, "manager.evidenceAction")}
        </span>
        <span className="text-ink-muted">· {formatDate(locale, item.observedAt)}</span>
      </div>
      <p className="mt-1.5 whitespace-pre-wrap text-sm leading-6 text-ink">{item.safeExcerpt}</p>
      <p className="mt-1 break-all font-mono text-metadata text-ink-muted" title={item.factVersionId}>
        {t(locale, "manager.currentVersion")}: {item.factVersionId}
      </p>
    </li>
  );
}

function MemoryEvidence({ locale, memory }: { locale: MemoryUiLocale; memory: MemorySummary }) {
  const evidence = useMemoryManagerStore((state) => state.evidence);
  const evidenceError = useMemoryManagerStore((state) => state.evidenceError);
  const evidenceLoadState = useMemoryManagerStore((state) => state.evidenceLoadState);
  const nextCursor = useMemoryManagerStore((state) => state.evidenceNextCursor);
  return (
    <section className="mt-6 border-t border-trace-subtle pt-5" aria-labelledby="memory-evidence-heading">
      <h4 className="text-sm font-semibold text-ink" id="memory-evidence-heading">
        {t(locale, "manager.evidenceHeading")}
      </h4>
      <p className="mt-1 text-xs leading-5 text-ink-muted">{t(locale, "manager.evidenceDescription")}</p>
      <div className="mt-3" aria-live="polite" aria-busy={evidenceLoadState === "loading"}>
        {evidenceLoadState === "loading" && evidence.length === 0 ? (
          <p className="py-3 text-sm text-ink-muted">{t(locale, "manager.evidenceLoading")}</p>
        ) : null}
        {evidenceError && evidence.length === 0 ? (
          <div className="py-3">
            <p className="text-sm text-critical" role="alert">{t(locale, "manager.evidenceError")}</p>
            <button
              className={`${secondaryButton} mt-2`}
              type="button"
              onClick={() => void openMemoryDetail(memory.id).catch(() => undefined)}
            >
              <RotateCw className="size-4" aria-hidden="true" />
              {t(locale, "manager.retry")}
            </button>
          </div>
        ) : null}
        {evidenceLoadState === "ready" && evidence.length === 0 ? (
          <p className="py-3 text-sm text-ink-muted">{t(locale, "manager.evidenceEmpty")}</p>
        ) : null}
        {evidence.length > 0 ? (
          <ul className="divide-y divide-trace-subtle border-y border-trace-subtle">
            {evidence.map((item) => <EvidenceItem item={item} key={item.id} locale={locale} />)}
          </ul>
        ) : null}
        {nextCursor ? (
          <button
            className={`${secondaryButton} mt-3`}
            disabled={evidenceLoadState === "loading"}
            type="button"
            onClick={() => void loadMoreMemoryEvidence().catch(() => undefined)}
          >
            {t(locale, "manager.evidenceMore")}
          </button>
        ) : null}
      </div>
    </section>
  );
}

function FeedbackActionButtons({
  comment,
  locale,
  onCommitted,
  versionId
}: {
  comment?: string;
  locale: MemoryUiLocale;
  onCommitted?(): void;
  versionId: string;
}) {
  const mutationState = useMemoryManagerStore((state) => state.mutationState);
  const record = (feedbackType: "INCORRECT" | "NOT_USEFUL") => {
    void submitMemoryFeedback(versionId, feedbackType, comment)
      .then(() => onCommitted?.())
      .catch(() => undefined);
  };
  return (
    <div className="flex flex-wrap gap-2">
      <button
        className={secondaryButton}
        disabled={mutationState !== null}
        type="button"
        onClick={() => record("INCORRECT")}
      >
        {t(locale, "manager.feedbackIncorrect")}
      </button>
      <button
        className={quietButton}
        disabled={mutationState !== null}
        type="button"
        onClick={() => record("NOT_USEFUL")}
      >
        {t(locale, "manager.feedbackNotUseful")}
      </button>
    </div>
  );
}

function MemoryFeedbackPanel({ locale, versionId }: {
  locale: MemoryUiLocale;
  versionId: string;
}) {
  const [comment, setComment] = useState("");
  return (
    <section className="mt-6 border-t border-trace-subtle pt-5" aria-labelledby="memory-feedback-heading">
      <h4 className="text-sm font-semibold text-ink" id="memory-feedback-heading">
        {t(locale, "manager.feedbackHeading")}
      </h4>
      <p className="mt-1 max-w-2xl text-xs leading-5 text-ink-muted">
        {t(locale, "manager.feedbackDescription")}
      </p>
      <div className="mt-3 max-w-2xl">
        <label className="text-xs font-semibold text-ink-secondary" htmlFor="memory-feedback-comment">
          {t(locale, "manager.feedbackComment")}
        </label>
        <textarea
          className={`mt-2 min-h-20 w-full resize-y rounded-control border border-trace-subtle bg-control-surface px-3 py-2 text-sm leading-5 text-ink ${focusRing}`}
          id="memory-feedback-comment"
          maxLength={MEMORY_FEEDBACK_COMMENT_MAX_LENGTH}
          value={comment}
          aria-describedby="memory-feedback-comment-help memory-feedback-comment-count"
          onChange={(event) => setComment(event.target.value)}
        />
        <div className="mt-1 flex items-start justify-between gap-3 text-xs leading-5 text-ink-muted">
          <p id="memory-feedback-comment-help">{t(locale, "manager.feedbackCommentHelp")}</p>
          <span className="shrink-0 font-mono" id="memory-feedback-comment-count">
            {comment.length}/{MEMORY_FEEDBACK_COMMENT_MAX_LENGTH}
          </span>
        </div>
        <div className="mt-3">
          <FeedbackActionButtons
            comment={comment}
            locale={locale}
            onCommitted={() => setComment("")}
            versionId={versionId}
          />
        </div>
      </div>
    </section>
  );
}

function MemoryFeedbackHistory({ locale }: { locale: MemoryUiLocale }) {
  const feedback = useMemoryManagerStore((state) => state.feedback);
  if (feedback.length === 0) return null;
  return (
    <section className="mt-6 border-t border-trace-subtle pt-5" aria-labelledby="memory-feedback-history-heading">
      <h4 className="text-sm font-semibold text-ink" id="memory-feedback-history-heading">
        Private feedback
      </h4>
      <ul className="mt-3 divide-y divide-trace-subtle border-y border-trace-subtle">
        {feedback.map((item) => (
          <li className="py-3" key={item.id}>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              <span className="font-semibold text-ink-secondary">
                {feedbackTypeLabel(locale, item.feedbackType)}
              </span>
              <span className="text-ink-muted">· {formatDate(locale, item.createdAt)}</span>
              {item.retractedAt ? (
                <span className="font-semibold text-caution">· {t(locale, "manager.feedbackUndone")}</span>
              ) : null}
            </div>
            {item.comment ? (
              <p className="mt-1.5 whitespace-pre-wrap text-sm leading-5 text-ink-secondary">{item.comment}</p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ConflictReview({ locale, memory }: {
  locale: MemoryUiLocale;
  memory: MemorySummary;
}) {
  const mutationState = useMemoryManagerStore((state) => state.mutationState);
  const versions = useMemoryManagerStore((state) => state.versions)
    .filter(({ state }) => state === "CONFLICTING");
  const [correction, setCorrection] = useState("");
  const correctionValid = correction.trim().length > 0 &&
    correction.length <= MEMORY_STATEMENT_MAX_LENGTH;
  return (
    <section
      className="mt-5 border-y border-caution/40 bg-caution/5 py-4"
      aria-labelledby="memory-conflict-heading"
    >
      <div className="px-3">
        <h4 className="text-sm font-semibold text-ink" id="memory-conflict-heading">
          {t(locale, "manager.conflictHeading")}
        </h4>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-ink-secondary">
          {t(locale, "manager.conflictDescription")}
        </p>
      </div>
      <ul className="mt-3 divide-y divide-caution/25 border-y border-caution/25">
        {versions.map((version) => (
          <li className="px-3 py-4" key={version.id}>
            <p className="whitespace-pre-wrap text-sm font-medium leading-6 text-ink">
              {version.displayText ?? t(locale, "manager.notSet")}
            </p>
            <p className="mt-1 text-xs leading-5 text-ink-muted">
              {version.sourceMode === "AUTOMATIC" ? t(locale, "manager.automatic") : t(locale, "manager.explicit")}
              {` · ${version.sourceCount} ${t(locale, "manager.sources")} · ${formatDate(locale, version.systemFrom)}`}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                className={secondaryButton}
                disabled={mutationState !== null}
                type="button"
                onClick={() => void resolveMemoryConflictChoice(version.id).catch(() => undefined)}
              >
                {t(locale, "manager.conflictChoose")}
              </button>
              {version.sourceMode === "AUTOMATIC" ? (
                <FeedbackActionButtons locale={locale} versionId={version.id} />
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      <form
        className="px-3 pt-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (correctionValid) {
            void resolveMemoryConflictCorrection(correction).catch(() => undefined);
          }
        }}
      >
        <label className="text-sm font-semibold text-ink" htmlFor="memory-conflict-correction">
          {t(locale, "manager.conflictCorrection")}
        </label>
        <textarea
          className={`mt-2 min-h-24 w-full max-w-2xl resize-y rounded-control border border-trace-subtle bg-control-surface px-3 py-2 text-sm leading-6 text-ink ${focusRing}`}
          id="memory-conflict-correction"
          maxLength={MEMORY_STATEMENT_MAX_LENGTH}
          value={correction}
          aria-describedby="memory-conflict-correction-help"
          onChange={(event) => setCorrection(event.target.value)}
        />
        <p className="mt-1 text-xs leading-5 text-ink-muted" id="memory-conflict-correction-help">
          {t(locale, "manager.conflictCorrectionHelp")}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            className={primaryButton}
            disabled={mutationState !== null || !correctionValid}
            type="submit"
          >
            {mutationState === "resolving"
              ? t(locale, "manager.conflictResolving")
              : t(locale, "manager.conflictResolve")}
          </button>
          <button className={secondaryButton} disabled={mutationState !== null} onClick={showMemoryList} type="button">
            {t(locale, "manager.keepUnresolved")}
          </button>
          <button
            className={`inline-flex min-h-touch items-center gap-2 rounded-control px-3 text-sm font-semibold text-critical hover:bg-critical/10 disabled:opacity-60 sm:min-h-control ${coarsePointerTarget} ${focusRing}`}
            disabled={mutationState !== null}
            onClick={() => void forgetCurrentMemory().catch(() => undefined)}
            type="button"
          >
            <Trash2 className="size-4" aria-hidden="true" />
            {mutationState === "forgetting"
              ? t(locale, "manager.forgetting")
              : resolveMemoryCopy(locale, "forget.action")}
          </button>
        </div>
      </form>
    </section>
  );
}

function MemoryLifecycle({ locale }: { locale: MemoryUiLocale }) {
  const history = useMemoryManagerStore((state) => state.history);
  const versions = useMemoryManagerStore((state) => state.versions);
  if (history.length === 0 && versions.length === 0) return null;
  return (
    <section className="mt-6 border-t border-trace-subtle pt-5" aria-labelledby="memory-lifecycle-heading">
      <h4 className="text-sm font-semibold text-ink" id="memory-lifecycle-heading">
        {t(locale, "manager.lifecycleHeading")}
      </h4>
      <p className="mt-1 max-w-2xl text-xs leading-5 text-ink-muted">
        {t(locale, "manager.lifecycleDescription")}
      </p>
      {versions.length > 0 ? (
        <details className="mt-3 border-y border-trace-subtle py-2">
          <summary className={`min-h-control cursor-pointer py-2 text-sm font-semibold text-ink-secondary ${focusRing}`}>
            {t(locale, "manager.versionHistory")} · {versions.length}
          </summary>
          <ol className="divide-y divide-trace-subtle">
            {versions.map((version) => (
              <li className="py-3" key={version.id}>
                <p className="whitespace-pre-wrap text-sm leading-6 text-ink">
                  {version.displayText ?? t(locale, "manager.notSet")}
                </p>
                <p className="mt-1 text-xs leading-5 text-ink-muted">
                  {versionStateLabel(locale, version.state)} · {version.sourceMode === "AUTOMATIC" ? t(locale, "manager.automatic") : t(locale, "manager.explicit")} · {formatDate(locale, version.systemFrom)}
                </p>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
      {history.length > 0 ? (
        <details className="border-b border-trace-subtle py-2">
          <summary className={`min-h-control cursor-pointer py-2 text-sm font-semibold text-ink-secondary ${focusRing}`}>
            {t(locale, "manager.eventHistory")} · {history.length}
          </summary>
          <ol className="divide-y divide-trace-subtle">
            {history.map((event) => (
              <li className="flex flex-wrap justify-between gap-x-3 gap-y-1 py-3 text-sm" key={event.id}>
                <span className="font-medium text-ink-secondary">
                  {lifecycleOperationLabel(locale, event.operation)}
                  {!event.sourceAvailable
                    ? " · source unavailable"
                    : ""}
                </span>
                <span className="text-xs text-ink-muted">{formatDate(locale, event.createdAt)}</span>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </section>
  );
}

function MemoryDetail({ locale }: { locale: MemoryUiLocale }) {
  const memory = useMemoryManagerStore((state) => state.activeMemory);
  const detailError = useMemoryManagerStore((state) => state.detailError);
  const detailLoadState = useMemoryManagerStore((state) => state.detailLoadState);
  const mutationError = useMemoryManagerStore((state) => state.mutationError);
  const mutationState = useMemoryManagerStore((state) => state.mutationState);

  if (detailLoadState === "loading" && !memory) {
    return <p className="py-10 text-center text-sm text-ink-muted">{t(locale, "manager.loading")}</p>;
  }
  if (detailError && !memory) {
    return (
      <div className="py-10 text-center">
        <p className="text-sm text-critical" role="alert">{t(locale, "manager.loadError")}</p>
        <button className={`${secondaryButton} mt-3`} onClick={showMemoryList} type="button">
          {t(locale, "manager.backToList")}
        </button>
      </div>
    );
  }
  if (!memory) return <p className="py-10 text-center text-sm text-ink-muted">{t(locale, "manager.selectPrompt")}</p>;

  const validity = memory.validFrom || memory.validTo
    ? `${memory.validFrom ? formatDate(locale, memory.validFrom) : "−∞"} — ${memory.validTo ? formatDate(locale, memory.validTo) : "+∞"}`
    : t(locale, "manager.notSet");
  const errorText = mutationErrorText(locale, mutationError);
  const authority = memory.sourceMode === "AUTOMATIC"
    ? t(locale, "manager.automatic")
    : t(locale, "manager.explicit");
  const feedbackVersionId = memory.factState === "ACTIVE" && memory.sourceMode === "AUTOMATIC"
    ? memory.currentVersionId
    : null;
  return (
    <div>
      <ScreenBack locale={locale} onClick={showMemoryList} />
      <div className="mt-1 flex flex-wrap items-start justify-between gap-3 md:mt-0">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-ink" data-memory-screen-heading tabIndex={-1}>
            {t(locale, "manager.detail")}
          </h3>
          <p className="mt-1 text-xs text-ink-muted">{authority} · {scopeLabel(locale, memory.scope)}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {memory.factState === "ACTIVE" ? (
            <>
              <button
                className={secondaryButton}
                disabled={mutationState !== null}
                type="button"
                onClick={() => void toggleMemoryPinned().catch(() => undefined)}
              >
                {memory.pinned ? <PinOff className="size-4" aria-hidden="true" /> : <Pin className="size-4" aria-hidden="true" />}
                {memory.pinned ? t(locale, "manager.unpin") : t(locale, "manager.pin")}
              </button>
              <button className={secondaryButton} disabled={mutationState !== null} onClick={beginEditMemory} type="button">
                {t(locale, "manager.edit")}
              </button>
            </>
          ) : null}
          {memory.factState !== "CONFLICTED" &&
          (memory.actionVersionId ?? memory.currentVersionId) ? (
            <button className={secondaryButton} disabled={mutationState !== null} onClick={beginMoveMemory} type="button">
              <FolderInput className="size-4" aria-hidden="true" />
              Move scope
            </button>
          ) : null}
          {memory.factState !== "CONFLICTED" && (memory.actionVersionId ?? memory.currentVersionId) ? (
            <button
              className={`inline-flex min-h-touch items-center gap-2 rounded-control px-3 text-sm font-semibold text-critical hover:bg-critical/10 disabled:opacity-60 sm:min-h-control ${coarsePointerTarget} ${focusRing}`}
              disabled={mutationState !== null}
              onClick={() => void forgetCurrentMemory().catch(() => undefined)}
              type="button"
            >
              <Trash2 className="size-4" aria-hidden="true" />
              {mutationState === "forgetting"
                ? t(locale, "manager.forgetting")
                : resolveMemoryCopy(locale, "forget.action")}
            </button>
          ) : null}
        </div>
      </div>
      {errorText ? <p className="mt-3 text-sm text-critical" role="alert">{errorText}</p> : null}
      {memory.factState === "ORPHANED" ? (
        <div className="mt-3 border-y border-caution/35 bg-caution/10 px-3 py-2 text-sm leading-6 text-ink-secondary" role="status">
          Source or scope unavailable.
        </div>
      ) : null}
      {memory.factState === "EXPIRED" || memory.factState === "RETRACTED" ? (
        <div className="mt-3 border-y border-trace-subtle bg-control-surface px-3 py-2 text-sm leading-6 text-ink-secondary" role="status">
          {memory.factState === "EXPIRED"
            ? "This version expired and remains only in history."
            : "This version was retracted and no longer participates in answers."}
        </div>
      ) : null}
      <p className="mt-5 whitespace-pre-wrap border-y border-trace-subtle bg-answer-paper px-3 py-4 text-base leading-7 text-ink">
        {memory.displayText ?? t(locale, "manager.notSet")}
      </p>
      {memory.factState === "CONFLICTED" ? (
        <ConflictReview key={memory.id} locale={locale} memory={memory} />
      ) : null}
      <section className="mt-5" aria-labelledby="memory-why-heading">
        <h4 className="text-sm font-semibold text-ink" id="memory-why-heading">
          {t(locale, "manager.whyRemembered")}
        </h4>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-ink-secondary">
          {memory.sourceMode === "AUTOMATIC"
            ? t(locale, "manager.whyAutomatic")
            : t(locale, "manager.whyExplicit")}
        </p>
      </section>
      <dl className="mt-3 divide-y divide-trace-subtle">
        <MetadataRow label={t(locale, "manager.authority")}>{authority}</MetadataRow>
        <MetadataRow label={t(locale, "manager.scope")}>{scopeLabel(locale, memory.scope)}</MetadataRow>
        <MetadataRow label={t(locale, "manager.state")}>{memoryFactStateLabel(locale, memory.factState)}</MetadataRow>
        <MetadataRow label={t(locale, "manager.index")}>{indexingLabel(locale, memory.indexingState)}</MetadataRow>
        <MetadataRow label={t(locale, "manager.category")}><code className="font-mono text-xs">{memory.category}</code></MetadataRow>
        <MetadataRow label={t(locale, "manager.modality")}>{memoryModalityLabel(locale, memory.modality)}</MetadataRow>
        <MetadataRow label={t(locale, "manager.sensitivity")}>{memorySensitivityLabel(locale, memory.sensitivityClass)}</MetadataRow>
        <MetadataRow label={t(locale, "manager.sourceCount")}>{memory.sourceCount}</MetadataRow>
        <MetadataRow label={t(locale, "manager.created")}>{formatDate(locale, memory.createdAt)}</MetadataRow>
        <MetadataRow label={t(locale, "manager.updated")}>{formatDate(locale, memory.updatedAt)}</MetadataRow>
        <MetadataRow label={t(locale, "manager.lastConfirmed")}>{formatDate(locale, memory.lastConfirmedAt)}</MetadataRow>
        <MetadataRow label={t(locale, "manager.lastUsed")}>{formatDate(locale, memory.lastUsedAt)}</MetadataRow>
        <MetadataRow label={t(locale, "manager.validity")}>{validity}</MetadataRow>
        <MetadataRow label={t(locale, "manager.currentVersion")}>
          <code className="break-all font-mono text-xs">{memory.currentVersionId ?? memory.actionVersionId ?? t(locale, "manager.notSet")}</code>
        </MetadataRow>
      </dl>
      <MemoryEvidence locale={locale} memory={memory} />
      {feedbackVersionId ? (
        <MemoryFeedbackPanel
          key={feedbackVersionId}
          locale={locale}
          versionId={feedbackVersionId}
        />
      ) : null}
      <MemoryFeedbackHistory locale={locale} />
      <MemoryLifecycle locale={locale} />
    </div>
  );
}

function MemoryForm({ locale, screen, useMemoryFacts }: {
  locale: MemoryUiLocale;
  screen: "create" | "edit";
  useMemoryFacts: boolean;
}) {
  const draft = useMemoryManagerStore((state) => state.draft);
  const draftStale = useMemoryManagerStore((state) => state.draftStale);
  const mutationError = useMemoryManagerStore((state) => state.mutationError);
  const mutationState = useMemoryManagerStore((state) => state.mutationState);
  const setDraft = useMemoryManagerStore((state) => state.setDraft);
  const [attempted, setAttempted] = useState(false);
  const creating = screen === "create";
  const valid = memoryDraftIsValid(draft, creating);
  const statementInvalid = draft.statement.trim().length === 0 || draft.statement.length > MEMORY_STATEMENT_MAX_LENGTH;
  const categoryInvalid = !creating || draft.category.trim()
    ? !/^[a-z][a-z0-9_-]{0,63}$/u.test(draft.category.trim())
    : false;
  const errorText = mutationErrorText(locale, mutationError);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    if (!valid) return;
    const operation = creating ? saveNewMemory(useMemoryFacts) : saveMemoryChanges();
    void operation.catch(() => undefined);
  };

  return (
    <div>
      <ScreenBack locale={locale} onClick={cancelMemoryDraft} />
      <h3 className="mt-1 text-base font-semibold text-ink md:mt-0" data-memory-screen-heading tabIndex={-1}>
        {creating ? t(locale, "manager.createTitle") : t(locale, "manager.editTitle")}
      </h3>
      {draftStale ? (
        <div className="mt-3 flex items-start gap-2 border-y border-caution/35 bg-caution/10 px-3 py-2 text-sm leading-5 text-ink-secondary" role="alert">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-caution" aria-hidden="true" />
          {t(locale, "manager.draftStale")}
        </div>
      ) : null}
      {errorText && !draftStale ? <p className="mt-3 text-sm text-critical" role="alert">{errorText}</p> : null}
      <form className="mt-5 space-y-5" onSubmit={submit} noValidate>
        <div>
          <label className="text-sm font-semibold text-ink" htmlFor="memory-statement">
            {t(locale, "manager.statement")}
          </label>
          <textarea
            className={`mt-2 min-h-36 w-full resize-y rounded-control border bg-control-surface px-3 py-2 text-sm leading-6 text-ink placeholder:text-ink-disabled ${statementInvalid && attempted ? "border-critical" : "border-trace-subtle"} ${focusRing}`}
            id="memory-statement"
            maxLength={MEMORY_STATEMENT_MAX_LENGTH}
            value={draft.statement}
            aria-invalid={statementInvalid && attempted || undefined}
            aria-describedby="memory-statement-help memory-statement-count"
            onChange={(event) => setDraft({ statement: event.target.value })}
          />
          <div className="mt-1 flex items-start justify-between gap-3 text-xs leading-5 text-ink-muted">
            <p id="memory-statement-help">{t(locale, "manager.statementHelp")}</p>
            <span className="shrink-0 font-mono" id="memory-statement-count">{draft.statement.length}/{MEMORY_STATEMENT_MAX_LENGTH}</span>
          </div>
          {statementInvalid && attempted ? (
            <p className="mt-1 text-xs text-critical" role="alert">{t(locale, "manager.validationStatement")}</p>
          ) : null}
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <label className="text-sm font-semibold text-ink" htmlFor="memory-category">
              {t(locale, "manager.category")}
            </label>
            <input
              className={`mt-2 min-h-control w-full rounded-control border bg-control-surface px-3 text-sm text-ink ${categoryInvalid && attempted ? "border-critical" : "border-trace-subtle"} ${coarsePointerTarget} ${focusRing}`}
              id="memory-category"
              maxLength={64}
              placeholder={creating ? "custom" : undefined}
              value={draft.category}
              aria-invalid={categoryInvalid && attempted || undefined}
              aria-describedby="memory-category-help"
              onChange={(event) => setDraft({ category: event.target.value })}
            />
            <p className="mt-1 text-xs leading-5 text-ink-muted" id="memory-category-help">{t(locale, "manager.categoryHelp")}</p>
            {categoryInvalid && attempted ? (
              <p className="mt-1 text-xs text-critical" role="alert">{t(locale, "manager.validationCategory")}</p>
            ) : null}
          </div>
          <div>
            <label className="text-sm font-semibold text-ink" htmlFor="memory-modality">
              {t(locale, "manager.modality")}
            </label>
            <select
              className={`mt-2 min-h-control w-full rounded-control border border-trace-subtle bg-control-surface px-3 text-sm text-ink ${coarsePointerTarget} ${focusRing}`}
              id="memory-modality"
              value={draft.modality}
              aria-describedby="memory-modality-help"
              onChange={(event) => setDraft({ modality: event.target.value as typeof draft.modality })}
            >
              {MEMORY_MODALITIES.map((modality) => (
                <option key={modality} value={modality}>{memoryModalityLabel(locale, modality)}</option>
              ))}
            </select>
            <p className="mt-1 text-xs leading-5 text-ink-muted" id="memory-modality-help">{t(locale, "manager.modalityHelp")}</p>
          </div>
        </div>
        {creating ? (
          <MemoryScopePicker
            id="memory-scope"
            locale={locale}
            value={draft.scope}
            onChange={(scope) => setDraft({ scope })}
          />
        ) : null}
        <div className="flex flex-wrap justify-end gap-2 border-t border-trace-subtle pt-4">
          <button className={secondaryButton} disabled={mutationState !== null} onClick={cancelMemoryDraft} type="button">
            {t(locale, "manager.cancel")}
          </button>
          <button className={primaryButton} disabled={mutationState !== null} type="submit">
            {mutationState === "saving"
              ? t(locale, "manager.saving")
              : creating ? t(locale, "manager.saveNew") : t(locale, "manager.saveChanges")}
          </button>
        </div>
      </form>
    </div>
  );
}

function MoveMemoryScope({ locale }: { locale: MemoryUiLocale }) {
  const memory = useMemoryManagerStore((state) => state.activeMemory);
  const draft = useMemoryManagerStore((state) => state.draft);
  const mutationError = useMemoryManagerStore((state) => state.mutationError);
  const mutationState = useMemoryManagerStore((state) => state.mutationState);
  const setDraft = useMemoryManagerStore((state) => state.setDraft);
  if (!memory) return null;
  const unchanged = encodedScope(memory.scope) === encodedScope(draft.scope);
  return (
    <div>
      <ScreenBack locale={locale} onClick={cancelMemoryDraft} />
      <FolderInput className="mt-2 size-6 text-proof" aria-hidden="true" />
      <h3 className="mt-3 text-base font-semibold text-ink" data-memory-screen-heading tabIndex={-1}>
        Move memory scope
      </h3>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-ink-secondary">
        Creates a new active record in the selected scope; the prior record remains as historical move evidence.
      </p>
      {memory.factState === "ORPHANED" ? (
        <p className="mt-3 border-y border-caution/35 bg-caution/10 px-3 py-2 text-sm text-ink-secondary">
          Source or scope unavailable. Choose an available scope to repair it.
        </p>
      ) : null}
      {mutationError ? <p className="mt-3 text-sm text-critical" role="alert">{mutationErrorText(locale, mutationError)}</p> : null}
      <form
        className="mt-5 space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (!unchanged) void moveMemoryScope().catch(() => undefined);
        }}
      >
        <MemoryScopePicker
          id="memory-move-scope"
          locale={locale}
          value={draft.scope}
          onChange={(scope) => setDraft({ scope })}
        />
        <div className="flex flex-wrap justify-end gap-2 border-t border-trace-subtle pt-4">
          <button className={secondaryButton} disabled={mutationState !== null} onClick={cancelMemoryDraft} type="button">
            {t(locale, "manager.cancel")}
          </button>
          <button className={primaryButton} disabled={mutationState !== null || unchanged} type="submit">
            {mutationState === "moving"
              ? "Moving…"
              : "Move"}
          </button>
        </div>
      </form>
    </div>
  );
}

function deletionStateText(locale: MemoryUiLocale, status: MemoryDeletionStatus): string {
  switch (status.state) {
    case "PENDING": return t(locale, "manager.deletePending");
    case "RUNNING": return t(locale, "manager.deleteRunning");
    case "RETRY_WAIT": return t(locale, "manager.deleteRetry");
    case "BLOCKED_REQUIRES_ADMIN": return resolveMemoryCopy(locale, "deletion.blockedAdmin");
    case "SUCCEEDED": return t(locale, "manager.deleteSucceeded");
    case "CANCELLED": return "Deletion cancelled.";
  }
}

function DeleteMemories({ locale }: { locale: MemoryUiLocale }) {
  const deletionError = useMemoryManagerStore((state) => state.deletionError);
  const deletionLoadState = useMemoryManagerStore((state) => state.deletionLoadState);
  const status = useMemoryManagerStore((state) => state.deletionStatus);
  const mutationState = useMemoryManagerStore((state) => state.mutationState);
  const stale = deletionError === "memory_version_stale";
  return (
    <div>
      <ScreenBack locale={locale} onClick={showMemoryList} />
      <Trash2 className="mt-2 size-6 text-critical" aria-hidden="true" />
      <h3 className="mt-3 text-base font-semibold text-ink" data-memory-screen-heading tabIndex={-1}>
        {status ? t(locale, "manager.deleteProgress") : t(locale, "manager.deleteTitle")}
      </h3>
      {status ? (
        <div className="mt-4" aria-live="polite" aria-busy={deletionLoadState === "loading"}>
          <div className={`border-y px-3 py-3 text-sm leading-6 ${status.state === "BLOCKED_REQUIRES_ADMIN" ? "border-critical/35 bg-critical/10" : status.state === "SUCCEEDED" ? "border-positive/35 bg-positive/10" : "border-caution/35 bg-caution/10"}`}>
            <p className="font-semibold text-ink">{deletionStateText(locale, status)}</p>
            <p className="mt-1 text-ink-secondary">
              {t(locale, "manager.deleteProgress")}: {status.completedUnits}
              {status.totalUnits === null ? "" : ` / ${status.totalUnits}`}
            </p>
          </div>
          <dl className="mt-3 divide-y divide-trace-subtle">
            <MetadataRow label={t(locale, "manager.deleteStatusId")}>
              <code className="break-all font-mono text-xs">{status.deletionId}</code>
            </MetadataRow>
            <MetadataRow label={t(locale, "manager.updated")}>{formatDate(locale, status.updatedAt)}</MetadataRow>
            <MetadataRow label={t(locale, "manager.lastAudit")}>{formatDate(locale, status.lastAuditAt)}</MetadataRow>
          </dl>
          {deletionError ? <p className="mt-3 text-sm text-critical" role="alert">{t(locale, "manager.mutationError")}</p> : null}
          <div className="mt-4 flex flex-wrap gap-2">
            <button className={secondaryButton} onClick={showMemoryList} type="button">
              {t(locale, "manager.backToList")}
            </button>
            {status.state !== "SUCCEEDED" && status.state !== "CANCELLED" ? (
              <button
                className={secondaryButton}
                disabled={deletionLoadState === "loading"}
                type="button"
                onClick={() => void refreshMemoryDeletionStatus().catch(() => undefined)}
              >
                <RotateCw className="size-4" aria-hidden="true" />
                {t(locale, "manager.deleteCheckAgain")}
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="mt-3">
          <p className="max-w-2xl text-sm leading-6 text-ink-secondary">{t(locale, "manager.deleteExplanation")}</p>
          <details className="mt-3 max-w-2xl border-y border-trace-subtle py-1">
            <summary className={`min-h-control cursor-pointer py-2 text-sm font-semibold text-ink-secondary ${focusRing}`}>
              {t(locale, "manager.deletionDetails")}
            </summary>
            <div className="pb-3 text-xs leading-5 text-ink-muted">
              <p>{t(locale, "manager.deleteRetention")}</p>
              <p className="mt-2">{t(locale, "manager.deleteConfirmation")}</p>
            </div>
          </details>
          {deletionError ? (
            <p className="mt-3 text-sm text-critical" role="alert">
              {stale ? t(locale, "manager.deleteStale") : t(locale, "manager.mutationError")}
            </p>
          ) : null}
          <div className="mt-5 flex flex-wrap gap-2 border-t border-trace-subtle pt-4">
            <button className={secondaryButton} disabled={mutationState !== null} onClick={showMemoryList} type="button">
              {t(locale, "manager.cancel")}
            </button>
            <button
              className={destructiveButton}
              disabled={mutationState !== null}
              type="button"
              onClick={() => void confirmDeleteExplicitMemories().catch(() => undefined)}
            >
              <Trash2 className="size-4" aria-hidden="true" />
              {mutationState === "deleting" ? t(locale, "manager.deleteWorking") : resolveMemoryCopy(locale, "bulkDelete.explicit.action")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function DetailPane({ locale, screen, useMemoryFacts }: {
  locale: MemoryUiLocale;
  screen: MemoryManagerScreen;
  useMemoryFacts: boolean;
}) {
  if (screen === "create" || screen === "edit") {
    return <MemoryForm locale={locale} screen={screen} useMemoryFacts={useMemoryFacts} />;
  }
  if (screen === "move") return <MoveMemoryScope locale={locale} />;
  if (screen === "delete") return <DeleteMemories locale={locale} />;
  return <MemoryDetail locale={locale} />;
}

export function ManageMemories({
  accountId,
  locale,
  onBack,
  onBusyChange,
  onDirtyChange,
  onOpenMemorySource,
  useMemoryFacts
}: {
  accountId: string;
  locale: MemoryUiLocale;
  onBack(): void;
  onBusyChange?(busy: boolean): void;
  onDirtyChange?(dirty: boolean): void;
  onOpenMemorySource(chatId: string): void;
  useMemoryFacts: boolean;
}) {
  const draftDirty = useMemoryManagerStore((state) => state.draftDirty);
  const mutationState = useMemoryManagerStore((state) => state.mutationState);
  const screen = useMemoryManagerStore((state) => state.screen);
  const [exitConfirmation, setExitConfirmation] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const historyEntryRef = useRef<HTMLButtonElement>(null);
  const returnToHistoryEntryRef = useRef(false);

  useEffect(() => {
    void openMemoryManager(accountId);
  }, [accountId]);
  useEffect(() => {
    onBusyChange?.(mutationState !== null);
    return () => onBusyChange?.(false);
  }, [mutationState, onBusyChange]);
  useEffect(() => {
    onDirtyChange?.(draftDirty);
    return () => onDirtyChange?.(false);
  }, [draftDirty, onDirtyChange]);
  useEffect(() => {
    rootRef.current?.querySelector<HTMLElement>("[data-memory-screen-heading]")?.focus({ preventScroll: true });
  }, [screen]);
  useEffect(() => {
    if (!historyOpen && returnToHistoryEntryRef.current) {
      returnToHistoryEntryRef.current = false;
      historyEntryRef.current?.focus({ preventScroll: true });
    }
  }, [historyOpen]);

  const deletionStatus = useMemoryManagerStore((state) => state.deletionStatus);
  useEffect(() => {
    if (!deletionStatus || deletionStatus.state === "SUCCEEDED" || deletionStatus.state === "CANCELLED" || deletionStatus.state === "BLOCKED_REQUIRES_ADMIN") {
      return;
    }
    const delay = deletionStatus.state === "RETRY_WAIT" ? 5_000 : 1_500;
    const timer = window.setTimeout(() => {
      void refreshMemoryDeletionStatus(deletionStatus.deletionId).catch(() => undefined);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [deletionStatus]);

  const requestBack = () => {
    if (draftDirty) {
      setExitConfirmation(true);
      return;
    }
    onBack();
  };

  if (historyOpen) {
    return (
      <div ref={rootRef} className="mx-auto w-full max-w-5xl" data-testid="manage-memories">
        <MemoryHistorySearch
          accountId={accountId}
          locale={locale}
          onBack={() => {
            returnToHistoryEntryRef.current = true;
            setHistoryOpen(false);
          }}
          onOpenSource={onOpenMemorySource}
        />
      </div>
    );
  }

  return (
    <div ref={rootRef} className="mx-auto w-full max-w-5xl" data-testid="manage-memories">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-trace-subtle pb-4">
        <div className="min-w-0">
          <button className={`${quietButton} -ml-2`} disabled={mutationState !== null} onClick={requestBack} type="button">
            <ArrowLeft className="size-4" aria-hidden="true" />
            {t(locale, "manager.back")}
          </button>
          <h2 className="mt-1 text-lg font-semibold text-ink" data-memory-screen-heading={screen === "list" ? "" : undefined} tabIndex={screen === "list" ? -1 : undefined}>
            {t(locale, "manager.title")}
          </h2>
        </div>
        <button
          className={primaryButton}
          disabled={mutationState !== null || draftDirty}
          onClick={beginCreateMemory}
          type="button"
        >
          <Plus className="size-4" aria-hidden="true" />
          {t(locale, "manager.new")}
        </button>
      </header>

      {exitConfirmation ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-y border-caution/35 bg-caution/10 px-3 py-3" role="alert">
          <div>
            <p className="text-sm font-semibold text-ink">{t(locale, "manager.discardTitle")}</p>
            <p className="mt-1 text-xs leading-5 text-ink-secondary">{t(locale, "manager.discardBody")}</p>
          </div>
          <div className="flex gap-2">
            <button className={secondaryButton} onClick={() => setExitConfirmation(false)} type="button">
              {t(locale, "manager.keepEditing")}
            </button>
            <button
              className={destructiveButton}
              type="button"
              onClick={() => {
                discardMemoryManagerDraft();
                setExitConfirmation(false);
                onBack();
              }}
            >
              {t(locale, "manager.discardDraft")}
            </button>
          </div>
        </div>
      ) : null}

      <div className="mt-4"><LiveNotice locale={locale} /></div>
      <button
        ref={historyEntryRef}
        aria-label={memoryHistoryUiCopy(locale, "entry")}
        className={`mt-4 flex min-h-touch w-full items-center gap-3 border-y border-trace-subtle px-2 py-3 text-left hover:bg-control-hover disabled:cursor-not-allowed disabled:text-ink-disabled disabled:opacity-60 ${coarsePointerTarget} ${focusRing}`}
        disabled={mutationState !== null || draftDirty}
        type="button"
        onClick={() => setHistoryOpen(true)}
      >
        <span className="grid size-9 shrink-0 place-items-center rounded-control bg-control-selected text-proof">
          <History className="size-4" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-ink">
            {memoryHistoryUiCopy(locale, "entry")}
          </span>
          <span className="mt-0.5 block text-xs leading-5 text-ink-muted">
            {memoryHistoryUiCopy(locale, "entryDescription")}
          </span>
        </span>
        <ChevronRight className="size-4 shrink-0 text-ink-muted" aria-hidden="true" />
      </button>
      <div className={`mt-4 border-y border-trace-subtle ${screen === "delete" ? "" : "md:grid md:grid-cols-[minmax(15rem,0.85fr)_minmax(0,1.15fr)]"}`}>
        {screen === "delete" ? null : (
          <div
            className={screen === "list" ? "block" : "hidden md:block"}
            inert={draftDirty || undefined}
          >
            <MemoryListPane locale={locale} />
          </div>
        )}
        <div className={`${screen === "list" ? "hidden md:block" : "block"} min-w-0 p-4 sm:p-5`} data-testid="memory-detail-pane">
          <DetailPane locale={locale} screen={screen} useMemoryFacts={useMemoryFacts} />
        </div>
      </div>
    </div>
  );
}
