import { createChatImportConverters } from "./converters/registry";
import { openImportFile } from "./importFile";
import { importBatches, type ImportBatch } from "./importPipeline";
import type { ImportWorkerRequest, ImportWorkerResponse } from "./importWorkerProtocol";

/**
 * The import worker: it opens the picked files, runs the converters and packs
 * request bodies off the main thread, producing one step per `next` request
 * so a slow server holds back reading instead of buffering the export.
 */
type ImportWorkerScope = {
  onmessage: ((event: MessageEvent<ImportWorkerRequest>) => void) | null;
  postMessage(message: ImportWorkerResponse): void;
};

class UnreadableFilesError extends Error {}

const scope = globalThis as unknown as ImportWorkerScope;
let steps: AsyncGenerator<ImportBatch, void> | null = null;

async function* run(accountId: string, files: readonly File[]): AsyncGenerator<ImportBatch, void> {
  const opened = await Promise.all(files.map((file) => openImportFile(file))).catch(() => {
    throw new UnreadableFilesError();
  });
  yield* importBatches(opened, { accountId, converters: createChatImportConverters() });
}

async function advance(): Promise<void> {
  if (!steps) return;
  try {
    const next = await steps.next();
    // The runner stops after the step marked done and never asks past it.
    scope.postMessage(next.done ? { code: "import_failed", type: "error" } : { batch: next.value, type: "batch" });
  } catch (error) {
    scope.postMessage({ code: error instanceof UnreadableFilesError ? "import_files_unreadable" : "import_failed", type: "error" });
  }
}

scope.onmessage = (event) => {
  const message = event.data;
  if (message.type === "start" && !steps) {
    steps = run(message.accountId, message.files);
    void advance();
    return;
  }
  if (message.type === "next") void advance();
};
