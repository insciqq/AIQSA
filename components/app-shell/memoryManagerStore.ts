import {
  authorizeMemoryMutation,
  createMemory,
  forgetMemory,
  listMemories,
  loadMemory,
  loadMemoryDeletionStatus,
  loadMemoryEvidence,
  MemoryApiError,
  memoryStatementHash,
  searchMemories,
  startExplicitMemoryDeletion,
  updateMemory
} from "@/components/app-shell/memoryApi";
import { refreshMemorySettings } from "@/components/app-shell/memorySettingsStore";
import {
  MEMORY_STATEMENT_MAX_LENGTH,
  type MemoryDeletionStatus,
  type MemoryEvidenceItem,
  type MemoryModality,
  type MemorySummary
} from "@/lib/contracts/memory";
import { create } from "zustand";

export type MemoryManagerScreen =
  | "create"
  | "delete"
  | "detail"
  | "edit"
  | "forget"
  | "list";
export type MemoryManagerLoadState = "error" | "idle" | "loading" | "ready";
export type MemoryManagerMutationState =
  | "deleting"
  | "forgetting"
  | "pinning"
  | "saving"
  | null;
export type MemoryManagerNotice =
  | "forgotten"
  | "saved"
  | "saved_use_off"
  | null;

export type MemoryDraft = {
  category: string;
  modality: MemoryModality;
  statement: string;
};

type MemoryManagerStore = {
  activeMemory: MemorySummary | null;
  deletionError: string | null;
  deletionLoadState: MemoryManagerLoadState;
  deletionStatus: MemoryDeletionStatus | null;
  detailError: string | null;
  detailLoadState: MemoryManagerLoadState;
  draft: MemoryDraft;
  draftDirty: boolean;
  draftStale: boolean;
  evidence: MemoryEvidenceItem[];
  evidenceError: string | null;
  evidenceLoadState: MemoryManagerLoadState;
  evidenceNextCursor: string | null;
  listError: string | null;
  listLoadState: MemoryManagerLoadState;
  memories: MemorySummary[];
  mutationError: string | null;
  mutationState: MemoryManagerMutationState;
  nextCursor: string | null;
  notice: MemoryManagerNotice;
  queryApplied: string;
  queryInput: string;
  screen: MemoryManagerScreen;
  setDraft(patch: Partial<MemoryDraft>): void;
  setQueryInput(value: string): void;
};

const emptyDraft: MemoryDraft = {
  category: "",
  modality: "STATE",
  statement: ""
};

const initialState: Omit<MemoryManagerStore, "setDraft" | "setQueryInput"> = {
  activeMemory: null,
  deletionError: null,
  deletionLoadState: "idle",
  deletionStatus: null,
  detailError: null,
  detailLoadState: "idle",
  draft: emptyDraft,
  draftDirty: false,
  draftStale: false,
  evidence: [],
  evidenceError: null,
  evidenceLoadState: "idle",
  evidenceNextCursor: null,
  listError: null,
  listLoadState: "idle",
  memories: [],
  mutationError: null,
  mutationState: null,
  nextCursor: null,
  notice: null,
  queryApplied: "",
  queryInput: "",
  screen: "list"
};

export const useMemoryManagerStore = create<MemoryManagerStore>((set) => ({
  ...initialState,
  setDraft(patch) {
    set((state) => ({
      draft: { ...state.draft, ...patch },
      draftDirty: true,
      draftStale: false,
      mutationError: null,
      notice: null
    }));
  },
  setQueryInput(queryInput) {
    set({ queryInput });
  }
}));

let listRequestGeneration = 0;
let detailRequestGeneration = 0;
let evidenceRequestGeneration = 0;
const deletionStorageKey = "aiqsa:memory:explicit-deletion-id";

function errorName(error: unknown): string {
  return error instanceof MemoryApiError || error instanceof Error
    ? error.message
    : "memory_action_failed";
}

