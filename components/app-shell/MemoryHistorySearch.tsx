import {
  activateMemoryHistorySearchAccount,
  applyMemoryHistorySearch,
  cancelMemoryHistorySearch,
  loadMoreMemoryHistorySearch,
  useMemoryHistorySearchStore
} from "@/components/app-shell/memoryHistorySearchStore";
import {
  memoryHistoryUiCopy,
  type MemoryHistoryUiCopyKey
} from "@/components/app-shell/memoryHistoryUiCopy";
import {
  useWorkspaceStore,
  workspaceNavigationChats
} from "@/components/app-shell/workspaceStore";
import {
  MEMORY_QUERY_MAX_LENGTH,
  type MemoryHistorySearchResponse
} from "@/lib/contracts/memory";
import {
  Archive,
  ArrowLeft,
  CalendarDays,
  CircleAlert,
  Folder,
  History,
  LoaderCircle,
  MessageSquareText,
  RotateCw,
  Search,
  SlidersHorizontal,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, type FormEvent } from "react";

const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-overlay-surface";
const coarsePointerTarget =
  "[@media(hover:none)]:!min-h-touch [@media(pointer:coarse)]:!min-h-touch";
const inputClass =
  `min-h-touch w-full rounded-control border border-trace-subtle bg-control-surface px-3 text-sm text-ink placeholder:text-ink-muted disabled:text-ink-disabled sm:min-h-control ${coarsePointerTarget} ${focusRing}`;
const secondaryButton =
  `inline-flex min-h-touch items-center justify-center gap-2 rounded-control border border-trace-subtle bg-control-surface px-3 text-sm font-semibold text-ink-secondary hover:bg-control-hover hover:text-ink disabled:cursor-not-allowed disabled:text-ink-disabled disabled:opacity-60 sm:min-h-control ${coarsePointerTarget} ${focusRing}`;
const quietButton =
  `inline-flex min-h-touch items-center justify-center gap-2 rounded-control px-3 text-sm font-semibold text-ink-secondary hover:bg-control-hover hover:text-ink disabled:cursor-not-allowed disabled:text-ink-disabled disabled:opacity-60 sm:min-h-control ${coarsePointerTarget} ${focusRing}`;
const primaryButton =
  `inline-flex min-h-touch items-center justify-center gap-2 rounded-control bg-proof px-4 text-sm font-semibold text-proof-contrast hover:bg-proof-hover disabled:cursor-not-allowed disabled:bg-control-surface disabled:text-ink-disabled sm:min-h-control ${coarsePointerTarget} ${focusRing}`;

function t(key: MemoryHistoryUiCopyKey): string {
  return memoryHistoryUiCopy(key);
}

function formattedDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function indexingCopy(indexing: MemoryHistorySearchResponse["indexing"]): string {
  if (indexing.lexicalState === "DISABLED") return t("historyDisabled");
  if (indexing.lexicalState === "UNAVAILABLE") return t("indexUnavailable");
  if (indexing.vectorState === "READY") return t("vectorReady");
  if (indexing.vectorState === "NOT_CONFIGURED") return t("vectorNotConfigured");
  switch (indexing.degradationCode) {
    case "memory_vector_generation_stale": return t("vectorStale");
    case "memory_vector_profile_unsupported": return t("vectorProfileUnsupported");
    case "memory_vector_unavailable": return t("vectorUnavailable");
    default: return t("lexicalReady");
  }
}

function itemIndexingCopy(
  state: MemoryHistorySearchResponse["results"][number]["indexingState"]
): string {
  switch (state) {
    case "HYBRID_READY": return t("itemHybrid");
    case "VECTOR_PENDING": return t("itemVectorPending");
    case "DEGRADED": return t("itemDegraded");
    case "LEXICAL_READY": return t("itemLexical");
  }
}

function errorCopy(error: string | null): string {
  if (error === "memory_history_query_invalid") return t("queryInvalid");
  if (error === "memory_history_interval_invalid") return t("intervalInvalid");
  return t("error");
}

