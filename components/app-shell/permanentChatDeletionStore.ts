import {
  admitPermanentChatDeletion,
  loadPermanentChatDeletionStatus,
  PermanentChatDeletionApiError,
  type PermanentChatDeletionFailureReason,
  type PermanentChatDeletionSnapshot
} from "@/components/app-shell/permanentChatDeletionApi";
import { useMemorySettingsStore } from "@/components/app-shell/memorySettingsStore";
import {
  MEMORY_CONFIRMATION_COPY_VERSION,
  type MemoryConsumerPermanentChatDeleteResponse
} from "@/lib/contracts/memoryClient";
import { create } from "zustand";

type LoadState = "error" | "idle" | "loading" | "ready";

export type PermanentChatDeletionTarget = PermanentChatDeletionSnapshot;

type PermanentChatDeletionStore = {
  accountId: string | null;
  alsoForgetOriginMemories: boolean;
  busy: boolean;
  confirmationError: PermanentChatDeletionFailureReason | null;
  reference: Readonly<{ chatId: string }> | null;
  status: MemoryConsumerPermanentChatDeleteResponse | null;
  statusError: PermanentChatDeletionFailureReason | null;
  statusLoadState: LoadState;
  statusOpen: boolean;
  target: PermanentChatDeletionTarget | null;
};

const STORAGE_PREFIX = "aiqsa:chat-permanent-deletion:v2:";
const LEGACY_STORAGE_PREFIX = "aiqsa:chat-permanent-deletion:v1:";

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
    (target.location === "ARCHIVED" || target.location === "WORKSPACE");
}

function storageKey(accountId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(accountId)}`;
}

function purgeLegacyReference(accountId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(
      `${LEGACY_STORAGE_PREFIX}${encodeURIComponent(accountId)}`
    );
  } catch {
    // Legacy tab state expires with the session when storage is unavailable.
  }
}

function readReference(accountId: string): Readonly<{ chatId: string }> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(storageKey(accountId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return null;
    const value = parsed as Record<string, unknown>;
    return Object.keys(value).sort().join(",") === "chatId,version" &&
      value.version === 2 && validOpaqueId(value.chatId)
      ? { chatId: value.chatId }
      : null;
  } catch {
    return null;
  }
}

function writeReference(accountId: string, chatId: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (!chatId) {
      window.sessionStorage.removeItem(storageKey(accountId));
      return;
    }
    window.sessionStorage.setItem(storageKey(accountId), JSON.stringify({ chatId, version: 2 }));
  } catch {
    // Server status remains authoritative when tab-scoped storage is unavailable.
  }
}

function errorReason(error: unknown): PermanentChatDeletionFailureReason {
  return error instanceof PermanentChatDeletionApiError
    ? error.reason
    : "FAILED";
}

function currentAccount(generation: number, accountId: string): boolean {
  return generation === operationGeneration &&
    usePermanentChatDeletionStore.getState().accountId === accountId;
}

function requestId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  if (!globalThis.crypto?.getRandomValues) {
    throw new PermanentChatDeletionApiError("FAILED", 500);
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
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
  purgeLegacyReference(accountId);
  const stored = readReference(accountId);
  if (!stored) return;
  usePermanentChatDeletionStore.setState({ reference: stored });
  await refreshPermanentChatDeletionStatus(stored).catch(() => undefined);
}

export function deactivatePermanentChatDeletionAccount(accountId?: string): void {
  const current = usePermanentChatDeletionStore.getState();
  if (accountId !== undefined && current.accountId !== accountId) return;
  abortActiveRequest();
  reconcileAdmission = null;
  usePermanentChatDeletionStore.setState(initialState, true);
}

export function openPermanentChatDeletion(target: PermanentChatDeletionTarget): void {
  if (!validTarget(target) || !usePermanentChatDeletionStore.getState().accountId ||
    !useMemorySettingsStore.getState().data?.capabilities.permanentChatDeletion) return;
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
  usePermanentChatDeletionStore.setState({ busy: true, confirmationError: null });
  try {
    const status = await admitPermanentChatDeletion(target.chatId, {
      alsoForgetOriginMemories: current.alsoForgetOriginMemories,
      confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
      requestId: requestId()
    }, controller.signal);
    if (!currentAccount(generation, accountId) || controller.signal.aborted) return;
    activeController = null;
    const reference = { chatId: target.chatId };
    writeReference(accountId, target.chatId);
    usePermanentChatDeletionStore.setState({
      alsoForgetOriginMemories: false,
      busy: false,
      confirmationError: null,
      reference,
      status,
      statusError: null,
      statusLoadState: "ready",
      statusOpen: true,
      target: null
    });
    await Promise.resolve(reconcileAdmission?.(target.chatId)).catch(() => undefined);
  } catch (error) {
    if (!currentAccount(generation, accountId) || controller.signal.aborted) return;
    const reason = errorReason(error);
    if (reason === "FAILED") {
      try {
        const status = await loadPermanentChatDeletionStatus(
          target.chatId,
          controller.signal
        );
        if (!currentAccount(generation, accountId) || controller.signal.aborted) return;
        activeController = null;
        const reference = { chatId: target.chatId };
        writeReference(accountId, target.chatId);
        usePermanentChatDeletionStore.setState({
          alsoForgetOriginMemories: false,
          busy: false,
          confirmationError: null,
          reference,
          status,
          statusError: null,
          statusLoadState: "ready",
          statusOpen: true,
          target: null
        });
        await Promise.resolve(reconcileAdmission?.(target.chatId)).catch(() => undefined);
        return;
      } catch {
        // A failed status lookup means admission is still unknown; keep the
        // confirmation visible without exposing server lifecycle detail.
      }
    }
    activeController = null;
    usePermanentChatDeletionStore.setState({
      busy: false,
      confirmationError: reason
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
  usePermanentChatDeletionStore.setState({ statusError: null, statusLoadState: "loading" });
  try {
    const status = await loadPermanentChatDeletionStatus(reference.chatId, controller.signal);
    if (!currentAccount(generation, accountId) || controller.signal.aborted) return;
    activeController = null;
    if (status.status === "COMPLETE") writeReference(accountId, null);
    else writeReference(accountId, reference.chatId);
    usePermanentChatDeletionStore.setState({
      status,
      statusError: null,
      statusLoadState: "ready"
    });
  } catch (error) {
    if (!currentAccount(generation, accountId) || controller.signal.aborted) return;
    activeController = null;
    usePermanentChatDeletionStore.setState({
      statusError: errorReason(error),
      statusLoadState: "error"
    });
    throw error;
  }
}

export function dismissCompletedPermanentChatDeletion(): void {
  const current = usePermanentChatDeletionStore.getState();
  if (!current.accountId || current.status?.status !== "COMPLETE") return;
  writeReference(current.accountId, null);
  usePermanentChatDeletionStore.setState({
    reference: null,
    status: null,
    statusError: null,
    statusLoadState: "idle",
    statusOpen: false
  });
}

export function resetPermanentChatDeletionStore(): void {
  abortActiveRequest();
  reconcileAdmission = null;
  usePermanentChatDeletionStore.setState(initialState, true);
}