function uniqueMemories(memories: readonly MemorySummary[]): MemorySummary[] {
  const seen = new Set<string>();
  return memories.filter((memory) => {
    if (seen.has(memory.id)) return false;
    seen.add(memory.id);
    return true;
  });
}

function draftFromMemory(memory: MemorySummary): MemoryDraft {
  return {
    category: memory.category,
    modality: memory.modality,
    statement: memory.displayText ?? ""
  };
}

function storedDeletionId(): string | null {
  if (typeof window === "undefined") return null;
  const value = window.sessionStorage.getItem(deletionStorageKey);
  return value && value.length <= 256 && !/[\u0000-\u0020\u007f]/u.test(value)
    ? value
    : null;
}

function rememberDeletion(status: MemoryDeletionStatus): void {
  if (typeof window === "undefined") return;
  if (status.state === "SUCCEEDED") {
    window.sessionStorage.removeItem(deletionStorageKey);
  } else {
    window.sessionStorage.setItem(deletionStorageKey, status.deletionId);
  }
}

export function memoryDraftIsValid(draft: MemoryDraft, creating: boolean): boolean {
  if (draft.statement.trim().length === 0 || draft.statement.length > MEMORY_STATEMENT_MAX_LENGTH) {
    return false;
  }
  return creating && draft.category.trim().length === 0
    ? true
    : /^[a-z][a-z0-9_-]{0,63}$/u.test(draft.category.trim());
}

