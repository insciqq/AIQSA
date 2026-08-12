import {
  authorizeMemoryMutation,
  createMemory,
  forgetMemory,
  listMemories,
  loadMemory,
  loadMemoryDeletionStatus,
  loadMemoryEvidence,
  loadMemoryProfile,
  memoryRequestId,
  MemoryApiError,
  memoryStatementHash,
  recordMemoryFeedback,
  resolveMemoryConflict,
  searchMemories,
  startExplicitMemoryDeletion,
  undoForgetMemory,
  updateMemory
} from "@/components/app-shell/memoryApi";
import { refreshMemorySettings } from "@/components/app-shell/memorySettingsStore";
import {
  MEMORY_STATEMENT_MAX_LENGTH,
  type MemoryDetailResponse,
  type MemoryDeletionStatus,
  type MemoryFeedbackRecord,
  type MemoryFeedbackType,
  type MemoryForgetUndoDescriptor,
  type MemoryEvidenceItem,
  type MemoryFactState,
  type MemoryLifecycleHistoryItem,
  type MemoryModality,
  type MemoryProfileContributor,
  type MemoryProfileResponse,
  type MemoryScopeSelection,
  type MemorySummary,
  type MemoryVersionHistoryItem
} from "@/lib/contracts/memory";
import { create } from "zustand";

export type MemoryManagerScreen =
  | "create"
  | "delete"
  | "detail"
  | "edit"
  | "move"
  | "list";
export type MemoryManagerLoadState = "error" | "idle" | "loading" | "ready";
export type MemoryManagerMutationState =
  | "deleting"
  | "forgetting"
  | "pinning"
  | "moving"
  | "restoring"
  | "reviewing"
  | "resolving"
  | "saving"
  | null;
export type MemoryManagerNotice =
  | "feedback_recorded"
  | "feedback_retracted"
  | "forgotten"
  | "forget_restored"
  | "resolved"
  | "saved"
  | "saved_use_off"
  | null;

export type MemoryDraft = {
  category: string;
  modality: MemoryModality;
  scope: MemoryScopeSelection;
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
  factStateFilter: Exclude<MemoryFactState, "FORGOTTEN">;
  feedback: MemoryFeedbackRecord[];
  history: MemoryLifecycleHistoryItem[];
  lastFeedbackUndo: Readonly<{ feedbackId: string; versionId: string }> | null;
  lastForgetUndo: Readonly<{
    factId: string;
    statement: string;
    undo: MemoryForgetUndoDescriptor;
  }> | null;
  listError: string | null;
  listLoadState: MemoryManagerLoadState;
  memories: MemorySummary[];
  mutationError: string | null;
  mutationState: MemoryManagerMutationState;
  nextCursor: string | null;
  notice: MemoryManagerNotice;
  profileAccountId: string | null;
  profileError: string | null;
  profileLoadState: MemoryManagerLoadState;
  profileResponse: MemoryProfileResponse | null;
  queryApplied: string;
  queryInput: string;
  screen: MemoryManagerScreen;
  versions: MemoryVersionHistoryItem[];
  setDraft(patch: Partial<MemoryDraft>): void;
  setFactStateFilter(value: Exclude<MemoryFactState, "FORGOTTEN">): void;
  setQueryInput(value: string): void;
};

const emptyDraft: MemoryDraft = {
  category: "",
  modality: "STATE",
  scope: { type: "GLOBAL_USER" },
  statement: ""
};

const initialState: Omit<MemoryManagerStore, "setDraft" | "setFactStateFilter" | "setQueryInput"> = {
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
  factStateFilter: "ACTIVE",
  feedback: [],
  history: [],
  lastFeedbackUndo: null,
  lastForgetUndo: null,
  listError: null,
  listLoadState: "idle",
  memories: [],
  mutationError: null,
  mutationState: null,
  nextCursor: null,
  notice: null,
  profileAccountId: null,
  profileError: null,
  profileLoadState: "idle",
  profileResponse: null,
  queryApplied: "",
  queryInput: "",
  screen: "list",
  versions: []
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
  setFactStateFilter(factStateFilter) {
    set({ factStateFilter });
  },
  setQueryInput(queryInput) {
    set({ queryInput });
  }
}));

let listRequestGeneration = 0;
let detailRequestGeneration = 0;
let evidenceRequestGeneration = 0;
let profileRequestGeneration = 0;
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
    scope: memory.scope,
    statement: memory.displayText ?? ""
  };
}

function detailFields(response: MemoryDetailResponse) {
  return {
    activeMemory: response.memory,
    feedback: response.feedback,
    history: response.history,
    versions: response.versions
  };
}

