import type { ChatImportResponse } from "@/lib/contracts/chatImport";
import { IMPORT_SKIPPED_CHAT_KINDS, type ImportSkipKind } from "./converters/converterTypes";
import type { ImportBatch } from "./importPipeline";
import { importFailureMessage, type ImportFailureReason } from "./importReport";
import type { ImportWorkerPort, ImportWorkerResponse } from "./importWorkerProtocol";

export type ChatImportPhase = "cancelled" | "failed" | "finished" | "importing" | "reading" | "stopping";

/** A chat that was not imported, or with `file` a whole file that could not be read. */
export type ChatImportFailedChat = Readonly<{ title: string; reason: string; file?: true }>;

export type ChatImportState = Readonly<{
  phase: ChatImportPhase;
  /** Chats expected so far; a converter may learn more as it reads. */
  total: number;
  /** Chats settled: imported, already imported, failed or skipped. */
  processed: number;
  importedChats: number;
  importedMessages: number;
  alreadyImported: number;
  skipped: Readonly<Partial<Record<ImportSkipKind, number>>>;
  failed: readonly ChatImportFailedChat[];
  /** Why the import stopped early, for `failed`. */
  error: string | null;
}>;

/** Thrown by `sendBatch` for a response that confirms nothing. */
export class ChatImportRequestError extends Error {
  constructor(readonly status: number) {
    super(`chat_import_request_failed_${status}`);
    this.name = "ChatImportRequestError";
  }
}

export type ChatImportRunnerDeps = Readonly<{
  createWorker(): ImportWorkerPort;
  sendBatch(body: string, count: number): Promise<ChatImportResponse>;
}>;

export type ChatImportRun = Readonly<{
  cancel(): void;
  finished: Promise<ChatImportState>;
}>;

export const INITIAL_CHAT_IMPORT_STATE: ChatImportState = Object.freeze({
  alreadyImported: 0,
  error: null,
  failed: [],
  importedChats: 0,
  importedMessages: 0,
  phase: "reading",
  processed: 0,
  skipped: {},
  total: 0
});

type WorkerOutcome = ImportWorkerResponse | Readonly<{ type: "cancelled" }> | Readonly<{ type: "crashed" }>;

function stoppedMessage(error: unknown): string {
  if (error instanceof ChatImportRequestError && error.status === 401) {
    return "Your session ended. Sign in again and repeat the import; chats imported so far stay.";
  }
  return "The import stopped because the server did not respond. Chats imported so far stay; run the import again to continue.";
}

/**
 * Drives one import: the worker reads and packs the files one step at a
 * time, and each step's request is sent before the next is read. Cancel
 * stops further steps; a request already sent completes and its chats stay.
 */
export function runChatImport(
  files: readonly File[],
  deps: ChatImportRunnerDeps,
  onState: (state: ChatImportState) => void
): ChatImportRun {
  let state: ChatImportState = INITIAL_CHAT_IMPORT_STATE;
  const update = (patch: Partial<ChatImportState>) => {
    state = { ...state, ...patch };
    onState(state);
  };
  const worker = deps.createWorker();
  let pending: ((outcome: WorkerOutcome) => void) | null = null;
  let cancelled = false;
  let sending = false;
  const deliver = (outcome: WorkerOutcome) => {
    const resolve = pending;
    pending = null;
    resolve?.(outcome);
  };
  worker.onmessage = (event) => deliver(event.data);
  worker.onerror = () => deliver({ type: "crashed" });
  const request = (message: Parameters<ImportWorkerPort["postMessage"]>[0]) => {
    const outcome = new Promise<WorkerOutcome>((resolve) => { pending = resolve; });
    worker.postMessage(message);
    return outcome;
  };

  const fail = (failed: readonly ChatImportFailedChat[], count: number) => ({
    failed: [...state.failed, ...failed],
    processed: state.processed + count
  });

  const applyLocal = (batch: ImportBatch) => {
    const skipped: Partial<Record<ImportSkipKind, number>> = { ...state.skipped };
    let skippedChats = 0;
    for (const [kind, count] of Object.entries(batch.skipped) as Array<[ImportSkipKind, number]>) {
      skipped[kind] = (skipped[kind] ?? 0) + count;
      if (IMPORT_SKIPPED_CHAT_KINDS.has(kind)) skippedChats += count;
    }
    const failed: ChatImportFailedChat[] = batch.failed.map((failure) => ({
      reason: failure.message ?? importFailureMessage(failure.reason),
      title: failure.title,
      ...(failure.file ? { file: true as const } : {})
    }));
    update({
      failed: [...state.failed, ...failed],
      // A file that could not be read is no chat of the progress.
      processed: state.processed + failed.filter((failure) => !failure.file).length + skippedChats,
      skipped,
      total: state.total + batch.totalDelta
    });
  };

  const applyResults = (batch: ImportBatch, response: ChatImportResponse) => {
    let importedChats = state.importedChats;
    let importedMessages = state.importedMessages;
    let alreadyImported = state.alreadyImported;
    const failed: ChatImportFailedChat[] = [];
    response.results.forEach((result, index) => {
      if (result.status === "imported") {
        importedChats += 1;
        importedMessages += result.messages;
      } else if (result.status === "already_imported") {
        alreadyImported += 1;
      } else {
        failed.push({ reason: importFailureMessage(result.code), title: batch.sent[index]?.title ?? "Untitled chat" });
      }
    });
    update({ alreadyImported, importedChats, importedMessages, ...fail(failed, response.results.length) });
  };

  const finished = (async () => {
    onState(state);
    try {
      let outcome = await request({ files, type: "start" });
      for (;;) {
        if (outcome.type === "cancelled") {
          update({ phase: "cancelled" });
          break;
        }
        if (outcome.type !== "batch") {
          update({
            error: outcome.type === "error" && outcome.code === "import_files_unreadable"
              ? "The selected files could not be read. Pick them again."
              : "The import stopped unexpectedly. Chats imported so far stay; run the import again to continue.",
            phase: "failed"
          });
          break;
        }
        const { batch } = outcome;
        applyLocal(batch);
        if (batch.body) {
          if (!cancelled) update({ phase: "importing" });
          sending = true;
          try {
            applyResults(batch, await deps.sendBatch(batch.body, batch.sent.length));
          } catch (error) {
            const unconfirmed = batch.sent.map((chat) => ({
              reason: importFailureMessage("server_unconfirmed" satisfies ImportFailureReason),
              title: chat.title
            }));
            update({ ...fail(unconfirmed, unconfirmed.length), error: stoppedMessage(error), phase: "failed" });
            break;
          } finally {
            sending = false;
          }
        }
        if (batch.done) {
          update({ phase: "finished", total: Math.max(state.total, state.processed) });
          break;
        }
        if (cancelled) {
          update({ phase: "cancelled" });
          break;
        }
        outcome = await request({ type: "next" });
      }
    } finally {
      worker.terminate();
    }
    return state;
  })();

  return {
    cancel() {
      if (cancelled || state.phase === "finished" || state.phase === "failed") return;
      cancelled = true;
      if (sending) update({ phase: "stopping" });
      else deliver({ type: "cancelled" });
    },
    finished
  };
}
