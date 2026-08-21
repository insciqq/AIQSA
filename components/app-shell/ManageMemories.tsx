import {
  applyMemorySearch,
  beginCreateMemory,
  beginEditMemory,
  cancelMemoryDraft,
  clearMemorySearch,
  forgetCurrentMemory,
  memoryDraftIsValid,
  openMemoryDetail,
  openMemoryManager,
  refreshMemoryList,
  saveMemoryChanges,
  saveNewMemory,
  showMemoryList,
  useMemoryManagerStore,
  type MemoryManagerScreen
} from "@/components/app-shell/memoryManagerStore";
import {
  MEMORY_UI_LOCALE,
  memoryCategoryLabel,
  memoryUiCopy
} from "@/components/app-shell/memoryUiCopy";
import {
  MEMORY_CONSUMER_CATEGORIES,
  MEMORY_CONSUMER_QUERY_MAX_LENGTH,
  MEMORY_CONSUMER_STATEMENT_MAX_LENGTH,
  type MemoryConsumerItem,
  type MemoryConsumerListInput
} from "@/lib/contracts/memoryConsumer";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  CircleAlert,
  Plus,
  Search,
  Trash2,
  X
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent
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
  `inline-flex min-h-touch items-center justify-center gap-2 rounded-control border border-critical/50 bg-critical/10 px-3 text-sm font-semibold text-critical hover:bg-critical/15 disabled:cursor-not-allowed disabled:opacity-60 sm:min-h-control ${coarsePointerTarget} ${focusRing}`;

function t(key: Parameters<typeof memoryUiCopy>[0]): string {
  return memoryUiCopy(key);
}

function formatDate(value: string | null): string {
  if (!value) return t("manager.never");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t("manager.notSet");
  return new Intl.DateTimeFormat(MEMORY_UI_LOCALE, { dateStyle: "medium" }).format(date);
}

function provenanceLabel(memory: MemoryConsumerItem): string {
  return memory.provenance === "LEARNED"
    ? t("manager.learnedFromChat")
    : t("manager.savedByYou");
}

function sourceAvailabilityLabel(memory: MemoryConsumerItem): string {
  return memory.sourceAvailable
    ? t("manager.sourceAvailable")
    : t("manager.sourceUnavailable");
}

const MANAGE_MEMORY_CATEGORIES = MEMORY_CONSUMER_CATEGORIES;

function mutationErrorText(code: string | null): string | null {
  if (!code) return null;
  if (code === "memory_secret_rejected") return t("manager.secretRejected");
  if (code === "memory_changed") return t("manager.draftStale");
  if (code === "memory_unavailable") return t("manager.unavailable");
  return t("manager.mutationError");
}

function LiveNotice() {
  const notice = useMemoryManagerStore((state) => state.notice);
  if (!notice) return <div className="sr-only" aria-live="polite" />;
  const text = notice === "forgotten"
    ? t("manager.forgotten")
    : notice === "saved_use_off"
      ? t("manager.savedUseOff")
      : t("manager.saved");
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-y border-positive/30 bg-positive/10 px-3 py-2 text-sm leading-5 text-ink-secondary" role="status">
      <Check className="mt-0.5 size-4 shrink-0 text-positive" aria-hidden="true" />
      <span className="min-w-0 flex-1">{text}</span>
    </div>
  );
}

