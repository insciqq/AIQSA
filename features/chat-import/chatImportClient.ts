import { useSyncExternalStore } from "react";
import { shellFetch } from "@/components/app-shell/shellApi";
import { decodeChatImportResponse, type ChatImportResponse } from "@/lib/contracts/chatImport";
import {
  ACCOUNT_CHANGED_CHAT_IMPORT_STATE,
  ChatImportRequestError,
  INITIAL_CHAT_IMPORT_STATE,
  runChatImport,
  type ChatImportRun,
  type ChatImportRunnerDeps,
  type ChatImportState
} from "./chatImportRunner";
import { watchImportAccount } from "./importAccountFence";
import type { ImportWorkerPort } from "./importWorkerProtocol";

export const CHAT_IMPORT_ENDPOINT = "/api/me/chats/import";

async function errorCode(response: Response): Promise<string | null> {
  const body: unknown = await response.json().catch(() => null);
  const error = typeof body === "object" && body !== null ? (body as { error?: unknown }).error : undefined;
  return typeof error === "string" ? error : null;
}

/** One import request; anything but a decoded per-chat result list confirms nothing. */
export async function sendChatImportBatch(body: string, count: number, signal: AbortSignal): Promise<ChatImportResponse> {
  const response = await shellFetch(CHAT_IMPORT_ENDPOINT, {
    body,
    headers: { "content-type": "application/json" },
    method: "POST",
    signal
  });
  if (!response.ok) throw new ChatImportRequestError(response.status, await errorCode(response));
  const decoded = decodeChatImportResponse(await response.json().catch(() => null), count);
  if (!decoded) throw new ChatImportRequestError(0);
  return decoded;
}

/** The same-origin module worker; the bundler emits it as a static chunk allowed by `worker-src 'self'`. */
export function createChatImportWorker(): ImportWorkerPort {
  return new Worker(new URL("./importWorker.ts", import.meta.url), { name: "chat-import", type: "module" });
}

const defaultDeps: ChatImportRunnerDeps = {
  createWorker: createChatImportWorker,
  sendBatch: sendChatImportBatch
};

/**
 * The one import of this tab, outside any component so that closing Settings
 * neither cancels it nor loses its report. It belongs to the account that
 * started it: when that account signs out (in any tab) or its session ends,
 * the import stops and its report keeps only the reason. A page reload ends
 * it; what was already imported stays.
 */
let current: Readonly<{ accountId: string; state: ChatImportState }> | null = null;
let run: ChatImportRun | null = null;
/** Identifies the live import; a dismissed one can no longer publish. */
let activeToken: object | null = null;
let stopWatchingAccount: (() => void) | null = null;
const listeners = new Set<() => void>();

function publish(next: Readonly<{ accountId: string; state: ChatImportState }> | null): void {
  current = next;
  for (const listener of listeners) listener();
}

export function chatImportRunning(state: ChatImportState | null = current?.state ?? null): boolean {
  return state !== null && (state.phase === "reading" || state.phase === "importing" || state.phase === "stopping");
}

/** The account is gone: stop the run (worker, files, request in flight) and drop the report's details. */
function endForAccountChange(token: object): void {
  if (activeToken !== token || !current) return;
  run?.stopForAccountChange();
  publish({ accountId: current.accountId, state: ACCOUNT_CHANGED_CHAT_IMPORT_STATE });
}

/**
 * Starts importing the picked files for the signed-in account unless an
 * import is running; `onImported` runs once at the end when at least one chat
 * was created.
 */
export function startChatImport(
  files: readonly File[],
  options: Readonly<{ accountId: string; deps?: ChatImportRunnerDeps; onImported?: () => void }>
): boolean {
  if (chatImportRunning() || files.length === 0) return false;
  stopWatchingAccount?.();
  const token = {};
  const { accountId } = options;
  activeToken = token;
  publish({ accountId, state: INITIAL_CHAT_IMPORT_STATE });
  run = runChatImport({ accountId, files }, options.deps ?? defaultDeps, (state) => {
    if (activeToken === token) publish({ accountId, state });
  });
  stopWatchingAccount = watchImportAccount(accountId, () => endForAccountChange(token));
  void run.finished.then(
    (state) => {
      if (activeToken === token && state.importedChats > 0) options.onImported?.();
    },
    () => {
      if (activeToken === token) {
        publish({
          accountId,
          state: {
            ...(current?.state ?? INITIAL_CHAT_IMPORT_STATE),
            error: "The import stopped unexpectedly. Chats imported so far stay; run the import again to continue.",
            phase: "failed"
          }
        });
      }
    }
  );
  return true;
}

export function cancelChatImport(): void {
  run?.cancel();
}

/** Clears a settled report and stops watching its account. */
export function dismissChatImport(): void {
  if (chatImportRunning()) return;
  stopWatchingAccount?.();
  stopWatchingAccount = null;
  run = null;
  activeToken = null;
  publish(null);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** This account's import; another account's import or report is never shown. */
export function useChatImportState(accountId: string): ChatImportState | null {
  return useSyncExternalStore(
    subscribe,
    () => current?.accountId === accountId ? current.state : null,
    () => null
  );
}
