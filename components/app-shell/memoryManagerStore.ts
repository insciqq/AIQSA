import {
  createMemory,
  forgetMemory,
  listMemories,
  MemoryApiError,
  memoryMutationOutcomeIsUnknown,
  searchMemories,
  updateMemory
} from "@/components/app-shell/memoryApi";
import {
  MEMORY_CONSUMER_STATEMENT_MAX_LENGTH,
  type MemoryConsumerItem,
  type MemoryConsumerListInput
} from "@/lib/contracts/memoryConsumer";
import { create } from "zustand";

export type MemoryManagerScreen = "create" | "detail" | "edit" | "forget" | "list";
export type MemoryManagerLoadState = "error" | "idle" | "loading" | "ready";
export type MemoryManagerMutationState = "forgetting" | "saving" | null;
export type MemoryManagerNotice = "forgotten" | "saved" | "saved_use_off" | null;
export type MemoryManagerCategoryFilter = MemoryConsumerListInput["category"] | "ALL";
export type MemoryManagerProvenanceFilter = MemoryConsumerListInput["provenance"] | "ALL";

export type MemoryDraft = Readonly<{ statement: string }>;

type MemoryManagerStore = {
  accountId: string | null;
  activeMemory: MemoryConsumerItem | null;
  categoryFilter: MemoryManagerCategoryFilter;
  draft: MemoryDraft;
  draftDirty: boolean;
  draftStale: boolean;
  listError: string | null;
  listLoadState: MemoryManagerLoadState;
  memories: MemoryConsumerItem[];
  mutationError: string | null;
  mutationOutcomeUnknown: boolean;
  mutationState: MemoryManagerMutationState;
  nextCursor: string | null;
  notice: MemoryManagerNotice;
  provenanceFilter: MemoryManagerProvenanceFilter;
  queryApplied: string;
  queryInput: string;
  resetPending: boolean;
  screen: MemoryManagerScreen;
  setDraft(patch: Partial<MemoryDraft>): void;
  setCategoryFilter(value: MemoryManagerCategoryFilter): void;
  setProvenanceFilter(value: MemoryManagerProvenanceFilter): void;
  setQueryInput(value: string): void;
};

const emptyDraft: MemoryDraft = { statement: "" };

const initialState: Omit<
  MemoryManagerStore,
  "setCategoryFilter" | "setDraft" | "setProvenanceFilter" | "setQueryInput"
> = {
  accountId: null,
  activeMemory: null,
  categoryFilter: "ALL",
  draft: emptyDraft,
  draftDirty: false,
  draftStale: false,
  listError: null,
  listLoadState: "idle",
  memories: [],
  mutationError: null,
  mutationOutcomeUnknown: false,
  mutationState: null,
  nextCursor: null,
  notice: null,
  provenanceFilter: "ALL",
  queryApplied: "",
  queryInput: "",
  resetPending: false,
  screen: "list"
};

export const useMemoryManagerStore = create<MemoryManagerStore>((set) => ({
  ...initialState,
  setDraft(patch) {
    set((state) => ({
      draft: { ...state.draft, ...patch },
      draftDirty: true,
      draftStale: false,
      mutationError: state.mutationOutcomeUnknown ? state.mutationError : null,
      notice: null
    }));
  },
  setCategoryFilter(categoryFilter) {
    set({ categoryFilter });
  },
  setProvenanceFilter(provenanceFilter) {
    set({ provenanceFilter });
  },
  setQueryInput(queryInput) {
    set({ queryInput });
  }
}));

let listRequestGeneration = 0;
let lifecycleGeneration = 0;

function holdsDraft(screen: MemoryManagerScreen): boolean {
  return screen === "create" || screen === "edit" || screen === "forget";
}

function retainDraftList(): void {
  // Opaque references can rotate on a read. Do not replace the row underneath
  // an editor with a late response from before that editor opened.
  listRequestGeneration += 1;
  if (useMemoryManagerStore.getState().listLoadState === "loading") {
    useMemoryManagerStore.setState({ listLoadState: "ready" });
  }
}

function errorName(error: unknown): string {
  return error instanceof MemoryApiError || error instanceof Error
    ? error.message
    : "memory_action_failed";
}

function uniqueItems(items: readonly MemoryConsumerItem[]): MemoryConsumerItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.memoryRef)) return false;
    seen.add(item.memoryRef);
    return true;
  });
}

function draftFromMemory(memory: MemoryConsumerItem): MemoryDraft {
  return { statement: memory.statement };
}

export function memoryDraftIsValid(draft: MemoryDraft): boolean {
  return draft.statement.trim().length > 0 &&
    draft.statement.length <= MEMORY_CONSUMER_STATEMENT_MAX_LENGTH;
}

