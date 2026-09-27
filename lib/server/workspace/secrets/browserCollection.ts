import {
  WORKSPACE_BROWSER_SESSION_MAX_BYTES, WORKSPACE_BROWSER_SESSION_MAX_COUNT, WORKSPACE_BROWSER_SESSION_TOTAL_MAX_BYTES,
  isWorkspaceBrowserSessionFilename
} from "@/lib/contracts/workspaceSecrets";
import type { WorkspaceBrowserCollection } from "../runtime";
import { workspaceBrowserSessionChecksum, type WorkspaceBrowserSkipCode } from "./browserSession";

export type WorkspaceBrowserSaveItem =
  | Readonly<{ fileName: string; bytes: Uint8Array }>
  | Readonly<{ skipped: WorkspaceBrowserSkipCode }>;

async function readVerified(file: WorkspaceBrowserCollection["files"][number], signal: AbortSignal): Promise<Uint8Array> {
  const reader = file.body.getReader();
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    // One preallocated buffer per file: memory stays at one state, not the collection.
    const bytes = Buffer.allocUnsafe(file.byteSize);
    let size = 0;
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      if (size + next.value.byteLength > file.byteSize) throw new Error("browser_file_size_mismatch");
      bytes.set(next.value, size);
      size += next.value.byteLength;
    }
    if (size !== file.byteSize || workspaceBrowserSessionChecksum(bytes) !== file.checksum) throw new Error("browser_file_integrity_failed");
    return bytes;
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * Browser credentials never enter output storage or its durable plaintext
 * capture. Files are read lazily, one at a time, when the consumer asks for
 * the next item, so a save holds at most one state in memory. Runtime skip
 * codes travel separately in `collection.skipped`.
 */
export async function* readWorkspaceBrowserCollection(collection: WorkspaceBrowserCollection, signal: AbortSignal): AsyncGenerator<WorkspaceBrowserSaveItem> {
  let accepted = 0;
  let readBytes = 0;
  for (const file of collection.files) {
    signal.throwIfAborted();
    let skip: WorkspaceBrowserSkipCode | null = null;
    if (!isWorkspaceBrowserSessionFilename(file.relativePath) || !Number.isSafeInteger(file.byteSize) || file.byteSize < 1) skip = "browser_session_invalid";
    else if (file.byteSize > WORKSPACE_BROWSER_SESSION_MAX_BYTES) skip = "browser_session_too_large";
    else if (accepted >= WORKSPACE_BROWSER_SESSION_MAX_COUNT) skip = "browser_session_limit";
    // No save can store more than the aggregate budget; do not read beyond it.
    else if (readBytes + file.byteSize > WORKSPACE_BROWSER_SESSION_TOTAL_MAX_BYTES) skip = "browser_session_total_limit";
    if (skip) {
      await file.body.cancel().catch(() => undefined);
      yield { skipped: skip };
      continue;
    }
    accepted++;
    readBytes += file.byteSize;
    let bytes: Uint8Array;
    try {
      bytes = await readVerified(file, signal);
    } catch {
      signal.throwIfAborted();
      yield { skipped: "browser_session_read_failed" };
      continue;
    }
    yield { fileName: file.relativePath, bytes };
  }
}
