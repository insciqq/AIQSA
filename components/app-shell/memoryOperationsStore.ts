import {
  authorizeMemoryMutation,
  cancelMemoryRebuild,
  loadMemoryDeletionStatus,
  loadMemoryRebuildStatus,
  MemoryApiError,
  startMemoryBulkDeletion,
  startMemoryRebuild
} from "@/components/app-shell/memoryApi";
import { invalidateMemoryHistorySearchResults } from "@/components/app-shell/memoryHistorySearchStore";
import { refreshMemorySettings } from "@/components/app-shell/memorySettingsStore";
import type {
  MemoryDeletionStatus,
  MemoryRebuildOperation,
  MemoryRebuildStatus
} from "@/lib/contracts/memory";
import { create } from "zustand";

export type MemoryOperationsAction = MemoryRebuildOperation | "CLEAR_HISTORY_INDEX";
export type MemoryOperationsLoadState = "error" | "idle" | "loading" | "ready";
export type MemoryOperationsBusy = "admitting" | "cancelling" | null;

type MemoryOperationsStore = {
  accountId: string | null;
  busy: MemoryOperationsBusy;
  clearError: string | null;
  clearLoadState: MemoryOperationsLoadState;
  clearStatus: MemoryDeletionStatus | null;
  confirmation: MemoryOperationsAction | null;
  confirmationError: string | null;
  rebuildError: string | null;
  rebuildLoadState: MemoryOperationsLoadState;
  rebuildStatus: MemoryRebuildStatus | null;
  selectOperation(operation: MemoryOperationsAction | null): void;
};

type StoredOperationReferences = Readonly<{
  clearDeletionId: string | null;
  rebuildJobId: string | null;
  version: 1;
}>;

const STORAGE_PREFIX = "aiqsa:memory:operations:v1:";

const initialState = {
  accountId: null,
  busy: null,
  clearError: null,
  clearLoadState: "idle" as const,
  clearStatus: null,
  confirmation: null,
  confirmationError: null,
  rebuildError: null,
  rebuildLoadState: "idle" as const,
  rebuildStatus: null
};

export const useMemoryOperationsStore = create<MemoryOperationsStore>((set) => ({
  ...initialState,
  selectOperation(confirmation) {
    set({ confirmation, confirmationError: null });
  }
}));

let operationGeneration = 0;
let clearStatusController: AbortController | null = null;
let rebuildStatusController: AbortController | null = null;

function validOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value &&
    value.length > 0 && value.length <= 256 &&
    !/[\u0000-\u0020\u007f]/u.test(value);
}

function validAccountId(value: string): boolean {
  return validOpaqueId(value);
}