export async function refreshMemoryList(
  options: Readonly<{ append?: boolean; appliedQuery?: string }> = {}
): Promise<void> {
  const current = useMemoryManagerStore.getState();
  if (current.resetPending || current.mutationState || holdsDraft(current.screen)) return;
  const generation = ++listRequestGeneration;
  const append = options.append === true;
  const queryApplied = options.appliedQuery ?? current.queryApplied;
  const filters = {
    ...(current.categoryFilter === "ALL"
      ? {}
      : { category: current.categoryFilter }),
    ...(current.provenanceFilter === "ALL"
      ? {}
      : { provenance: current.provenanceFilter })
  };
  const cursor = append ? current.nextCursor : null;
  useMemoryManagerStore.setState({
    listError: null,
    listLoadState: "loading",
    ...(append ? {} : { queryApplied })
  });
  try {
    const response = queryApplied
      ? await searchMemories(queryApplied, cursor, undefined, filters)
      : await listMemories(cursor, undefined, filters);
    if (generation !== listRequestGeneration) return;
    useMemoryManagerStore.setState((state) => ({
      listError: null,
      listLoadState: "ready",
      memories: uniqueItems(append ? [...state.memories, ...response.items] : response.items),
      ...(!append && state.mutationOutcomeUnknown
        ? { mutationError: null, mutationOutcomeUnknown: false }
        : {}),
      nextCursor: response.nextCursor
    }));
  } catch (error) {
    if (generation !== listRequestGeneration) return;
    useMemoryManagerStore.setState({
      listError: errorName(error),
      listLoadState: "error"
    });
    throw error;
  }
}

export async function applyMemorySearch(): Promise<void> {
  const query = useMemoryManagerStore.getState().queryInput.trim();
  await refreshMemoryList({ appliedQuery: query });
}

export async function clearMemorySearch(): Promise<void> {
  useMemoryManagerStore.setState({ queryApplied: "", queryInput: "" });
  await refreshMemoryList({ appliedQuery: "" });
}

export function openMemoryDetail(memoryRef: string): void {
  if (useMemoryManagerStore.getState().resetPending) return;
  const memory = useMemoryManagerStore.getState().memories.find(
    (item) => item.memoryRef === memoryRef
  ) ?? null;
  if (!memory) return;
  useMemoryManagerStore.setState({
    activeMemory: memory,
    draft: draftFromMemory(memory),
    draftDirty: false,
    draftStale: false,
    mutationError: null,
    notice: null,
    screen: "detail"
  });
}

export function showMemoryList(): void {
  useMemoryManagerStore.setState({
    activeMemory: null,
    draft: emptyDraft,
    draftDirty: false,
    draftStale: false,
    mutationError: null,
    screen: "list"
  });
}

export function beginCreateMemory(): void {
  if (useMemoryManagerStore.getState().resetPending) return;
  if (useMemoryManagerStore.getState().mutationOutcomeUnknown) return;
  retainDraftList();
  useMemoryManagerStore.setState({
    activeMemory: null,
    draft: emptyDraft,
    draftDirty: false,
    draftStale: false,
    mutationError: null,
    notice: null,
    screen: "create"
  });
}

export function beginEditMemory(): void {
  if (useMemoryManagerStore.getState().resetPending) return;
  const { activeMemory: memory, mutationOutcomeUnknown } = useMemoryManagerStore.getState();
  if (mutationOutcomeUnknown || !memory || !memory.allowedActions.includes("EDIT")) return;
  retainDraftList();
  useMemoryManagerStore.setState({
    draft: draftFromMemory(memory),
    draftDirty: false,
    draftStale: false,
    mutationError: null,
    screen: "edit"
  });
}

export function requestForgetMemory(memoryRef: string): void {
  if (useMemoryManagerStore.getState().resetPending) return;
  if (useMemoryManagerStore.getState().mutationOutcomeUnknown) return;
  const memory = useMemoryManagerStore.getState().memories.find(
    (item) => item.memoryRef === memoryRef
  );
  if (!memory?.allowedActions.includes("FORGET")) return;
  retainDraftList();
  useMemoryManagerStore.setState({
    activeMemory: memory,
    draft: draftFromMemory(memory),
    draftDirty: false,
    draftStale: false,
    mutationError: null,
    notice: null,
    screen: "forget"
  });
}

export function cancelMemoryDraft(): void {
  const { activeMemory: memory, mutationError, mutationOutcomeUnknown } = useMemoryManagerStore.getState();
  useMemoryManagerStore.setState({
    draft: memory ? draftFromMemory(memory) : emptyDraft,
    draftDirty: false,
    draftStale: false,
    mutationError: mutationOutcomeUnknown ? mutationError : null,
    screen: memory ? "detail" : "list"
  });
  if (mutationOutcomeUnknown) void refreshMemoryList().catch(() => undefined);
}

export function discardMemoryManagerDraft(): void {
  cancelMemoryDraft();
}

