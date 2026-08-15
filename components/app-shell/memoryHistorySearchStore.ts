import {
  MemoryHistorySearchApiError,
  searchMemoryHistory
} from "@/components/app-shell/memoryHistorySearchApi";
import {
  MEMORY_QUERY_MAX_LENGTH,
  type MemoryHistorySearchInput,
  type MemoryHistorySearchResponse
} from "@/lib/contracts/memory";
import { create } from "zustand";

export type MemoryHistorySearchLoadState =
  | "cancelled"
  | "error"
  | "idle"
  | "loading"
  | "ready";

export type MemoryHistorySearchDraft = Readonly<{
  chatId: string | null;
  folderId: string | null;
  fromDate: string;
  query: string;
  throughDate: string;
}>;

type AppliedSearch = Omit<MemoryHistorySearchInput, "cursor">;

type MemoryHistorySearchStore = {
  accountId: string | null;
  applied: AppliedSearch | null;
  draft: MemoryHistorySearchDraft;
  error: string | null;
  indexing: MemoryHistorySearchResponse["indexing"] | null;
  loadState: MemoryHistorySearchLoadState;
  nextCursor: string | null;
  results: MemoryHistorySearchResponse["results"];
  setChatId(value: string | null): void;
  setFolderId(value: string | null): void;
  setFromDate(value: string): void;
  setQuery(value: string): void;
  setThroughDate(value: string): void;
};

const emptyDraft: MemoryHistorySearchDraft = {
  chatId: null,
  folderId: null,
  fromDate: "",
  query: "",
  throughDate: ""
};

const emptyState = {
  accountId: null,
  applied: null,
  draft: emptyDraft,
  error: null,
  indexing: null,
  loadState: "idle" as const,
  nextCursor: null,
  results: []
};

export const useMemoryHistorySearchStore = create<MemoryHistorySearchStore>((set) => ({
  ...emptyState,
  setChatId(chatId) {
    set((state) => ({ draft: { ...state.draft, chatId }, error: null }));
  },
  setFolderId(folderId) {
    set((state) => ({ draft: { ...state.draft, folderId }, error: null }));
  },
  setFromDate(fromDate) {
    set((state) => ({ draft: { ...state.draft, fromDate }, error: null }));
  },
  setQuery(query) {
    set((state) => ({ draft: { ...state.draft, query }, error: null }));
  },
  setThroughDate(throughDate) {
    set((state) => ({ draft: { ...state.draft, throughDate }, error: null }));
  }
}));

let requestController: AbortController | null = null;
let requestGeneration = 0;

function accountState(accountId: string | null) {
  return {
    ...emptyState,
    accountId,
    draft: { ...emptyDraft },
    results: []
  };
}

function isValidAccountId(value: string): boolean {
  return value.trim() === value && value.length > 0 && value.length <= 256 &&
    !/[\u0000-\u0020\u007f]/u.test(value);
}

function abortActiveRequest(): void {
  requestGeneration += 1;
  requestController?.abort();
  requestController = null;
}

export function activateMemoryHistorySearchAccount(accountId: string): void {
  if (!isValidAccountId(accountId)) {
    abortActiveRequest();
    useMemoryHistorySearchStore.setState(accountState(null));
    return;
  }
  const current = useMemoryHistorySearchStore.getState();
  if (current.accountId === accountId) return;
  abortActiveRequest();
  // A private result cache has exactly one owner. Account transitions discard it.
  useMemoryHistorySearchStore.setState(accountState(accountId));
}

export function deactivateMemoryHistorySearchAccount(accountId?: string): void {
  const current = useMemoryHistorySearchStore.getState();
  if (accountId !== undefined && current.accountId !== accountId) return;
  abortActiveRequest();
  useMemoryHistorySearchStore.setState(accountState(null));
}

function isoStartOfDay(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value
    ? null
    : date.toISOString();
}