function MemoryFilters({
  category,
  categories,
  onCategory,
  onSource,
  source
}: {
  category: MemoryConsumerListInput["category"] | "ALL";
  categories: readonly (NonNullable<MemoryConsumerListInput["category"]>)[];
  onCategory(value: MemoryConsumerListInput["category"] | "ALL"): void;
  onSource(value: MemoryConsumerListInput["provenance"] | "ALL"): void;
  source: MemoryConsumerListInput["provenance"] | "ALL";
}) {
  return (
    <div className="grid gap-2 border-b border-trace-subtle p-3 sm:grid-cols-2">
      <label className="text-xs font-semibold text-ink-secondary" htmlFor="memory-category-filter">
        {t("manager.categoryFilter")}
        <select
          className={`mt-1 min-h-control w-full rounded-control border border-trace-subtle bg-control-surface px-2 text-sm font-normal text-ink ${coarsePointerTarget} ${focusRing}`}
          id="memory-category-filter"
          value={category}
          onChange={(event) => onCategory(
            event.target.value as MemoryConsumerListInput["category"] | "ALL"
          )}
        >
          <option value="ALL">{t("manager.allCategories")}</option>
          {categories.map((item) => (
            <option key={item} value={item}>{memoryCategoryLabel(item)}</option>
          ))}
        </select>
      </label>
      <label className="text-xs font-semibold text-ink-secondary" htmlFor="memory-source-filter">
        {t("manager.sourceFilter")}
        <select
          className={`mt-1 min-h-control w-full rounded-control border border-trace-subtle bg-control-surface px-2 text-sm font-normal text-ink ${coarsePointerTarget} ${focusRing}`}
          id="memory-source-filter"
          value={source}
          onChange={(event) => onSource(
            event.target.value as MemoryConsumerListInput["provenance"] | "ALL"
          )}
        >
          <option value="ALL">{t("manager.allSources")}</option>
          <option value="SAVED">{t("manager.savedByYou")}</option>
          <option value="LEARNED">{t("manager.learnedFromChat")}</option>
        </select>
      </label>
    </div>
  );
}

