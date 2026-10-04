import { useSyncExternalStore } from "react";
import { shellFetch } from "@/components/app-shell/shellApi";
import { decodeChatImportResponse, type ChatImportResponse } from "@/lib/contracts/chatImport";
import {
  ChatImportRequestError,
  INITIAL_CHAT_IMPORT_STATE,
  runChatImport,
  type ChatImportRun,
  type ChatImportRunnerDeps,
  type ChatImportState
} from "./chatImportRunner";
import type { ImportWorkerPort } from "./importWorkerProtocol";

export const CHAT_IMPORT_ENDPOINT = "/api/me/chats/import";

/** One import request; anything but a decoded per-chat result list confirms nothing. */
export async function sendChatImportBatch(body: string, count: number): Promise<ChatImportResponse> {
  const response = await shellFetch(CHAT_IMPORT_ENDPOINT, {
    body,
    headers: { "content-type": "application/json" },
    method: "POST"
  });
  if (!response.ok) throw new ChatImportRequestError(response.status);
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
 * The account's one import, outside any component so that closing Settings
 * neither cancels it nor loses its report. A page reload ends it; what was
 * already imported stays.
 */
let current: ChatImportState | null = null;
let run: ChatImportRun | null = null;
/** Identifies the live import; a dismissed one can no longer publish. */
let activeToken: object | null = null;
const listeners = new Set<() => void>();

function publish(state: ChatImportState | null): void {
  current = state;
  for (const listener of listeners) listener();
}

export function chatImportRunning(state: ChatImportState | null = current): boolean {
  return state !== null && (state.phase === "reading" || state.phase === "importing" || state.phase === "stopping");
}

/**
 * Starts importing the picked files unless an import is running; `onImported`
 * runs once at the end when at least one chat was created.
 */
export function startChatImport(
  files: readonly File[],
  options: Readonly<{ deps?: ChatImportRunnerDeps; onImported?: () => void }> = {}
): boolean {
  if (chatImportRunning() || files.length === 0) return false;
  const token = {};
  activeToken = token;
  run = runChatImport(files, options.deps ?? defaultDeps, (state) => {
    if (activeToken === token) publish(state);
  });
  void run.finished.then(
    (state) => {
      if (state.importedChats > 0) options.onImported?.();
    },
    () => {
      if (activeToken === token) {
        publish({
          ...(current ?? INITIAL_CHAT_IMPORT_STATE),
          error: "The import stopped unexpectedly. Chats imported so far stay; run the import again to continue.",
          phase: "failed"
        });
      }
    }
  );
  return true;
}

export function cancelChatImport(): void {
  run?.cancel();
}

/** Clears a settled report. */
export function dismissChatImport(): void {
  if (chatImportRunning()) return;
  run = null;
  activeToken = null;
  publish(null);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useChatImportState(): ChatImportState | null {
  return useSyncExternalStore(subscribe, () => current, () => null);
}
