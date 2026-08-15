import {
  admitPermanentChatDeletion,
  authorizePermanentChatDeletion,
  loadPermanentChatDeletionSnapshot,
  loadPermanentChatDeletionStatus,
  PermanentChatDeletionApiError,
  type PermanentChatDeletionSnapshot
} from "@/components/app-shell/permanentChatDeletionApi";
import { useMemorySettingsStore } from "@/components/app-shell/memorySettingsStore";
import {
  MEMORY_CONFIRMATION_COPY_VERSION,
  type MemoryDeletionState
} from "@/lib/contracts/memory";
import type { ChatPermanentDeleteStatusResponseWire } from "@/lib/contracts/chats";
import { create } from "zustand";

type LoadState = "error" | "idle" | "loading" | "ready";

type StoredReference = Readonly<{
  chatId: string;
  deletionId: string;
  version: 1;
}>;

export type PermanentChatDeletionTarget = PermanentChatDeletionSnapshot;

type PermanentChatDeletionStore = {
  accountId: string | null;
  alsoForgetOriginMemories: boolean;
  busy: boolean;
  confirmationError: string | null;
  reference: Omit<StoredReference, "version"> | null;
  status: ChatPermanentDeleteStatusResponseWire | null;
  statusError: string | null;
  statusLoadState: LoadState;
  statusOpen: boolean;
  target: PermanentChatDeletionTarget | null;
};

const STORAGE_PREFIX = "aiqsa:chat-permanent-deletion:v1:";

const initialState: PermanentChatDeletionStore = {
  accountId: null,
  alsoForgetOriginMemories: false,
  busy: false,
  confirmationError: null,
  reference: null,
  status: null,
  statusError: null,
  statusLoadState: "idle",
  statusOpen: false,
  target: null
};

export const usePermanentChatDeletionStore =
  create<PermanentChatDeletionStore>(() => initialState);

let operationGeneration = 0;
let activeController: AbortController | null = null;
let reconcileAdmission: ((chatId: string) => Promise<void> | void) | null = null;

function validOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value &&
    value.length > 0 && value.length <= 256 &&
    !/[\u0000-\u0020\u007f]/u.test(value);
}

function validTarget(target: PermanentChatDeletionTarget): boolean {
  return validOpaqueId(target.chatId) &&
    typeof target.title === "string" && target.title.length <= 512 &&
    Number.isSafeInteger(target.expectedChatRevision) &&
    target.expectedChatRevision >= 0 &&
    (target.expectedActiveLeafMessageId === null ||
      validOpaqueId(target.expectedActiveLeafMessageId)) &&
    (target.location === "ARCHIVED" || target.location === "WORKSPACE");
}

function storageKey(accountId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(accountId)}`;
}

function readReference(accountId: string): StoredReference | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(storageKey(accountId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return null;
    const value = parsed as Record<string, unknown>;
    return Object.keys(value).sort().join(",") === "chatId,deletionId,version" &&
      value.version === 1 && validOpaqueId(value.chatId) &&
      validOpaqueId(value.deletionId)
      ? value as StoredReference
      : null;
  } catch {
    return null;
  }
}

function writeReference(
  accountId: string,
  reference: Omit<StoredReference, "version"> | null
): void {
  if (typeof window === "undefined") return;
  try {
    if (!reference) {
      window.sessionStorage.removeItem(storageKey(accountId));
      return;
    }
    window.sessionStorage.setItem(
      storageKey(accountId),
      JSON.stringify({ ...reference, version: 1 })
    );
  } catch {
    // Server status remains authoritative when tab-scoped storage is unavailable.
  }
}

function errorName(error: unknown): string {
  return error instanceof PermanentChatDeletionApiError || error instanceof Error
    ? error.message
    : "chat_permanent_delete_failed";
}

function currentAccount(generation: number, accountId: string): boolean {
  return generation === operationGeneration &&
    usePermanentChatDeletionStore.getState().accountId === accountId;
}

function sameSnapshot(
  left: PermanentChatDeletionTarget,
  right: PermanentChatDeletionTarget
): boolean {
  return left.chatId === right.chatId &&
    left.expectedActiveLeafMessageId === right.expectedActiveLeafMessageId &&
    left.expectedChatRevision === right.expectedChatRevision &&
    left.location === right.location &&
    left.title === right.title;
}

function requestNonce(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `chat-delete-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function provisionalStatus(
  deletionId: string,
  fencedAt: string,
  state: MemoryDeletionState
): ChatPermanentDeleteStatusResponseWire {
  return {
    attemptCount: 0,
    cleanupComplete: state === "SUCCEEDED",
    deletionId,
    errorCode: null,
    fencedAt,
    lastAuditAt: null,
    state,
    updatedAt: fencedAt
  };
}