export function MemoryHistorySearch({
  accountId,
  onBack,
  onOpenSource
}: {
  accountId: string;
  onBack(): void;
  onOpenSource(chatId: string): void;
}) {
  const draft = useMemoryHistorySearchStore((state) => state.draft);
  const error = useMemoryHistorySearchStore((state) => state.error);
  const indexing = useMemoryHistorySearchStore((state) => state.indexing);
  const loadState = useMemoryHistorySearchStore((state) => state.loadState);
  const nextCursor = useMemoryHistorySearchStore((state) => state.nextCursor);
  const results = useMemoryHistorySearchStore((state) => state.results);
  const setChatId = useMemoryHistorySearchStore((state) => state.setChatId);
  const setFolderId = useMemoryHistorySearchStore((state) => state.setFolderId);
  const setFromDate = useMemoryHistorySearchStore((state) => state.setFromDate);
  const setQuery = useMemoryHistorySearchStore((state) => state.setQuery);
  const setThroughDate = useMemoryHistorySearchStore((state) => state.setThroughDate);
  const chats = useWorkspaceStore((state) => state.chats);
  const folders = useWorkspaceStore((state) => state.folders);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const eligibleChats = useMemo(() => workspaceNavigationChats(chats), [chats]);
  const loading = loadState === "loading";

  useEffect(() => {
    activateMemoryHistorySearchAccount(accountId);
    headingRef.current?.focus({ preventScroll: true });
    return () => cancelMemoryHistorySearch();
  }, [accountId]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void applyMemoryHistorySearch();
  }

  function back() {
    cancelMemoryHistorySearch();
    onBack();
  }

  const indexingDegraded = indexing && (
    indexing.lexicalState !== "READY" || indexing.vectorState === "DEGRADED"
  );

  return (
    <div className="mx-auto w-full max-w-4xl" data-testid="memory-history-search">
      <header className="border-b border-trace-subtle pb-4">
        <button className={`${quietButton} -ml-2`} onClick={back} type="button">
          <ArrowLeft className="size-4" aria-hidden="true" />
          {t("back")}
        </button>
        <div className="mt-2 flex items-start gap-3">
          <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-control bg-control-selected text-proof">
            <History className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 ref={headingRef} className="text-lg font-semibold text-ink" tabIndex={-1}>
              {t("title")}
            </h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-ink-secondary">
              {t("intro")}
            </p>
          </div>
        </div>
      </header>

      <form className="mt-5" onSubmit={submit}>
        <label className="text-sm font-semibold text-ink" htmlFor="memory-history-query">
          {t("queryLabel")}
        </label>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-muted" aria-hidden="true" />
            <input
              autoComplete="off"
              className={`${inputClass} pl-9 pr-9`}
              id="memory-history-query"
              maxLength={MEMORY_QUERY_MAX_LENGTH}
              placeholder={t("queryPlaceholder")}
              value={draft.query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {draft.query ? (
              <button
                className={`absolute right-1 top-1/2 grid size-9 -translate-y-1/2 place-items-center rounded-control text-ink-muted hover:bg-control-hover hover:text-ink ${focusRing}`}
                type="button"
                aria-label="Clear query"
                onClick={() => setQuery("")}
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            ) : null}
          </div>
          <button className={`${primaryButton} shrink-0`} disabled={loading} type="submit">
            <Search className="size-4" aria-hidden="true" />
            {t("search")}
          </button>
        </div>

        <details className="mt-3 border-y border-trace-subtle py-2">
          <summary className={`flex min-h-touch cursor-pointer list-none items-center gap-2 rounded-control px-2 text-sm font-semibold text-ink-secondary hover:bg-control-hover sm:min-h-control ${coarsePointerTarget} ${focusRing}`}>
            <SlidersHorizontal className="size-4 text-ink-muted" aria-hidden="true" />
            {t("filters")}
          </summary>
          <div className="grid gap-4 px-2 pb-2 pt-4 sm:grid-cols-2">
            <label className="text-xs font-semibold text-ink-secondary">
              <span className="mb-1.5 flex items-center gap-2">
                <MessageSquareText className="size-3.5 text-ink-muted" aria-hidden="true" />
                {t("chat")}
              </span>
              <select className={inputClass} value={draft.chatId ?? ""} onChange={(event) => setChatId(event.target.value || null)}>
                <option value="">{t("allChats")}</option>
                {eligibleChats.map((chat) => <option key={chat.id} value={chat.id}>{chat.title}</option>)}
              </select>
            </label>
            <label className="text-xs font-semibold text-ink-secondary">
              <span className="mb-1.5 flex items-center gap-2">
                <Folder className="size-3.5 text-ink-muted" aria-hidden="true" />
                {t("folder")}
              </span>
              <select className={inputClass} value={draft.folderId ?? ""} onChange={(event) => setFolderId(event.target.value || null)}>
                <option value="">{t("allFolders")}</option>
                {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
              </select>
            </label>
            <label className="text-xs font-semibold text-ink-secondary">
              <span className="mb-1.5 flex items-center gap-2">
                <CalendarDays className="size-3.5 text-ink-muted" aria-hidden="true" />
                {t("fromDate")}
              </span>
              <input className={inputClass} type="date" value={draft.fromDate} onChange={(event) => setFromDate(event.target.value)} />
            </label>
            <label className="text-xs font-semibold text-ink-secondary">
              <span className="mb-1.5 flex items-center gap-2">
                <CalendarDays className="size-3.5 text-ink-muted" aria-hidden="true" />
                {t("throughDate")}
              </span>
              <input className={inputClass} type="date" value={draft.throughDate} onChange={(event) => setThroughDate(event.target.value)} />
            </label>
            <p className="text-xs leading-5 text-ink-muted sm:col-span-2">{t("dateHelp")}</p>
          </div>
        </details>
      </form>

      {indexing ? (
        <div
          className={`mt-4 flex items-start gap-2 border-y px-3 py-2 text-sm leading-5 ${indexingDegraded ? "border-caution/35 bg-caution/10 text-ink-secondary" : "border-trace-subtle text-ink-muted"}`}
          role={indexingDegraded ? "status" : undefined}
        >
          {indexingDegraded ? <CircleAlert className="mt-0.5 size-4 shrink-0 text-caution" aria-hidden="true" /> : null}
          <span>{indexingCopy(indexing)}</span>
        </div>
      ) : null}

      {loading ? (
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-y border-trace-subtle py-3" role="status">
          <span className="flex items-center gap-2 text-sm text-ink-secondary">
            <LoaderCircle className="size-4 animate-spin text-proof motion-reduce:animate-none" aria-hidden="true" />
            {results.length > 0 ? t("loadingMore") : t("loading")}
          </span>
          <button className={secondaryButton} type="button" onClick={cancelMemoryHistorySearch}>
            <X className="size-4" aria-hidden="true" />
            {t("cancel")}
          </button>
        </div>
      ) : loadState === "cancelled" ? (
        <p className="mt-5 border-y border-trace-subtle py-3 text-sm text-ink-secondary" role="status">
          {t("cancelled")}
        </p>
      ) : loadState === "error" ? (
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-y border-critical/30 bg-critical/5 px-3 py-3" role="alert">
          <span className="flex items-start gap-2 text-sm text-critical">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {errorCopy(error)}
          </span>
          <button className={secondaryButton} type="button" onClick={() => void applyMemoryHistorySearch()}>
            <RotateCw className="size-4" aria-hidden="true" />
            {t("retry")}
          </button>
        </div>
      ) : null}

      {loadState === "ready" && results.length === 0 ? (
        <p className="mt-6 border-y border-trace-subtle py-8 text-center text-sm text-ink-muted" role="status">
          {t("empty")}
        </p>
      ) : null}

      {results.length > 0 ? (
        <ol className="mt-5 divide-y divide-trace-subtle border-y border-trace-subtle" aria-label={t("sourceTrail")}>
          {results.map((result) => {
            const sourceKey = `${result.itemType}:${result.sourceChatId}:${result.occurredAt}:${result.sourceMessageIds.join(",")}`;
            return (
              <li className="min-w-0 py-4" key={sourceKey}>
                <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted">
                      <span className="font-semibold uppercase tracking-[0.08em] text-proof">
                        {t("excerpt")}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{itemIndexingCopy(result.indexingState)}</span>
                      {result.sourceState === "ARCHIVED" ? (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="inline-flex items-center gap-1 font-semibold text-ink-secondary">
                            <Archive className="size-3.5" aria-hidden="true" />
                            {t("archived")}
                          </span>
                        </>
                      ) : null}
                    </div>
                    <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-ink">
                      {result.snippet}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs leading-5 text-ink-muted">
                      <span className="inline-flex min-w-0 items-center gap-1.5">
                        <MessageSquareText className="size-3.5 shrink-0" aria-hidden="true" />
                        <span className="break-words font-medium text-ink-secondary">{result.sourceChatTitle}</span>
                      </span>
                      {result.sourceFolderName ? (
                        <span className="inline-flex min-w-0 items-center gap-1.5">
                          <Folder className="size-3.5 shrink-0" aria-hidden="true" />
                          <span className="break-words">{result.sourceFolderName}</span>
                        </span>
                      ) : null}
                      <time dateTime={result.occurredAt}>{formattedDate(result.occurredAt)}</time>
                    </div>
                  </div>
                  <button className={`${secondaryButton} shrink-0 sm:self-center`} type="button" onClick={() => onOpenSource(result.sourceChatId)}>
                    {result.sourceState === "ARCHIVED" ? <Archive className="size-4" aria-hidden="true" /> : <MessageSquareText className="size-4" aria-hidden="true" />}
                    {result.sourceState === "ARCHIVED" ? t("openArchived") : t("openChat")}
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      ) : null}

      {nextCursor ? (
        <div className="mt-4 flex justify-center">
          <button className={secondaryButton} disabled={loading} type="button" onClick={() => void loadMoreMemoryHistorySearch()}>
            {loading ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <History className="size-4" aria-hidden="true" />}
            {loading ? t("loadingMore") : t("loadMore")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
