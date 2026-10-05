import { getStoredObjectStream, type StorageAdapter } from "../uploads/storage";
import { WorkspaceRuntimeError } from "./runtime";

/**
 * Longest single wait on private storage while staging an original: the
 * object response or its next body chunk. Healthy reads answer within
 * seconds; a pool or backend that makes no progress for this long fails
 * initialization with `workspace_attachment_timeout` instead of blocking the
 * run, including Agent runs without a whole-turn deadline. Time the guest
 * spends consuming bytes is never counted, so large transfers stay valid.
 */
export const WORKSPACE_ATTACHMENT_STORAGE_WAIT_MS = 120_000;

export type WorkspaceAttachmentSource = Readonly<{ byteSize: number; storageKey: string }>;

/**
 * Lazy, sequential acquisition of staged originals. A storage object opens
 * only when the runtime first reads its body, and opening the next one first
 * closes the previous, so one run holds at most one storage connection no
 * matter how many originals it stages. Bodies keep streaming; the runtime
 * still verifies size and checksum before its write.
 */
export function createWorkspaceAttachmentAcquisition(input: Readonly<{
  signal?: AbortSignal;
  storage: StorageAdapter;
  storageWaitMs?: number;
}>) {
  const stalled = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, stalled.signal]) : stalled.signal;
  const waitMs = input.storageWaitMs ?? WORKSPACE_ATTACHMENT_STORAGE_WAIT_MS;
  let current: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let failure: WorkspaceRuntimeError | null = null;
  let closed = false;

  function fail(): WorkspaceRuntimeError {
    failure ??= new WorkspaceRuntimeError(
      input.signal?.aborted ? "workspace_tool_cancelled"
        : stalled.signal.aborted ? "workspace_attachment_timeout"
          : "workspace_attachment_unavailable"
    );
    return failure;
  }

  async function release(reader: ReadableStreamDefaultReader<Uint8Array> | null = current): Promise<void> {
    if (!reader) return;
    if (current === reader) current = null;
    await reader.cancel().catch(() => undefined);
  }

  /** Races one storage wait against cancellation and the no-progress bound. */
  async function storageWait<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const guard = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => stalled.abort(new Error("workspace_attachment_timeout")), waitMs);
    });
    try {
      return await Promise.race([operation, guard]);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  async function open(source: WorkspaceAttachmentSource): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    // The previous original is closed before another connection is requested.
    await release();
    if (closed || failure) throw failure ?? new WorkspaceRuntimeError("workspace_attachment_unavailable");
    signal.throwIfAborted();
    const pending = getStoredObjectStream(input.storage, source.storageKey, {
      maxBytes: source.byteSize,
      requireStreaming: true,
      signal
    });
    let object;
    try {
      object = await storageWait(pending);
    } catch (error) {
      // A response that arrives after the wait gave up must not hold its connection.
      void pending.then((late) => late.body.cancel().catch(() => undefined), () => undefined);
      throw error;
    }
    if (object.byteSize !== source.byteSize || closed) {
      await object.body.cancel().catch(() => undefined);
      throw new Error("stored_object_size_mismatch");
    }
    current = object.body.getReader();
    return current;
  }

  return {
    body(source: WorkspaceAttachmentSource): ReadableStream<Uint8Array> {
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      let received = 0;
      // A zero high-water mark keeps the object closed until the runtime reads.
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            reader ??= await open(source);
            const next = await storageWait(reader.read());
            if (next.done) {
              if (received !== source.byteSize) throw new Error("stored_object_size_mismatch");
              if (current === reader) current = null;
              controller.close();
              return;
            }
            received += next.value.byteLength;
            if (received > source.byteSize) throw new Error("stored_object_size_mismatch");
            controller.enqueue(next.value);
          } catch {
            const error = fail();
            await release(reader);
            controller.error(error);
          }
        },
        async cancel() {
          await release(reader);
        }
      }, { highWaterMark: 0 });
    },
    /** The first acquisition failure, preferred over a runtime's transport error. */
    failure(): WorkspaceRuntimeError | null {
      return failure;
    },
    /** Closes any body still open; later reads never open another object. */
    async close(): Promise<void> {
      closed = true;
      await release();
    }
  };
}
