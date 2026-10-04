import type { ImportBatch } from "./importPipeline";

/**
 * Main thread to import worker: start with the picked files and the account
 * the import belongs to, then pull one step at a time.
 */
export type ImportWorkerRequest =
  | Readonly<{ type: "start"; accountId: string; files: readonly File[] }>
  | Readonly<{ type: "next" }>;

/** Import worker to main thread: exactly one response per request. */
export type ImportWorkerResponse =
  | Readonly<{ type: "batch"; batch: ImportBatch }>
  | Readonly<{ type: "error"; code: "import_failed" | "import_files_unreadable" }>;

/** The part of `Worker` the import uses, so tests can run the pipeline in-process. */
export interface ImportWorkerPort {
  onerror: ((event: ErrorEvent) => void) | null;
  onmessage: ((event: MessageEvent<ImportWorkerResponse>) => void) | null;
  postMessage(message: ImportWorkerRequest): void;
  terminate(): void;
}