function MemoryListPane() {
  const listError = useMemoryManagerStore((state) => state.listError);
  const listLoadState = useMemoryManagerStore((state) => state.listLoadState);
  const memories = useMemoryManagerStore((state) => state.memories);
  const nextCursor = useMemoryManagerStore((state) => state.nextCursor);
  const category = useMemoryManagerStore((state) => state.categoryFilter);
  const source = useMemoryManagerStore((state) => state.provenanceFilter);
  const queryApplied = useMemoryManagerStore((state) => state.queryApplied);
  const queryInput = useMemoryManagerStore((state) => state.queryInput);
  const setCategory = useMemoryManagerStore((state) => state.setCategoryFilter);
  const setSource = useMemoryManagerStore((state) => state.setProvenanceFilter);
  const setQueryInput = useMemoryManagerStore((state) => state.setQueryInput);

  const changeCategory = (
    value: MemoryConsumerListInput["category"] | "ALL"
  ) => {
    setCategory(value);
    void refreshMemoryList().catch(() => undefined);
  };
  const changeSource = (
    value: MemoryConsumerListInput["provenance"] | "ALL"
  ) => {
    setSource(value);
    void refreshMemoryList().catch(() => undefined);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void applyMemorySearch().catch(() => undefined);
  };

  return (
    <div className="min-w-0 md:border-r md:border-trace-subtle" data-testid="memory-list-pane">
      <form className="border-b border-trace-subtle p-3" onSubmit={submit} role="search">
        <label className="text-xs font-semibold text-ink-secondary" htmlFor="memory-search-input">
          {t("manager.searchLabel")}
        </label>
        <div className="mt-2 flex min-w-0 gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-muted" aria-hidden="true" />
            <input
              className={`min-h-control w-full rounded-control border border-trace-subtle bg-control-surface py-2 pl-9 pr-9 text-sm text-ink placeholder:text-ink-disabled ${coarsePointerTarget} ${focusRing}`}
              id="memory-search-input"
              maxLength={MEMORY_CONSUMER_QUERY_MAX_LENGTH}
              placeholder={t("manager.searchPlaceholder")}
              type="search"
              value={queryInput}
              onChange={(event) => setQueryInput(event.target.value)}
            />
            {queryInput ? (
              <button
                className={`absolute right-1 top-1/2 grid size-9 -translate-y-1/2 place-items-center rounded-control text-ink-muted hover:bg-control-hover hover:text-ink ${focusRing}`}
                type="button"
                aria-label={t("manager.clearSearch")}
                onClick={() => void clearMemorySearch().catch(() => undefined)}
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            ) : null}
          </div>
          <button className={secondaryButton} disabled={!queryInput.trim()} type="submit">
            {t("manager.searchAction")}
          </button>
        </div>
      </form>

      <MemoryFilters
        categories={MANAGE_MEMORY_CATEGORIES}
        category={category}
        onCategory={changeCategory}
        onSource={changeSource}
        source={source}
      />

      <div aria-live="polite" aria-busy={listLoadState === "loading"}>
        {listLoadState === "loading" && memories.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-ink-muted">{t("manager.loading")}</p>
        ) : null}
        {listError && memories.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <p className="text-sm text-critical" role="alert">{t("manager.loadError")}</p>
            <button className={`${secondaryButton} mt-3`} type="button" onClick={() => void refreshMemoryList().catch(() => undefined)}>
              {t("manager.retry")}
            </button>
          </div>
        ) : null}
        {listLoadState !== "loading" && !listError && memories.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-ink-muted">
            {queryApplied || category !== "ALL" || source !== "ALL" ? t("manager.noResults") : t("manager.empty")}
          </p>
        ) : null}
        {memories.length > 0 ? (
          <ul className="divide-y divide-trace-subtle" aria-label={t("manager.title")}>
            {memories.map((memory) => (
              <li className="flex items-start gap-2 px-3 py-3 hover:bg-control-hover" key={memory.memoryRef}>
                <button
                  className={`group flex min-h-touch min-w-0 flex-1 items-start gap-3 rounded-control text-left ${focusRing}`}
                  type="button"
                  onClick={() => openMemoryDetail(memory.memoryRef)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block line-clamp-3 whitespace-pre-wrap text-sm font-medium leading-5 text-ink">
                      {memory.statement}
                    </span>
                    <span className="mt-1.5 flex flex-wrap gap-x-2 gap-y-1 text-xs text-ink-muted">
                      <span>{provenanceLabel(memory)}</span>
                      <span aria-hidden="true">·</span>
                      <span>{memoryCategoryLabel(memory.category)}</span>
                      <span aria-hidden="true">·</span>
                      <span>{formatDate(memory.updatedAt)}</span>
                    </span>
                    <span className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-xs text-ink-muted">
                      <span>{sourceAvailabilityLabel(memory)}</span>
                    </span>
                  </span>
                  <ChevronRight className="mt-1 size-4 shrink-0 text-ink-muted group-hover:text-ink" aria-hidden="true" />
                </button>
                <span className="flex shrink-0 flex-col gap-1 sm:flex-row">
                  {memory.allowedActions.includes("EDIT") ? (
                    <button
                      aria-label={`${t("manager.edit")}: ${memory.statement}`}
                      className={quietButton}
                      type="button"
                      onClick={() => {
                        openMemoryDetail(memory.memoryRef);
                        beginEditMemory();
                      }}
                    >
                      {t("manager.edit")}
                    </button>
                  ) : null}
                  {memory.allowedActions.includes("FORGET") ? (
                    <button
                      aria-label={`${t("manager.forget")}: ${memory.statement}`}
                      className={destructiveButton}
                      type="button"
                      onClick={() => {
                        openMemoryDetail(memory.memoryRef);
                        void forgetCurrentMemory().catch(() => undefined);
                      }}
                    >
                      {t("manager.forget")}
                    </button>
                  ) : null}
                </span>
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
              {listLoadState === "loading" ? t("manager.loadingMore") : t("manager.loadMore")}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function MemoryDetail() {
  const memory = useMemoryManagerStore((state) => state.activeMemory);
  const mutationError = useMemoryManagerStore((state) => state.mutationError);
  const mutationState = useMemoryManagerStore((state) => state.mutationState);

  if (!memory) return <p className="py-10 text-center text-sm text-ink-muted">{t("manager.selectPrompt")}</p>;

  const errorText = mutationErrorText(mutationError);
  const canForget = memory.allowedActions.includes("FORGET");
  const canEdit = memory.allowedActions.includes("EDIT");

  return (
    <div>
      <button className={`${quietButton} -ml-2 md:hidden`} onClick={showMemoryList} type="button">
        <ArrowLeft className="size-4" aria-hidden="true" />
        {t("manager.backToList")}
      </button>
      <div className="mt-1 flex flex-wrap items-start justify-between gap-3 md:mt-0">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-ink" data-memory-screen-heading tabIndex={-1}>{t("manager.detail")}</h3>
          <p className="mt-1 text-sm text-ink-muted">{provenanceLabel(memory)} · {memoryCategoryLabel(memory.category)} · {formatDate(memory.updatedAt)}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canEdit ? <button className={secondaryButton} disabled={mutationState !== null} onClick={beginEditMemory} type="button">{t("manager.edit")}</button> : null}
          {canForget ? (
            <button className={destructiveButton} disabled={mutationState !== null} onClick={() => void forgetCurrentMemory().catch(() => undefined)} type="button">
              <Trash2 className="size-4" aria-hidden="true" />
              {mutationState === "forgetting" ? t("manager.forgetting") : t("manager.forget")}
            </button>
          ) : null}
        </div>
      </div>
      {errorText ? <p className="mt-3 text-sm text-critical" role="alert">{errorText}</p> : null}
      {!memory.sourceAvailable ? (
        <div className="mt-3 flex items-start gap-2 border-y border-caution/35 bg-caution/10 px-3 py-2 text-sm leading-6 text-ink-secondary" role="status">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-caution" aria-hidden="true" />
          {t("manager.sourceUnavailable")}
        </div>
      ) : null}
      <p className="mt-5 whitespace-pre-wrap border-y border-trace-subtle bg-answer-paper px-3 py-4 text-base leading-7 text-ink">
        {memory.statement}
      </p>
      <dl className="mt-4 divide-y divide-trace-subtle">
        <div className="flex flex-wrap justify-between gap-2 py-2 text-sm">
          <dt className="text-ink-muted">{t("manager.categoryFilter")}</dt>
          <dd className="font-medium text-ink-secondary">{memoryCategoryLabel(memory.category)}</dd>
        </div>
        <div className="flex flex-wrap justify-between gap-2 py-2 text-sm">
          <dt className="text-ink-muted">{t("manager.sourceFilter")}</dt>
          <dd className="font-medium text-ink-secondary">{sourceAvailabilityLabel(memory)}</dd>
        </div>
        <div className="flex flex-wrap justify-between gap-2 py-2 text-sm">
          <dt className="text-ink-muted">{t("manager.updatedLabel")}</dt>
          <dd className="font-medium text-ink-secondary">{formatDate(memory.updatedAt)}</dd>
        </div>
      </dl>
    </div>
  );
}

function MemoryForm({ screen, useMemoryFacts }: {
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
  const valid = memoryDraftIsValid(draft);
  const statementInvalid = draft.statement.trim().length === 0 ||
    draft.statement.length > MEMORY_CONSUMER_STATEMENT_MAX_LENGTH;
  const errorText = mutationErrorText(mutationError);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    if (!valid) return;
    void (creating ? saveNewMemory(useMemoryFacts) : saveMemoryChanges()).catch(() => undefined);
  };

  return (
    <div>
      <button className={`${quietButton} -ml-2 md:hidden`} onClick={cancelMemoryDraft} type="button">
        <ArrowLeft className="size-4" aria-hidden="true" />
        {t("manager.backToList")}
      </button>
      <h3 className="mt-1 text-base font-semibold text-ink md:mt-0" data-memory-screen-heading tabIndex={-1}>
        {creating ? t("manager.createTitle") : t("manager.editTitle")}
      </h3>
      {draftStale ? (
        <div className="mt-3 flex items-start gap-2 border-y border-caution/35 bg-caution/10 px-3 py-2 text-sm leading-5 text-ink-secondary" role="alert">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-caution" aria-hidden="true" />
          {t("manager.draftStale")}
        </div>
      ) : null}
      {errorText && !draftStale ? <p className="mt-3 text-sm text-critical" role="alert">{errorText}</p> : null}
      <form className="mt-5 space-y-5" onSubmit={submit} noValidate>
        <div>
          <label className="text-sm font-semibold text-ink" htmlFor="memory-statement">{t("manager.statement")}</label>
          <textarea
            className={`mt-2 min-h-36 w-full resize-y rounded-control border bg-control-surface px-3 py-2 text-sm leading-6 text-ink placeholder:text-ink-disabled ${statementInvalid && attempted ? "border-critical" : "border-trace-subtle"} ${focusRing}`}
            id="memory-statement"
            maxLength={MEMORY_CONSUMER_STATEMENT_MAX_LENGTH}
            value={draft.statement}
            aria-invalid={statementInvalid && attempted || undefined}
            aria-describedby="memory-statement-help memory-statement-count memory-statement-classification"
            onChange={(event) => setDraft({ statement: event.target.value })}
          />
          <div className="mt-1 flex items-start justify-between gap-3 text-xs leading-5 text-ink-muted">
            <p id="memory-statement-help">{t("manager.statementHelp")}</p>
            <span className="shrink-0 font-mono" id="memory-statement-count">{draft.statement.length}/{MEMORY_CONSUMER_STATEMENT_MAX_LENGTH}</span>
          </div>
          <p className="mt-1 text-xs leading-5 text-ink-muted" id="memory-statement-classification">{t("manager.formAutomaticClassification")}</p>
          {statementInvalid && attempted ? <p className="mt-1 text-xs text-critical" role="alert">{t("manager.validationStatement")}</p> : null}
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-trace-subtle pt-4">
          <button className={secondaryButton} disabled={mutationState !== null} onClick={cancelMemoryDraft} type="button">{t("manager.cancel")}</button>
          <button className={primaryButton} disabled={mutationState !== null} type="submit">
            {mutationState === "saving" ? t("manager.saving") : creating ? t("manager.saveNew") : t("manager.saveChanges")}
          </button>
        </div>
      </form>
    </div>
  );
}

function DetailPane({ screen, useMemoryFacts }: { screen: MemoryManagerScreen; useMemoryFacts: boolean }) {
  if (screen === "create" || screen === "edit") return <MemoryForm screen={screen} useMemoryFacts={useMemoryFacts} />;
  return <MemoryDetail />;
}

export function ManageMemories({
  accountId,
  onBack,
  onBusyChange,
  onDirtyChange,
  useMemoryFacts
}: {
  accountId: string;
  onBack(): void;
  onBusyChange?(busy: boolean): void;
  onDirtyChange?(dirty: boolean): void;
  useMemoryFacts: boolean;
}) {
  const draftDirty = useMemoryManagerStore((state) => state.draftDirty);
  const mutationState = useMemoryManagerStore((state) => state.mutationState);
  const screen = useMemoryManagerStore((state) => state.screen);
  const [exitConfirmation, setExitConfirmation] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
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

  const requestBack = () => {
    if (draftDirty) {
      setExitConfirmation(true);
      return;
    }
    onBack();
  };

  return (
    <div ref={rootRef} className="mx-auto w-full max-w-5xl" data-testid="manage-memories">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-trace-subtle pb-4">
        <div className="min-w-0">
          <button className={`${quietButton} -ml-2`} disabled={mutationState !== null} onClick={requestBack} type="button">
            <ArrowLeft className="size-4" aria-hidden="true" />
            {t("manager.back")}
          </button>
          <h2 className="mt-1 text-lg font-semibold text-ink" data-memory-screen-heading={screen === "list" ? "" : undefined} tabIndex={screen === "list" ? -1 : undefined}>
            {t("manager.title")}
          </h2>
        </div>
        <button className={primaryButton} disabled={mutationState !== null || draftDirty} onClick={beginCreateMemory} type="button">
          <Plus className="size-4" aria-hidden="true" />
          {t("manager.new")}
        </button>
      </header>

      {exitConfirmation ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-y border-caution/35 bg-caution/10 px-3 py-3" role="alert">
          <div>
            <p className="text-sm font-semibold text-ink">{t("manager.discardTitle")}</p>
            <p className="mt-1 text-xs leading-5 text-ink-secondary">{t("manager.discardBody")}</p>
          </div>
          <div className="flex gap-2">
            <button className={secondaryButton} onClick={() => setExitConfirmation(false)} type="button">{t("manager.keepEditing")}</button>
            <button className={destructiveButton} type="button" onClick={() => { cancelMemoryDraft(); setExitConfirmation(false); onBack(); }}>
              {t("manager.discardDraft")}
            </button>
          </div>
        </div>
      ) : null}

      <div className="mt-4"><LiveNotice /></div>
      <div className={`mt-4 border-y border-trace-subtle md:grid md:grid-cols-[minmax(15rem,0.85fr)_minmax(0,1.15fr)]`}>
        <div className={screen === "list" ? "block" : "hidden md:block"} inert={draftDirty || undefined}>
          <MemoryListPane />
        </div>
        <div className={`${screen === "list" ? "hidden md:block" : "block"} min-w-0 p-4 sm:p-5`} data-testid="memory-detail-pane">
          <DetailPane screen={screen} useMemoryFacts={useMemoryFacts} />
        </div>
      </div>
    </div>
  );
}