function abortActiveRequest(): void {
  operationGeneration += 1;
  activeController?.abort();
  activeController = null;
}

export async function activatePermanentChatDeletionAccount(
  accountId: string,
  onAdmission?: (chatId: string) => Promise<void> | void
): Promise<void> {
  if (!validOpaqueId(accountId)) {
    abortActiveRequest();
    reconcileAdmission = null;
    usePermanentChatDeletionStore.setState(initialState, true);
    return;
  }
  const current = usePermanentChatDeletionStore.getState();
  if (current.accountId !== accountId) {
    abortActiveRequest();
    usePermanentChatDeletionStore.setState({ ...initialState, accountId }, true);
  }
  reconcileAdmission = onAdmission ?? null;
  const stored = readReference(accountId);
  if (!stored) return;
  usePermanentChatDeletionStore.setState({
    reference: { chatId: stored.chatId, deletionId: stored.deletionId }
  });
  await refreshPermanentChatDeletionStatus(stored).catch(() => undefined);
}

export function deactivatePermanentChatDeletionAccount(accountId?: string): void {
  const current = usePermanentChatDeletionStore.getState();
  if (accountId !== undefined && current.accountId !== accountId) return;
  abortActiveRequest();
  reconcileAdmission = null;
  usePermanentChatDeletionStore.setState(initialState, true);
}

export function openPermanentChatDeletion(
  target: PermanentChatDeletionTarget
): void {
  if (
    !validTarget(target) ||
    !usePermanentChatDeletionStore.getState().accountId ||
    !useMemorySettingsStore.getState().data?.capabilities.permanentChatDeletion
  ) return;
  usePermanentChatDeletionStore.setState({
    alsoForgetOriginMemories: false,
    confirmationError: null,
    statusOpen: false,
    target
  });
}

export function setPermanentChatDeletionOriginForget(value: boolean): void {
  if (!usePermanentChatDeletionStore.getState().target) return;
  usePermanentChatDeletionStore.setState({ alsoForgetOriginMemories: value });
}

export function closePermanentChatDeletionDialog(): void {
  usePermanentChatDeletionStore.setState({
    alsoForgetOriginMemories: false,
    confirmationError: null,
    statusOpen: false,
    target: null
  });
}

export function openPermanentChatDeletionStatus(): void {
  if (!usePermanentChatDeletionStore.getState().reference) return;
  usePermanentChatDeletionStore.setState({ statusOpen: true });
}