async function reloadOpenMemoryDetail(memoryId: string): Promise<void> {
  const generation = ++detailRequestGeneration;
  const response = await loadMemory(memoryId);
  if (
    generation !== detailRequestGeneration ||
    useMemoryManagerStore.getState().activeMemory?.id !== memoryId
  ) return;
  useMemoryManagerStore.setState((state) => ({
    ...detailFields(response),
    draft: state.draftDirty ? state.draft : draftFromMemory(response.memory),
    memories: state.memories.map((memory) =>
      memory.id === response.memory.id ? response.memory : memory
    )
  }));
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
  if (["CANCELLED", "SUCCEEDED"].includes(status.state)) {
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
      ? await searchMemories(queryApplied, cursor, { state: current.factStateFilter })
      : await listMemories(cursor, { state: current.factStateFilter });
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

export async function refreshMemoryProfile(accountId: string): Promise<void> {
  const generation = ++profileRequestGeneration;
  useMemoryManagerStore.setState({
    profileAccountId: accountId,
    profileError: null,
    profileLoadState: "loading",
    profileResponse: null
  });
  try {
    const response = await loadMemoryProfile();
    if (
      generation !== profileRequestGeneration ||
      useMemoryManagerStore.getState().profileAccountId !== accountId
    ) return;
    useMemoryManagerStore.setState({
      profileError: null,
      profileLoadState: "ready",
      profileResponse: response
    });
  } catch (error) {
    if (
      generation !== profileRequestGeneration ||
      useMemoryManagerStore.getState().profileAccountId !== accountId
    ) return;
    useMemoryManagerStore.setState({
      profileError: errorName(error),
      profileLoadState: "error",
      profileResponse: null
    });
    throw error;
  }
}

function refreshOpenMemoryProfile(): void {
  const accountId = useMemoryManagerStore.getState().profileAccountId;
  if (accountId) void refreshMemoryProfile(accountId).catch(() => undefined);
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
    feedback: [],
    history: [],
    lastFeedbackUndo: null,
    mutationError: null,
    notice: null,
    screen: "detail",
    versions: []
  });
  const evidencePromise = loadEvidence(memoryId).catch(() => undefined);
  try {
    const response = await loadMemory(memoryId);
    if (generation !== detailRequestGeneration) return;
    useMemoryManagerStore.setState({
      ...detailFields(response),
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
    feedback: [],
    history: [],
    lastFeedbackUndo: null,
    mutationError: null,
    screen: "list",
    versions: []
  });
  refreshOpenMemoryProfile();
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

export function beginMoveMemory(): void {
  const memory = useMemoryManagerStore.getState().activeMemory;
  if (!memory?.actionVersionId && !memory?.currentVersionId) return;
  useMemoryManagerStore.setState({
    draft: draftFromMemory(memory),
    draftDirty: false,
    draftStale: false,
    mutationError: null,
    screen: "move"
  });
}

export async function changeMemoryFactState(
  factStateFilter: Exclude<MemoryFactState, "FORGOTTEN">
): Promise<void> {
  useMemoryManagerStore.setState({
    factStateFilter,
    nextCursor: null,
    queryApplied: "",
    queryInput: ""
  });
  await refreshMemoryList({ appliedQuery: "" });
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
      scope: draft.scope,
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

async function reconcileCurrentMemoryKeepingDraft(
  memoryId: string,
  screen: Extract<MemoryManagerScreen, "edit" | "move"> = "edit"
): Promise<void> {
  const draft = useMemoryManagerStore.getState().draft;
  try {
    const response = await loadMemory(memoryId);
    useMemoryManagerStore.setState((state) => ({
      ...detailFields(response),
      draft,
      draftDirty: true,
      draftStale: true,
      memories: state.memories.map((memory) =>
        memory.id === response.memory.id ? response.memory : memory
      ),
      screen
    }));
    void loadEvidence(memoryId).catch(() => undefined);
  } catch {
    useMemoryManagerStore.setState({ draft, draftDirty: true, draftStale: true, screen });
  }
}

type ReviewFeedbackType = Exclude<MemoryFeedbackType, "RETRACT">;

export async function submitMemoryFeedback(
  versionId: string,
  feedbackType: ReviewFeedbackType,
  comment?: string
): Promise<void> {
  const memory = useMemoryManagerStore.getState().activeMemory;
  if (!memory) return;
  const normalizedComment = comment?.trim();
  useMemoryManagerStore.setState({
    mutationError: null,
    mutationState: "reviewing",
    notice: null
  });
  try {
    const response = await recordMemoryFeedback(memory.id, {
      ...(normalizedComment ? { comment: normalizedComment } : {}),
      expectedVersionId: versionId,
      feedbackType,
      requestId: memoryRequestId()
    });
    const feedback: MemoryFeedbackRecord = {
      comment: normalizedComment ?? null,
      createdAt: response.createdAt,
      feedbackType,
      id: response.feedbackId,
      retractedAt: null,
      targetVersionId: response.targetVersionId
    };
    useMemoryManagerStore.setState((state) => ({
      ...(state.activeMemory?.id === memory.id
        ? {
            feedback: [feedback, ...state.feedback].slice(0, 20),
            lastFeedbackUndo: { feedbackId: response.feedbackId, versionId },
            notice: "feedback_recorded" as const
          }
        : {}),
      mutationError: null,
      mutationState: null
    }));
    if (useMemoryManagerStore.getState().activeMemory?.id === memory.id) {
      void reloadOpenMemoryDetail(memory.id).catch(() => undefined);
    } else {
      void refreshMemoryList().catch(() => undefined);
    }
  } catch (error) {
    useMemoryManagerStore.setState((state) => ({
      ...(state.activeMemory?.id === memory.id
        ? { mutationError: errorName(error) }
        : {}),
      mutationState: null
    }));
    throw error;
  }
}

export async function undoLastMemoryFeedback(): Promise<void> {
  const { activeMemory, lastFeedbackUndo } = useMemoryManagerStore.getState();
  if (!activeMemory || !lastFeedbackUndo) return;
  useMemoryManagerStore.setState({ mutationError: null, mutationState: "reviewing" });
  try {
    const response = await recordMemoryFeedback(activeMemory.id, {
      expectedVersionId: lastFeedbackUndo.versionId,
      feedbackType: "RETRACT",
      requestId: memoryRequestId(),
      retractsFeedbackId: lastFeedbackUndo.feedbackId
    });
    useMemoryManagerStore.setState((state) => ({
      ...(state.activeMemory?.id === activeMemory.id
        ? {
            feedback: state.feedback.map((feedback) =>
              feedback.id === response.retractedFeedbackId
                ? { ...feedback, retractedAt: response.createdAt }
                : feedback
            ),
            lastFeedbackUndo: null,
            notice: "feedback_retracted" as const
          }
        : {}),
      mutationError: null,
      mutationState: null
    }));
    if (useMemoryManagerStore.getState().activeMemory?.id === activeMemory.id) {
      void reloadOpenMemoryDetail(activeMemory.id).catch(() => undefined);
    } else {
      void refreshMemoryList().catch(() => undefined);
    }
  } catch (error) {
    useMemoryManagerStore.setState((state) => ({
      ...(state.activeMemory?.id === activeMemory.id
        ? { mutationError: errorName(error) }
        : {}),
      mutationState: null
    }));
    throw error;
  }
}

async function resolveConflict(
  resolution: Readonly<{ kind: "CHOOSE"; versionId: string }> |
    Readonly<{ kind: "CORRECT"; statement: string }>
): Promise<void> {
  const { activeMemory, versions } = useMemoryManagerStore.getState();
  if (!activeMemory || activeMemory.factState !== "CONFLICTED") return;
  const expectedVersionIds = versions
    .filter(({ state }) => state === "CONFLICTING")
    .map(({ id }) => id)
    .sort();
  const anchorVersionId = expectedVersionIds[0];
  if (!anchorVersionId || expectedVersionIds.length < 2) return;
  useMemoryManagerStore.setState({
    mutationError: null,
    mutationState: "resolving",
    notice: null
  });
  try {
    const authorization = await authorizeMemoryMutation({
      action: "EDIT",
      expectedTargetVersionId: anchorVersionId,
      targetFactId: activeMemory.id
    });
    const response = await resolveMemoryConflict(activeMemory.id, {
      expectedVersionIds,
      mutationAuthorizationId: authorization.mutationAuthorizationId,
      resolution
    });
    useMemoryManagerStore.setState((state) => ({
      ...(state.activeMemory?.id === activeMemory.id
        ? {
            activeMemory: response.memory,
            feedback: [],
            history: [],
            memories: state.memories.filter((memory) => memory.id !== activeMemory.id),
            notice: "resolved" as const,
            versions: []
          }
        : {}),
      mutationError: null,
      mutationState: null
    }));
    if (useMemoryManagerStore.getState().activeMemory?.id === activeMemory.id) {
      void reloadOpenMemoryDetail(activeMemory.id).catch(() => undefined);
    }
    void refreshMemoryList().catch(() => undefined);
  } catch (error) {
    const sourceStillOpen = useMemoryManagerStore.getState().activeMemory?.id ===
      activeMemory.id;
    useMemoryManagerStore.setState({
      ...(sourceStillOpen ? { mutationError: errorName(error) } : {}),
      mutationState: null
    });
    if (sourceStillOpen && error instanceof MemoryApiError &&
      error.code === "memory_version_stale") {
      await reloadOpenMemoryDetail(activeMemory.id).catch(() => undefined);
    }
    throw error;
  }
}

export async function resolveMemoryConflictChoice(versionId: string): Promise<void> {
  await resolveConflict({ kind: "CHOOSE", versionId });
}

export async function resolveMemoryConflictCorrection(statement: string): Promise<void> {
  await resolveConflict({ kind: "CORRECT", statement });
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

export async function moveMemoryScope(): Promise<void> {
  const { activeMemory, draft } = useMemoryManagerStore.getState();
  const expectedVersionId = activeMemory?.actionVersionId ?? activeMemory?.currentVersionId;
  if (!activeMemory || !expectedVersionId) return;
  if (JSON.stringify(activeMemory.scope) === JSON.stringify(draft.scope)) return;
  useMemoryManagerStore.setState({ mutationError: null, mutationState: "moving" });
  try {
    const authorization = await authorizeMemoryMutation({
      action: "MOVE_SCOPE",
      expectedTargetVersionId: expectedVersionId,
      targetFactId: activeMemory.id
    });
    const response = await updateMemory(activeMemory.id, {
      expectedVersionId,
      mutationAuthorizationId: authorization.mutationAuthorizationId,
      scope: draft.scope
    });
    useMemoryManagerStore.setState((state) => ({
      activeMemory: response.memory,
      draft: draftFromMemory(response.memory),
      draftDirty: false,
      draftStale: false,
      memories: uniqueMemories([
        response.memory,
        ...state.memories.filter((memory) => memory.id !== activeMemory.id)
      ]),
      mutationError: null,
      mutationState: null,
      notice: "saved",
      screen: "detail"
    }));
    void loadEvidence(response.memory.id).catch(() => undefined);
    void refreshMemoryList().catch(() => undefined);
  } catch (error) {
    useMemoryManagerStore.setState({ mutationError: errorName(error), mutationState: null });
    if (error instanceof MemoryApiError && error.code === "memory_version_stale") {
      await reconcileCurrentMemoryKeepingDraft(activeMemory.id, "move");
    }
    throw error;
  }
}

export async function forgetCurrentMemory(): Promise<void> {
  const memory = useMemoryManagerStore.getState().activeMemory;
  const expectedVersionId = memory?.actionVersionId ?? memory?.currentVersionId;
  if (!memory || !expectedVersionId) return;
  useMemoryManagerStore.setState({ mutationError: null, mutationState: "forgetting" });
  try {
    const authorization = await authorizeMemoryMutation({
      action: "FORGET",
      expectedTargetVersionId: expectedVersionId,
      targetFactId: memory.id
    });
    const response = await forgetMemory(memory.id, {
      expectedVersionId,
      mutationAuthorizationId: authorization.mutationAuthorizationId
    });
    useMemoryManagerStore.setState((state) => ({
      activeMemory: null,
      lastForgetUndo: memory.displayText
        ? {
            factId: memory.id,
            statement: memory.displayText,
            undo: response.undo
          }
        : null,
      memories: state.memories.filter((item) => item.id !== memory.id),
      mutationError: null,
      mutationState: null,
      notice: "forgotten",
      screen: "list"
    }));
    void refreshMemoryList().catch(() => undefined);
    refreshOpenMemoryProfile();
  } catch (error) {
    useMemoryManagerStore.setState({ mutationError: errorName(error), mutationState: null });
    if (error instanceof MemoryApiError && error.code === "memory_version_stale") {
      await openMemoryDetail(memory.id).catch(() => undefined);
    }
    throw error;
  }
}

export async function forgetProfileMemory(
  contributor: Pick<MemoryProfileContributor, "displayText" | "factId" | "factVersionId">
): Promise<void> {
  if (useMemoryManagerStore.getState().mutationState !== null) return;
  useMemoryManagerStore.setState({ mutationError: null, mutationState: "forgetting" });
  try {
    const authorization = await authorizeMemoryMutation({
      action: "FORGET",
      expectedTargetVersionId: contributor.factVersionId,
      targetFactId: contributor.factId
    });
    const response = await forgetMemory(contributor.factId, {
      expectedVersionId: contributor.factVersionId,
      mutationAuthorizationId: authorization.mutationAuthorizationId
    });
    useMemoryManagerStore.setState((state) => ({
      activeMemory: state.activeMemory?.id === contributor.factId ? null : state.activeMemory,
      lastForgetUndo: {
        factId: contributor.factId,
        statement: contributor.displayText,
        undo: response.undo
      },
      memories: state.memories.filter((item) => item.id !== contributor.factId),
      mutationError: null,
      mutationState: null,
      notice: "forgotten",
      screen: "list"
    }));
    void refreshMemoryList().catch(() => undefined);
    refreshOpenMemoryProfile();
  } catch (error) {
    useMemoryManagerStore.setState({ mutationError: errorName(error), mutationState: null });
    if (error instanceof MemoryApiError && error.code === "memory_version_stale") {
      const accountId = useMemoryManagerStore.getState().profileAccountId;
      await Promise.allSettled([
        refreshMemoryList(),
        ...(accountId ? [refreshMemoryProfile(accountId)] : [])
      ]);
    }
    throw error;
  }
}

export async function undoLastForgottenMemory(): Promise<void> {
  const descriptor = useMemoryManagerStore.getState().lastForgetUndo;
  if (!descriptor) return;
  if (Date.parse(descriptor.undo.expiresAt) <= Date.now()) {
    useMemoryManagerStore.setState({ lastForgetUndo: null });
    return;
  }
  useMemoryManagerStore.setState({ mutationError: null, mutationState: "restoring" });
  try {
    const authorization = await authorizeMemoryMutation({
      action: "SAVE",
      exactStatementHash: await memoryStatementHash(descriptor.statement)
    });
    const response = await undoForgetMemory(descriptor.factId, {
      deletionId: descriptor.undo.deletionId,
      mutationAuthorizationId: authorization.mutationAuthorizationId
    });
    useMemoryManagerStore.setState((state) => ({
      lastForgetUndo: null,
      memories: uniqueMemories([response.memory, ...state.memories]),
      mutationError: null,
      mutationState: null,
      notice: "forget_restored"
    }));
    void refreshMemoryList().catch(() => undefined);
    refreshOpenMemoryProfile();
  } catch (error) {
    useMemoryManagerStore.setState({
      mutationError: errorName(error),
      mutationState: null
    });
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
      const profileAccountId = useMemoryManagerStore.getState().profileAccountId;
      await Promise.allSettled([
        refreshMemorySettings(true),
        refreshMemoryList(),
        ...(profileAccountId ? [refreshMemoryProfile(profileAccountId)] : [])
      ]);
    }
  } catch (error) {
    useMemoryManagerStore.setState({
      deletionError: errorName(error),
      deletionLoadState: "error"
    });
    throw error;
  }
}

export async function openMemoryManager(accountId: string): Promise<void> {
  const current = useMemoryManagerStore.getState();
  useMemoryManagerStore.setState({
    screen: current.draftDirty ? current.activeMemory ? "edit" : "create" : "list"
  });
  const requests: Promise<unknown>[] = [];
  if (useMemoryManagerStore.getState().listLoadState === "idle") {
    requests.push(refreshMemoryList());
  }
  if (
    current.profileAccountId !== accountId ||
    current.profileLoadState === "error" ||
    current.profileLoadState === "idle"
  ) {
    requests.push(refreshMemoryProfile(accountId));
  }
  const deletionId = storedDeletionId();
  if (deletionId) requests.push(refreshMemoryDeletionStatus(deletionId));
  await Promise.allSettled(requests);
}

export function invalidateMemoryManagerData(accountId: string): void {
  const current = useMemoryManagerStore.getState();
  if (current.profileAccountId !== null && current.profileAccountId !== accountId) return;
  listRequestGeneration += 1;
  detailRequestGeneration += 1;
  evidenceRequestGeneration += 1;
  profileRequestGeneration += 1;
  useMemoryManagerStore.setState({
    activeMemory: null,
    detailError: null,
    detailLoadState: "idle",
    evidence: [],
    evidenceError: null,
    evidenceLoadState: "idle",
    evidenceNextCursor: null,
    feedback: [],
    history: [],
    listError: null,
    listLoadState: "idle",
    memories: [],
    nextCursor: null,
    profileAccountId: accountId,
    profileError: null,
    profileLoadState: "idle",
    profileResponse: null,
    versions: []
  });
}

export function resetMemoryManagerStoreForTest(): void {
  listRequestGeneration += 1;
  detailRequestGeneration += 1;
  evidenceRequestGeneration += 1;
  profileRequestGeneration += 1;
  if (typeof window !== "undefined") window.sessionStorage.removeItem(deletionStorageKey);
  useMemoryManagerStore.setState({
    ...initialState,
    draft: { ...emptyDraft }
  });
}