function isoDayAfter(value: string): string | null {
  const start = isoStartOfDay(value);
  if (!start) return null;
  const date = new Date(start);
  date.setUTCDate(date.getUTCDate() + 1);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function memoryHistoryInputFromDraft(
  draft: MemoryHistorySearchDraft
): Readonly<{ input: AppliedSearch } | { error: string }> {
  const query = draft.query.trim();
  if (query.length === 0 || query.length > MEMORY_QUERY_MAX_LENGTH) {
    return { error: "memory_history_query_invalid" };
  }
  const from = draft.fromDate ? isoStartOfDay(draft.fromDate) : null;
  const to = draft.throughDate ? isoDayAfter(draft.throughDate) : null;
  if ((draft.fromDate && !from) || (draft.throughDate && !to)) {
    return { error: "memory_history_interval_invalid" };
  }
  if (from && to && Date.parse(from) >= Date.parse(to)) {
    return { error: "memory_history_interval_invalid" };
  }
  return {
    input: {
      chatIds: draft.chatId ? [draft.chatId] : [],
      folderId: draft.folderId,
      from,
      pageSize: 20,
      query,
      to
    }
  };
}

function errorName(error: unknown): string {
  return error instanceof MemoryHistorySearchApiError || error instanceof Error
    ? error.message
    : "memory_action_failed";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function uniqueResults(
  results: MemoryHistorySearchResponse["results"]
): MemoryHistorySearchResponse["results"] {
  const keys = new Set<string>();
  return results.filter((result) => {
    const key = JSON.stringify([
      result.itemType,
      result.sourceChatId,
      result.sourceMessageIds,
      result.occurredAt,
      result.snippet
    ]);
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
}

async function runMemoryHistorySearch(append: boolean): Promise<void> {
  const current = useMemoryHistorySearchStore.getState();
  if (!current.accountId) return;
  const prepared = append
    ? current.applied ? { input: current.applied } as const : null
    : memoryHistoryInputFromDraft(current.draft);
  if (!prepared || "error" in prepared) {
    useMemoryHistorySearchStore.setState({
      error: prepared?.error ?? "memory_history_query_invalid",
      loadState: "error"
    });
    return;
  }
  const cursor = append ? current.nextCursor : null;
  if (append && !cursor) return;

  abortActiveRequest();
  const generation = requestGeneration;
  const controller = new AbortController();
  requestController = controller;
  const accountId = current.accountId;
  useMemoryHistorySearchStore.setState({
    ...(append ? {} : {
      applied: prepared.input,
      indexing: null,
      nextCursor: null,
      results: []
    }),
    error: null,
    loadState: "loading"
  });
  try {
    const response = await searchMemoryHistory({
      ...prepared.input,
      cursor
    }, controller.signal);
    const latest = useMemoryHistorySearchStore.getState();
    if (
      generation !== requestGeneration ||
      latest.accountId !== accountId ||
      controller.signal.aborted
    ) return;
    requestController = null;
    useMemoryHistorySearchStore.setState((state) => ({
      error: null,
      indexing: response.indexing,
      loadState: "ready",
      nextCursor: response.nextCursor,
      results: uniqueResults(append ? [...state.results, ...response.results] : response.results)
    }));
  } catch (error) {
    const latest = useMemoryHistorySearchStore.getState();
    if (generation !== requestGeneration || latest.accountId !== accountId) return;
    requestController = null;
    if (controller.signal.aborted || isAbortError(error)) {
      useMemoryHistorySearchStore.setState({ error: null, loadState: "cancelled" });
      return;
    }
    useMemoryHistorySearchStore.setState({
      error: errorName(error),
      loadState: "error"
    });
  }
}

export function applyMemoryHistorySearch(): Promise<void> {
  return runMemoryHistorySearch(false);
}

export function loadMoreMemoryHistorySearch(): Promise<void> {
  return runMemoryHistorySearch(true);
}

export function cancelMemoryHistorySearch(): void {
  const loading = useMemoryHistorySearchStore.getState().loadState === "loading";
  abortActiveRequest();
  if (loading) {
    useMemoryHistorySearchStore.setState({ error: null, loadState: "cancelled" });
  }
}

export function invalidateMemoryHistorySearchResults(accountId?: string): void {
  const current = useMemoryHistorySearchStore.getState();
  if (accountId !== undefined && current.accountId !== accountId) return;
  abortActiveRequest();
  useMemoryHistorySearchStore.setState({
    applied: null,
    error: null,
    indexing: null,
    loadState: "idle",
    nextCursor: null,
    results: []
  });
}