export async function confirmPermanentChatDeletion(): Promise<void> {
  const current = usePermanentChatDeletionStore.getState();
  const accountId = current.accountId;
  const target = current.target;
  if (!accountId || !target || current.busy) return;
  const generation = operationGeneration;
  activeController?.abort();
  const controller = new AbortController();
  activeController = controller;
  usePermanentChatDeletionStore.setState({
    busy: true,
    confirmationError: null
  });
  try {
    const refreshed = await loadPermanentChatDeletionSnapshot(
      target.chatId,
      controller.signal
    );
    if (!currentAccount(generation, accountId) || controller.signal.aborted) return;
    if (!sameSnapshot(target, refreshed)) {
      activeController = null;
      usePermanentChatDeletionStore.setState({
        busy: false,
        confirmationError: "chat_permanent_delete_stale_review_required",
        target: refreshed
      });
      return;
    }
    const common = {
      alsoForgetOriginMemories: current.alsoForgetOriginMemories,
      expectedActiveLeafMessageId: refreshed.expectedActiveLeafMessageId,
      expectedChatRevision: refreshed.expectedChatRevision
    };
    const authorization = await authorizePermanentChatDeletion(
      refreshed.chatId,
      {
        ...common,
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        requestNonce: requestNonce()
      },
      controller.signal
    );
    if (!currentAccount(generation, accountId) || controller.signal.aborted) return;
    const admission = await admitPermanentChatDeletion(
      refreshed.chatId,
      { ...common, mutationAuthorizationId: authorization.mutationAuthorizationId },
      controller.signal
    );
    if (!currentAccount(generation, accountId) || controller.signal.aborted) return;
    activeController = null;
    const reference = {
      chatId: refreshed.chatId,
      deletionId: admission.deletionId
    };
    writeReference(accountId, reference);
    usePermanentChatDeletionStore.setState({
      alsoForgetOriginMemories: false,
      busy: false,
      confirmationError: null,
      reference,
      status: provisionalStatus(
        admission.deletionId,
        admission.fencedAt,
        admission.state
      ),
      statusError: null,
      statusLoadState: "ready",
      statusOpen: true,
      target: null
    });
    await Promise.resolve(reconcileAdmission?.(refreshed.chatId)).catch(() => undefined);
    await refreshPermanentChatDeletionStatus(reference).catch(() => undefined);
  } catch (error) {
    if (!currentAccount(generation, accountId) || controller.signal.aborted) return;
    activeController = null;
    usePermanentChatDeletionStore.setState({
      busy: false,
      confirmationError: errorName(error)
    });
    throw error;
  }
}

export async function refreshPermanentChatDeletionStatus(
  reference = usePermanentChatDeletionStore.getState().reference
): Promise<void> {
  const accountId = usePermanentChatDeletionStore.getState().accountId;
  if (!accountId || !reference) return;
  activeController?.abort();
  const controller = new AbortController();
  activeController = controller;
  const generation = operationGeneration;
  usePermanentChatDeletionStore.setState({
    statusError: null,
    statusLoadState: "loading"
  });
  try {
    const status = await loadPermanentChatDeletionStatus(
      reference.chatId,
      reference.deletionId,
      controller.signal
    );
    if (!currentAccount(generation, accountId) || controller.signal.aborted) return;
    activeController = null;
    const exactReference = {
      chatId: reference.chatId,
      deletionId: status.deletionId
    };
    if (status.deletionId !== reference.deletionId) {
      throw new PermanentChatDeletionApiError(
        "chat_permanent_delete_reference_mismatch",
        409
      );
    }
    if (status.state === "SUCCEEDED") writeReference(accountId, null);
    else writeReference(accountId, exactReference);
    usePermanentChatDeletionStore.setState({
      reference: exactReference,
      status,
      statusError: null,
      statusLoadState: "ready"
    });
  } catch (error) {
    if (!currentAccount(generation, accountId) || controller.signal.aborted) return;
    activeController = null;
    usePermanentChatDeletionStore.setState({
      statusError: errorName(error),
      statusLoadState: "error"
    });
    throw error;
  }
}

export function dismissCompletedPermanentChatDeletion(): void {
  const current = usePermanentChatDeletionStore.getState();
  if (!current.accountId || current.status?.state !== "SUCCEEDED") return;
  writeReference(current.accountId, null);
  usePermanentChatDeletionStore.setState({
    reference: null,
    status: null,
    statusError: null,
    statusLoadState: "idle",
    statusOpen: false
  });
}