export async function refreshMemoryList(
  options: Readonly<{ append?: boolean; appliedQuery?: string }> = {}
): Promise<void> {
  const generation = ++listRequestGeneration;
  const current = useMemoryManagerStore.getState();
  const append = options.append === true;
  const queryApplied = options.appliedQuery ?? current.queryApplied;
  const cursor = append ? current.nextCursor : null;
  useMemoryManagerStore.setState({
    listError: null,
    listLoadState: "loading",
    ...(append ? {} : { queryApplied })
  });
  try {
    const response = queryApplied
      ? await searchMemories(queryApplied, cursor)
      : await listMemories(cursor);
    if (generation !== listRequestGeneration) return;
    useMemoryManagerStore.setState((state) => ({
      listError: null,
      listLoadState: "ready",
      memories: uniqueMemories(append ? [...state.memories, ...response.memories] : response.memories),
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

async function loadEvidence(memoryId: string, append = false): Promise<void> {
  const generation = ++evidenceRequestGeneration;
  const current = useMemoryManagerStore.getState();
  const cursor = append ? current.evidenceNextCursor : null;
  useMemoryManagerStore.setState({ evidenceError: null, evidenceLoadState: "loading" });
  try {
    const response = await loadMemoryEvidence(memoryId, cursor);
    if (
      generation !== evidenceRequestGeneration ||
      useMemoryManagerStore.getState().activeMemory?.id !== memoryId
    ) return;
    useMemoryManagerStore.setState((state) => ({
      evidence: append ? [...state.evidence, ...response.evidence] : response.evidence,
      evidenceError: null,
      evidenceLoadState: "ready",
      evidenceNextCursor: response.nextCursor
    }));
  } catch (error) {
    if (generation !== evidenceRequestGeneration) return;
    useMemoryManagerStore.setState({
      evidenceError: errorName(error),
      evidenceLoadState: "error"
    });
    if (!append) throw error;
  }
}

export async function openMemoryDetail(memoryId: string): Promise<void> {
  const generation = ++detailRequestGeneration;
  evidenceRequestGeneration += 1;
  const listed = useMemoryManagerStore.getState().memories.find((item) => item.id === memoryId) ?? null;
  useMemoryManagerStore.setState({
    activeMemory: listed,
    detailError: null,
    detailLoadState: "loading",
    draft: listed ? draftFromMemory(listed) : emptyDraft,
    draftDirty: false,
    draftStale: false,
    evidence: [],
    evidenceError: null,
    evidenceLoadState: "loading",
    evidenceNextCursor: null,
    mutationError: null,
    notice: null,
    screen: "detail"
  });
  const evidencePromise = loadEvidence(memoryId).catch(() => undefined);
  try {
    const response = await loadMemory(memoryId);
    if (generation !== detailRequestGeneration) return;
    useMemoryManagerStore.setState({
      activeMemory: response.memory,
      detailError: null,
      detailLoadState: "ready",
      draft: draftFromMemory(response.memory),
      draftDirty: false,
      draftStale: false
    });
  } catch (error) {
    if (generation !== detailRequestGeneration) return;
    useMemoryManagerStore.setState({
      detailError: errorName(error),
      detailLoadState: "error"
    });
    throw error;
  } finally {
    await evidencePromise;
  }
}

export async function loadMoreMemoryEvidence(): Promise<void> {
  const memoryId = useMemoryManagerStore.getState().activeMemory?.id;
  if (!memoryId) return;
  await loadEvidence(memoryId, true);
}

export function showMemoryList(): void {
  detailRequestGeneration += 1;
  evidenceRequestGeneration += 1;
  useMemoryManagerStore.setState({
    activeMemory: null,
    detailError: null,
    detailLoadState: "idle",
    draft: emptyDraft,
    draftDirty: false,
    draftStale: false,
    evidence: [],
    evidenceError: null,
    evidenceLoadState: "idle",
    evidenceNextCursor: null,
    mutationError: null,
    screen: "list"
  });
}

export function beginCreateMemory(): void {
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
  const memory = useMemoryManagerStore.getState().activeMemory;
  if (!memory) return;
  useMemoryManagerStore.setState({
    draft: draftFromMemory(memory),
    draftDirty: false,
    draftStale: false,
    mutationError: null,
    screen: "edit"
  });
}

export function cancelMemoryDraft(): void {
  const memory = useMemoryManagerStore.getState().activeMemory;
  useMemoryManagerStore.setState({
    draft: memory ? draftFromMemory(memory) : emptyDraft,
    draftDirty: false,
    draftStale: false,
    mutationError: null,
    screen: memory ? "detail" : "list"
  });
}

export function discardMemoryManagerDraft(): void {
  cancelMemoryDraft();
}

export async function saveNewMemory(useMemoryFacts: boolean): Promise<void> {
  const draft = useMemoryManagerStore.getState().draft;
  if (!memoryDraftIsValid(draft, true)) return;
  useMemoryManagerStore.setState({ mutationError: null, mutationState: "saving" });
  try {
    const exactStatementHash = await memoryStatementHash(draft.statement);
    const authorization = await authorizeMemoryMutation({ action: "SAVE", exactStatementHash });
    const response = await createMemory({
      ...(draft.category.trim() ? { category: draft.category.trim() } : {}),
      modality: draft.modality,
      mutationAuthorizationId: authorization.mutationAuthorizationId,
      scope: { type: "GLOBAL_USER" },
      statement: draft.statement
    });
    useMemoryManagerStore.setState((state) => ({
      activeMemory: response.memory,
      draft: draftFromMemory(response.memory),
      draftDirty: false,
      draftStale: false,
      memories: uniqueMemories([response.memory, ...state.memories]),
      mutationError: null,
      mutationState: null,
      notice: useMemoryFacts ? "saved" : "saved_use_off",
      screen: "detail"
    }));
    void loadEvidence(response.memory.id).catch(() => undefined);
  } catch (error) {
    useMemoryManagerStore.setState({ mutationError: errorName(error), mutationState: null });
    throw error;
  }
}

async function reconcileCurrentMemoryKeepingDraft(memoryId: string): Promise<void> {
  const draft = useMemoryManagerStore.getState().draft;
  try {
    const response = await loadMemory(memoryId);
    useMemoryManagerStore.setState((state) => ({
      activeMemory: response.memory,
      draft,
      draftDirty: true,
      draftStale: true,
      memories: state.memories.map((memory) =>
        memory.id === response.memory.id ? response.memory : memory
      ),
      screen: "edit"
    }));
    void loadEvidence(memoryId).catch(() => undefined);
  } catch {
    useMemoryManagerStore.setState({ draft, draftDirty: true, draftStale: true, screen: "edit" });
  }
}

export async function saveMemoryChanges(): Promise<void> {
  const { activeMemory, draft } = useMemoryManagerStore.getState();
  if (!activeMemory?.currentVersionId || !memoryDraftIsValid(draft, false)) return;
  useMemoryManagerStore.setState({ mutationError: null, mutationState: "saving" });
  try {
    const authorization = await authorizeMemoryMutation({
      action: "EDIT",
      expectedTargetVersionId: activeMemory.currentVersionId,
      targetFactId: activeMemory.id
    });
    const response = await updateMemory(activeMemory.id, {
      category: draft.category.trim(),
      expectedVersionId: activeMemory.currentVersionId,
      modality: draft.modality,
      mutationAuthorizationId: authorization.mutationAuthorizationId,
      statement: draft.statement
    });
    useMemoryManagerStore.setState((state) => ({
      activeMemory: response.memory,
      draft: draftFromMemory(response.memory),
      draftDirty: false,
      draftStale: false,
      memories: state.memories.map((memory) =>
        memory.id === response.memory.id ? response.memory : memory
      ),
      mutationError: null,
      mutationState: null,
      notice: "saved",
      screen: "detail"
    }));
    void loadEvidence(response.memory.id).catch(() => undefined);
  } catch (error) {
    const code = errorName(error);
    useMemoryManagerStore.setState({ mutationError: code, mutationState: null });
    if (error instanceof MemoryApiError && error.code === "memory_version_stale") {
      await reconcileCurrentMemoryKeepingDraft(activeMemory.id);
    }
    throw error;
  }
}

export async function toggleMemoryPinned(): Promise<void> {
  const memory = useMemoryManagerStore.getState().activeMemory;
  if (!memory?.currentVersionId) return;
  useMemoryManagerStore.setState({ mutationError: null, mutationState: "pinning" });
  try {
    const authorization = await authorizeMemoryMutation({
      action: "EDIT",
      expectedTargetVersionId: memory.currentVersionId,
      targetFactId: memory.id
    });
    const response = await updateMemory(memory.id, {
      expectedVersionId: memory.currentVersionId,
      mutationAuthorizationId: authorization.mutationAuthorizationId,
      pinned: !memory.pinned
    });
    useMemoryManagerStore.setState((state) => ({
      activeMemory: response.memory,
      memories: state.memories.map((item) => item.id === response.memory.id ? response.memory : item),
      mutationError: null,
      mutationState: null
    }));
  } catch (error) {
    useMemoryManagerStore.setState({ mutationError: errorName(error), mutationState: null });
    if (error instanceof MemoryApiError && error.code === "memory_version_stale") {
      await openMemoryDetail(memory.id).catch(() => undefined);
    }
    throw error;
  }
}

export function beginForgetMemory(): void {
  if (!useMemoryManagerStore.getState().activeMemory) return;
  useMemoryManagerStore.setState({ mutationError: null, screen: "forget" });
}

export async function confirmForgetMemory(): Promise<void> {
  const memory = useMemoryManagerStore.getState().activeMemory;
  if (!memory?.currentVersionId) return;
  useMemoryManagerStore.setState({ mutationError: null, mutationState: "forgetting" });
  try {
    const authorization = await authorizeMemoryMutation({
      action: "FORGET",
      expectedTargetVersionId: memory.currentVersionId,
      targetFactId: memory.id
    });
    await forgetMemory(memory.id, {
      expectedVersionId: memory.currentVersionId,
      mutationAuthorizationId: authorization.mutationAuthorizationId
    });
    useMemoryManagerStore.setState((state) => ({
      activeMemory: null,
      memories: state.memories.filter((item) => item.id !== memory.id),
      mutationError: null,
      mutationState: null,
      notice: "forgotten",
      screen: "list"
    }));
    void refreshMemoryList().catch(() => undefined);
  } catch (error) {
    useMemoryManagerStore.setState({ mutationError: errorName(error), mutationState: null });
    if (error instanceof MemoryApiError && error.code === "memory_version_stale") {
      await openMemoryDetail(memory.id).catch(() => undefined);
    }
    throw error;
  }
}

export function beginDeleteExplicitMemories(): void {
  useMemoryManagerStore.setState({ deletionError: null, mutationError: null, screen: "delete" });
}

export async function confirmDeleteExplicitMemories(): Promise<void> {
  useMemoryManagerStore.setState({ deletionError: null, mutationState: "deleting" });
  try {
    const current = await refreshMemorySettings(true);
    const expectedMemoryRevision = current.settings.memoryRevision;
    const expectedSettingsRevision = current.settings.settingsRevision;
    const authorization = await authorizeMemoryMutation({
      action: "BULK_DELETE",
      expectedMemoryRevision,
      expectedSettingsRevision,
      operation: "DELETE_EXPLICIT"
    });
    const status = await startExplicitMemoryDeletion({
      expectedMemoryRevision,
      expectedSettingsRevision,
      mutationAuthorizationId: authorization.mutationAuthorizationId,
      operation: "DELETE_EXPLICIT"
    });
    rememberDeletion(status);
    useMemoryManagerStore.setState({
      activeMemory: null,
      deletionError: null,
      deletionLoadState: "ready",
      deletionStatus: status,
      memories: [],
      mutationState: null,
      nextCursor: null,
      screen: "delete"
    });
    await refreshMemorySettings(true).catch(() => undefined);
  } catch (error) {
    const code = errorName(error);
    useMemoryManagerStore.setState({ deletionError: code, mutationState: null });
    if (error instanceof MemoryApiError && error.code === "memory_version_stale") {
      await Promise.allSettled([refreshMemorySettings(true), refreshMemoryList()]);
    }
    throw error;
  }
}

export async function refreshMemoryDeletionStatus(
  deletionId = useMemoryManagerStore.getState().deletionStatus?.deletionId ?? storedDeletionId()
): Promise<void> {
  if (!deletionId) return;
  useMemoryManagerStore.setState({ deletionError: null, deletionLoadState: "loading" });
  try {
    const status = await loadMemoryDeletionStatus(deletionId);
    rememberDeletion(status);
    useMemoryManagerStore.setState({
      deletionError: null,
      deletionLoadState: "ready",
      deletionStatus: status
    });
    if (status.state === "SUCCEEDED") {
      await Promise.allSettled([refreshMemorySettings(true), refreshMemoryList()]);
    }
  } catch (error) {
    useMemoryManagerStore.setState({
      deletionError: errorName(error),
      deletionLoadState: "error"
    });
    throw error;
  }
}

export async function openMemoryManager(): Promise<void> {
  const current = useMemoryManagerStore.getState();
  useMemoryManagerStore.setState({
    screen: current.draftDirty ? current.activeMemory ? "edit" : "create" : "list"
  });
  const requests: Promise<unknown>[] = [];
  if (useMemoryManagerStore.getState().listLoadState === "idle") {
    requests.push(refreshMemoryList());
  }
  const deletionId = storedDeletionId();
  if (deletionId) requests.push(refreshMemoryDeletionStatus(deletionId));
  await Promise.allSettled(requests);
}

export function resetMemoryManagerStoreForTest(): void {
  listRequestGeneration += 1;
  detailRequestGeneration += 1;
  evidenceRequestGeneration += 1;
  if (typeof window !== "undefined") window.sessionStorage.removeItem(deletionStorageKey);
  useMemoryManagerStore.setState({
    ...initialState,
    draft: { ...emptyDraft }
  });
}