export async function saveNewMemory(useMemoryFacts: boolean): Promise<void> {
  if (useMemoryManagerStore.getState().resetPending) return;
  const { draft, mutationState, mutationOutcomeUnknown } = useMemoryManagerStore.getState();
  if (mutationState || mutationOutcomeUnknown || !memoryDraftIsValid(draft)) return;
  const generation = lifecycleGeneration;
  listRequestGeneration += 1;
  useMemoryManagerStore.setState({ mutationError: null, mutationState: "saving" });
  try {
    const response = await createMemory(draft.statement);
    if (generation !== lifecycleGeneration) return;
    useMemoryManagerStore.setState((state) => ({
      activeMemory: response.item,
      draft: draftFromMemory(response.item),
      draftDirty: false,
      draftStale: false,
      memories: uniqueItems([response.item, ...state.memories]),
      mutationError: null,
      mutationState: null,
      notice: useMemoryFacts ? "saved" : "saved_use_off",
      screen: "detail"
    }));
    await refreshMemoryList().catch(() => undefined);
  } catch (error) {
    if (generation !== lifecycleGeneration) return;
    useMemoryManagerStore.setState({
      mutationError: errorName(error), mutationOutcomeUnknown: memoryMutationOutcomeIsUnknown(error),
      mutationState: null
    });
    throw error;
  }
}

export async function saveMemoryChanges(): Promise<void> {
  if (useMemoryManagerStore.getState().resetPending) return;
  const { activeMemory, draft, mutationState, mutationOutcomeUnknown } = useMemoryManagerStore.getState();
  if (mutationState || mutationOutcomeUnknown || !activeMemory || !memoryDraftIsValid(draft) ||
    !activeMemory.allowedActions.includes("EDIT")) return;
  const generation = lifecycleGeneration;
  listRequestGeneration += 1;
  useMemoryManagerStore.setState({ mutationError: null, mutationState: "saving" });
  try {
    const response = await updateMemory(activeMemory.memoryRef, draft.statement);
    if (generation !== lifecycleGeneration) return;
    useMemoryManagerStore.setState((state) => ({
      activeMemory: response.item,
      draft: draftFromMemory(response.item),
      draftDirty: false,
      draftStale: false,
      memories: state.memories.map((item) =>
        item.memoryRef === activeMemory.memoryRef ? response.item : item
      ),
      mutationError: null,
      mutationState: null,
      notice: "saved",
      screen: "detail"
    }));
    // The current search, pagination and opaque refs belong to the server.
    // A failed read remains a list error, never a failed committed mutation.
    await refreshMemoryList().catch(() => undefined);
  } catch (error) {
    if (generation !== lifecycleGeneration) return;
    const code = errorName(error);
    useMemoryManagerStore.setState({
      draftStale: code === "memory_changed",
      mutationError: code,
      mutationOutcomeUnknown: memoryMutationOutcomeIsUnknown(error),
      mutationState: null
    });
    throw error;
  }
}

export async function forgetCurrentMemory(): Promise<void> {
  if (useMemoryManagerStore.getState().resetPending) return;
  const { activeMemory: memory, mutationState, mutationOutcomeUnknown } = useMemoryManagerStore.getState();
  if (mutationState || mutationOutcomeUnknown || !memory || !memory.allowedActions.includes("FORGET")) return;
  const generation = lifecycleGeneration;
  listRequestGeneration += 1;
  useMemoryManagerStore.setState({ mutationError: null, mutationState: "forgetting" });
  try {
    await forgetMemory(memory.memoryRef);
    if (generation !== lifecycleGeneration) return;
    useMemoryManagerStore.setState((state) => ({
      activeMemory: null,
      draft: emptyDraft,
      draftDirty: false,
      memories: state.memories.filter((item) => item.memoryRef !== memory.memoryRef),
      mutationError: null,
      mutationState: null,
      notice: "forgotten",
      screen: "list"
    }));
    await refreshMemoryList().catch(() => undefined);
  } catch (error) {
    if (generation !== lifecycleGeneration) return;
    useMemoryManagerStore.setState({
      mutationError: errorName(error), mutationOutcomeUnknown: memoryMutationOutcomeIsUnknown(error),
      mutationState: null
    });
    throw error;
  }
}

export async function openMemoryManager(accountId: string): Promise<void> {
  const current = useMemoryManagerStore.getState();
  if (current.accountId !== accountId) {
    lifecycleGeneration += 1;
    listRequestGeneration += 1;
    useMemoryManagerStore.setState({
      ...useMemoryManagerStore.getInitialState(),
      accountId
    }, true);
  }
  if (useMemoryManagerStore.getState().listLoadState === "idle") {
    await refreshMemoryList();
  }
}

export function invalidateMemoryManagerData(accountId?: string | null, resetPending = false): void {
  const current = useMemoryManagerStore.getState();
  if (accountId !== undefined && current.accountId !== accountId) return;
  lifecycleGeneration += 1;
  listRequestGeneration += 1;
  useMemoryManagerStore.setState({
    ...initialState,
    accountId: current.accountId,
    resetPending
  });
}

export function deactivateMemoryManager(accountId?: string): void {
  const current = useMemoryManagerStore.getState();
  if (accountId && current.accountId !== accountId) return;
  lifecycleGeneration += 1;
  listRequestGeneration += 1;
  useMemoryManagerStore.setState(useMemoryManagerStore.getInitialState(), true);
}