function storageKey(accountId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(accountId)}`;
}

function readReferences(accountId: string): StoredOperationReferences {
  const empty: StoredOperationReferences = {
    clearDeletionId: null,
    rebuildJobId: null,
    version: 1
  };
  if (typeof window === "undefined") return empty;
  try {
    const raw = window.sessionStorage.getItem(storageKey(accountId));
    if (!raw) return empty;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return empty;
    const value = parsed as Record<string, unknown>;
    if (
      Object.keys(value).sort().join(",") !== "clearDeletionId,rebuildJobId,version" ||
      value.version !== 1 ||
      (value.clearDeletionId !== null && !validOpaqueId(value.clearDeletionId)) ||
      (value.rebuildJobId !== null && !validOpaqueId(value.rebuildJobId))
    ) return empty;
    return value as StoredOperationReferences;
  } catch {
    return empty;
  }
}

function writeReferences(
  accountId: string,
  patch: Partial<Pick<StoredOperationReferences, "clearDeletionId" | "rebuildJobId">>
): void {
  if (typeof window === "undefined") return;
  try {
    const next = { ...readReferences(accountId), ...patch, version: 1 as const };
    if (!next.clearDeletionId && !next.rebuildJobId) {
      window.sessionStorage.removeItem(storageKey(accountId));
      return;
    }
    window.sessionStorage.setItem(storageKey(accountId), JSON.stringify(next));
  } catch {
    // Durable server status remains authoritative if browser storage is unavailable.
  }
}

function abortStatusRequests(): void {
  operationGeneration += 1;
  clearStatusController?.abort();
  rebuildStatusController?.abort();
  clearStatusController = null;
  rebuildStatusController = null;
}

function currentAccount(generation: number, accountId: string): boolean {
  return generation === operationGeneration &&
    useMemoryOperationsStore.getState().accountId === accountId;
}

function errorName(error: unknown): string {
  return error instanceof MemoryApiError || error instanceof Error
    ? error.message
    : "memory_action_failed";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export async function activateMemoryOperationsAccount(accountId: string): Promise<void> {
  if (!validAccountId(accountId)) {
    abortStatusRequests();
    useMemoryOperationsStore.setState(initialState);
    return;
  }
  const current = useMemoryOperationsStore.getState();
  if (current.accountId !== accountId) {
    abortStatusRequests();
    useMemoryOperationsStore.setState({ ...initialState, accountId });
  }
  const references = readReferences(accountId);
  await Promise.allSettled([
    references.clearDeletionId
      ? refreshMemoryClearStatus(references.clearDeletionId)
      : Promise.resolve(),
    references.rebuildJobId
      ? refreshMemoryRebuildStatus(references.rebuildJobId)
      : Promise.resolve()
  ]);
}

export function deactivateMemoryOperationsAccount(accountId?: string): void {
  const current = useMemoryOperationsStore.getState();
  if (accountId !== undefined && current.accountId !== accountId) return;
  abortStatusRequests();
  useMemoryOperationsStore.setState(initialState);
}

export function selectMemoryOperation(operation: MemoryOperationsAction | null): void {
  useMemoryOperationsStore.getState().selectOperation(operation);
}

export async function confirmSelectedMemoryOperation(): Promise<void> {
  const current = useMemoryOperationsStore.getState();
  const accountId = current.accountId;
  const operation = current.confirmation;
  if (!accountId || !operation || current.busy) return;
  const generation = operationGeneration;
  useMemoryOperationsStore.setState({ busy: "admitting", confirmationError: null });
  try {
    // The confirmation consumes a fresh aggregate snapshot; the screen's earlier
    // projection is never used as mutation authority.
    const settings = await refreshMemorySettings(true);
    if (!currentAccount(generation, accountId)) return;
    const expectedMemoryRevision = settings.settings.memoryRevision;
    const expectedSettingsRevision = settings.settings.settingsRevision;

    if (operation === "CLEAR_HISTORY_INDEX") {
      const authorization = await authorizeMemoryMutation({
        action: "BULK_DELETE",
        expectedMemoryRevision,
        expectedSettingsRevision,
        operation
      });
      if (!currentAccount(generation, accountId)) return;
      const status = await startMemoryBulkDeletion({
        expectedMemoryRevision,
        expectedSettingsRevision,
        mutationAuthorizationId: authorization.mutationAuthorizationId,
        operation
      });
      if (!currentAccount(generation, accountId)) return;
      writeReferences(accountId, { clearDeletionId: status.deletionId });
      invalidateMemoryHistorySearchResults(accountId);
      useMemoryOperationsStore.setState({
        busy: null,
        clearError: null,
        clearLoadState: "ready",
        clearStatus: status,
        confirmation: null,
        confirmationError: null
      });
      await refreshMemorySettings(true).catch(() => undefined);
      return;
    }

    const embeddingDeploymentId = operation === "REEMBED"
      ? settings.settings.embeddingDeployment?.id ?? null
      : null;
    if (operation === "REEMBED" && !embeddingDeploymentId) {
      throw new MemoryApiError("memory_embedding_unavailable", 409);
    }
    const authorization = operation === "REDREAM_EXISTING_CHATS"
      ? await authorizeMemoryMutation({
          action: "BULK_DELETE",
          expectedMemoryRevision,
          expectedSettingsRevision,
          operation
        })
      : null;
    if (!currentAccount(generation, accountId)) return;
    const status = await startMemoryRebuild({
      ...(operation === "REEMBED" ? { embeddingDeploymentId } : {}),
      expectedMemoryRevision,
      expectedSettingsRevision,
      ...(authorization
        ? { mutationAuthorizationId: authorization.mutationAuthorizationId }
        : {}),
      operation
    });
    if (!currentAccount(generation, accountId)) return;
    writeReferences(accountId, { rebuildJobId: status.jobId });
    useMemoryOperationsStore.setState({
      busy: null,
      confirmation: null,
      confirmationError: null,
      rebuildError: null,
      rebuildLoadState: "ready",
      rebuildStatus: status
    });
  } catch (error) {
    if (!currentAccount(generation, accountId)) return;
    useMemoryOperationsStore.setState({
      busy: null,
      confirmationError: errorName(error)
    });
    if (error instanceof MemoryApiError && error.code === "memory_version_stale") {
      await refreshMemorySettings(true).catch(() => undefined);
    }
    throw error;
  }
}

export async function refreshMemoryClearStatus(
  deletionId = useMemoryOperationsStore.getState().clearStatus?.deletionId ?? null
): Promise<void> {
  const accountId = useMemoryOperationsStore.getState().accountId;
  if (!accountId) return;
  const resolvedId = deletionId ?? readReferences(accountId).clearDeletionId;
  if (!resolvedId) return;
  clearStatusController?.abort();
  const controller = new AbortController();
  clearStatusController = controller;
  const generation = operationGeneration;
  useMemoryOperationsStore.setState({ clearError: null, clearLoadState: "loading" });
  try {
    const status = await loadMemoryDeletionStatus(resolvedId, controller.signal);
    if (!currentAccount(generation, accountId) || controller.signal.aborted) return;
    clearStatusController = null;
    writeReferences(accountId, { clearDeletionId: status.deletionId });
    useMemoryOperationsStore.setState({
      clearError: null,
      clearLoadState: "ready",
      clearStatus: status
    });
    if (status.state === "SUCCEEDED") {
      invalidateMemoryHistorySearchResults(accountId);
      await refreshMemorySettings(true).catch(() => undefined);
    }
  } catch (error) {
    if (!currentAccount(generation, accountId) || controller.signal.aborted || isAbortError(error)) {
      return;
    }
    clearStatusController = null;
    useMemoryOperationsStore.setState({
      clearError: errorName(error),
      clearLoadState: "error"
    });
    throw error;
  }
}

export async function refreshMemoryRebuildStatus(
  jobId = useMemoryOperationsStore.getState().rebuildStatus?.jobId ?? null
): Promise<void> {
  const accountId = useMemoryOperationsStore.getState().accountId;
  if (!accountId) return;
  const resolvedId = jobId ?? readReferences(accountId).rebuildJobId;
  if (!resolvedId) return;
  rebuildStatusController?.abort();
  const controller = new AbortController();
  rebuildStatusController = controller;
  const generation = operationGeneration;
  useMemoryOperationsStore.setState({ rebuildError: null, rebuildLoadState: "loading" });
  try {
    const status = await loadMemoryRebuildStatus(resolvedId, controller.signal);
    if (!currentAccount(generation, accountId) || controller.signal.aborted) return;
    rebuildStatusController = null;
    writeReferences(accountId, { rebuildJobId: status.jobId });
    useMemoryOperationsStore.setState({
      rebuildError: null,
      rebuildLoadState: "ready",
      rebuildStatus: status
    });
    if (status.state === "SUCCEEDED") {
      invalidateMemoryHistorySearchResults(accountId);
      await refreshMemorySettings(true).catch(() => undefined);
    }
  } catch (error) {
    if (!currentAccount(generation, accountId) || controller.signal.aborted || isAbortError(error)) {
      return;
    }
    rebuildStatusController = null;
    useMemoryOperationsStore.setState({
      rebuildError: errorName(error),
      rebuildLoadState: "error"
    });
    throw error;
  }
}

export async function cancelActiveMemoryRebuild(): Promise<void> {
  const current = useMemoryOperationsStore.getState();
  const accountId = current.accountId;
  const jobId = current.rebuildStatus?.jobId;
  if (!accountId || !jobId || current.busy) return;
  const generation = operationGeneration;
  useMemoryOperationsStore.setState({ busy: "cancelling", rebuildError: null });
  try {
    const status = await cancelMemoryRebuild(jobId);
    if (!currentAccount(generation, accountId)) return;
    writeReferences(accountId, { rebuildJobId: status.jobId });
    useMemoryOperationsStore.setState({
      busy: null,
      rebuildError: null,
      rebuildLoadState: "ready",
      rebuildStatus: status
    });
  } catch (error) {
    if (!currentAccount(generation, accountId)) return;
    useMemoryOperationsStore.setState({
      busy: null,
      rebuildError: errorName(error),
      rebuildLoadState: "error"
    });
    throw error;
  }
}

export function dismissMemoryOperationStatus(kind: "clear" | "rebuild"): void {
  const current = useMemoryOperationsStore.getState();
  const accountId = current.accountId;
  if (!accountId) return;
  if (kind === "clear") {
    if (
      current.clearStatus?.state !== "SUCCEEDED" &&
      !(current.clearStatus === null && current.clearError !== null)
    ) return;
    writeReferences(accountId, { clearDeletionId: null });
    useMemoryOperationsStore.setState({
      clearError: null,
      clearLoadState: "idle",
      clearStatus: null
    });
    return;
  }
  if (
    current.rebuildStatus &&
    !["CANCELLED", "FAILED", "STALE", "SUCCEEDED"].includes(current.rebuildStatus.state)
  ) return;
  writeReferences(accountId, { rebuildJobId: null });
  useMemoryOperationsStore.setState({
    rebuildError: null,
    rebuildLoadState: "idle",
    rebuildStatus: null
  });
}

export function resetMemoryOperationsStoreForTest(): void {
  abortStatusRequests();
  if (typeof window !== "undefined") {
    for (let index = window.sessionStorage.length - 1; index >= 0; index -= 1) {
      const key = window.sessionStorage.key(index);
      if (key?.startsWith(STORAGE_PREFIX)) window.sessionStorage.removeItem(key);
    }
  }
  useMemoryOperationsStore.setState(initialState);
}
