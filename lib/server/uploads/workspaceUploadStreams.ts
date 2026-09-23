import { createHash } from "node:crypto";
import type { StorageAdapter } from "./storage";

export class WorkspaceUploadStreamError extends Error {
  constructor(readonly code: "upload_size_mismatch" | "upload_checksum_mismatch") { super(code); }
}

/** Reads only on demand. The deadline also interrupts a stalled producer. */
export function meteredUploadBody(body: ReadableStream<Uint8Array>, input: {
  byteSize: number; checksum: string; controller: AbortController; idleMs?: number;
}): { body: ReadableStream<Uint8Array>; dispose(): void; verified(): boolean } {
  const reader = body.getReader();
  const hash = createHash("sha256");
  let observed = 0;
  let verified = false;
  let timer: ReturnType<typeof setTimeout>;
  const abort = () => { void reader.cancel(input.controller.signal.reason).catch(() => undefined); };
  const reset = () => {
    clearTimeout(timer);
    timer = setTimeout(() => input.controller.abort(new Error("upload_timeout")), input.idleMs ?? 60_000);
    timer.unref?.();
  };
  const dispose = () => { clearTimeout(timer); input.controller.signal.removeEventListener("abort", abort); };
  input.controller.signal.addEventListener("abort", abort, { once: true });
  reset();
  return {
    dispose, verified: () => verified,
    body: new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          input.controller.signal.throwIfAborted();
          const next = await reader.read();
          input.controller.signal.throwIfAborted();
          if (next.done) {
            if (observed !== input.byteSize) throw new WorkspaceUploadStreamError("upload_size_mismatch");
            if (hash.digest("hex") !== input.checksum) throw new WorkspaceUploadStreamError("upload_checksum_mismatch");
            verified = true;
            dispose(); reader.releaseLock(); controller.close(); return;
          }
          observed += next.value.byteLength;
          if (observed > input.byteSize) throw new WorkspaceUploadStreamError("upload_size_mismatch");
          hash.update(next.value); reset(); controller.enqueue(next.value);
        } catch (error) {
          input.controller.abort(error); dispose();
          await reader.cancel(error).catch(() => undefined); reader.releaseLock(); controller.error(error);
        }
      },
      async cancel(reason) { dispose(); await reader.cancel(reason).catch(() => undefined); reader.releaseLock(); }
    }, { highWaterMark: 0 })
  };
}

/** Ordered immutable chunks, one open storage stream at a time. */
export function joinedUploadParts(storage: StorageAdapter, parts: readonly {
  storageKey: string; byteSize: number; checksum: string | null;
}[], signal: AbortSignal): ReadableStream<Uint8Array> {
  let index = 0;
  let current: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let hash = createHash("sha256");
  let observed = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        signal.throwIfAborted();
        while (index < parts.length) {
          const part = parts[index]!;
          if (!current) {
            if (!storage.getObjectStream) throw new Error("upload_streaming_unavailable");
            const object = await storage.getObjectStream(part.storageKey, { maxBytes: part.byteSize, signal });
            if (object.byteSize !== part.byteSize) {
              await object.body.cancel(); throw new Error("upload_size_mismatch");
            }
            current = object.body.getReader(); hash = createHash("sha256"); observed = 0;
          }
          const next = await current.read();
          signal.throwIfAborted();
          if (next.done) {
            if (observed !== part.byteSize || hash.digest("hex") !== part.checksum) throw new Error("upload_checksum_mismatch");
            current.releaseLock(); current = null; index += 1; continue;
          }
          observed += next.value.byteLength;
          if (observed > part.byteSize) throw new Error("upload_size_mismatch");
          hash.update(next.value); controller.enqueue(next.value); return;
        }
        controller.close();
      } catch (error) {
        await current?.cancel(error).catch(() => undefined); current = null; controller.error(error);
      }
    },
    async cancel(reason) { await current?.cancel(reason).catch(() => undefined); current = null; }
  }, { highWaterMark: 0 });
}
