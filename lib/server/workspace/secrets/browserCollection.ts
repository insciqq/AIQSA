import { WORKSPACE_BROWSER_SESSION_MAX_BYTES, WORKSPACE_BROWSER_SESSION_MAX_COUNT, isWorkspaceBrowserSessionFilename } from "@/lib/contracts/workspaceSecrets";
import type { WorkspaceBrowserCollection } from "../runtime";
import { workspaceBrowserSessionChecksum, type WorkspaceBrowserSkipCode } from "./browserSession";

/** Browser credentials never enter output storage or its durable plaintext capture. */
export async function readWorkspaceBrowserCollection(collection: WorkspaceBrowserCollection, signal: AbortSignal) {
  const files: Array<{ fileName: string; bytes: Uint8Array }> = [];
  const skipped: WorkspaceBrowserSkipCode[] = [...collection.skipped.slice(0, 130)];
  for (const file of collection.files.slice(0, WORKSPACE_BROWSER_SESSION_MAX_COUNT)) {
    signal.throwIfAborted();
    if (!isWorkspaceBrowserSessionFilename(file.relativePath) || !Number.isSafeInteger(file.byteSize) || file.byteSize < 1) {
      skipped.push("browser_session_invalid"); await file.body.cancel().catch(() => undefined); continue;
    }
    if (file.byteSize > WORKSPACE_BROWSER_SESSION_MAX_BYTES) {
      skipped.push("browser_session_too_large"); await file.body.cancel().catch(() => undefined); continue;
    }
    const reader = file.body.getReader();
    const abort = () => { void reader.cancel().catch(() => undefined); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        signal.throwIfAborted();
        const next = await reader.read();
        signal.throwIfAborted();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > file.byteSize) throw new Error("browser_file_size_mismatch");
        chunks.push(next.value);
      }
      const bytes = Buffer.concat(chunks, size);
      if (size !== file.byteSize || workspaceBrowserSessionChecksum(bytes) !== file.checksum) throw new Error("browser_file_integrity_failed");
      files.push({ fileName: file.relativePath, bytes });
    } catch {
      signal.throwIfAborted();
      skipped.push("browser_session_read_failed");
    } finally {
      signal.removeEventListener("abort", abort);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  return { files, skipped };
}
