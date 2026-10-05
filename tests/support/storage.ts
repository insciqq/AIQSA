import {
  StoredObjectTooLargeError,
  type StorageAdapter,
  type StoredObjectInput
} from "@/lib/server/uploads/storage";
import { createHash } from "node:crypto";

function maxBytes(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("invalid_stored_object_max_bytes");
  }
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
  }
}

export function createMemoryStorageAdapter(): StorageAdapter & {
  objects: Map<string, StoredObjectInput>;
} {
  const objects = new Map<string, StoredObjectInput>();

  return {
    objects,
    async deleteObject(storageKey) {
      objects.delete(storageKey);
    },
    async getObject(storageKey, options) {
      const limit = maxBytes(options?.maxBytes);
      throwIfAborted(options?.signal);
      const object = objects.get(storageKey);
      // Like S3, a missing key is typed NoSuchKey.
      if (!object) throw Object.assign(new Error("stored_object_not_found"), { name: "NoSuchKey" });
      if (limit !== undefined && object.body.byteLength > limit) {
        throw new StoredObjectTooLargeError({
          maxBytes: limit,
          observedBytes: object.body.byteLength
        });
      }
      throwIfAborted(options?.signal);
      return object;
    },
    async getObjectStream(storageKey, options) {
      const object = await this.getObject(storageKey, options);
      return {
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(object.body);
            controller.close();
          }
        }),
        byteSize: object.body.byteLength,
        contentType: object.contentType,
        storageKey
      };
    },
    async inspectObject(storageKey, options) {
      const limit = maxBytes(options?.maxBytes);
      throwIfAborted(options?.signal);
      const object = objects.get(storageKey);
      // Like S3, a missing key is typed NoSuchKey.
      if (!object) throw Object.assign(new Error("stored_object_not_found"), { name: "NoSuchKey" });
      if (limit !== undefined && object.body.byteLength > limit) {
        throw new StoredObjectTooLargeError({
          maxBytes: limit,
          observedBytes: object.body.byteLength
        });
      }
      const sampleBytes = options?.sampleBytes ?? 64 * 1_024;
      if (!Number.isSafeInteger(sampleBytes) || sampleBytes < 1 || sampleBytes > 1_048_576) {
        throw new RangeError("invalid_stored_object_sample_bytes");
      }
      const needles = options?.needles ?? [];
      throwIfAborted(options?.signal);
      return {
        byteSize: object.body.byteLength,
        checksum: createHash("sha256").update(object.body).digest("hex"),
        contentType: object.contentType,
        foundNeedles: needles.filter((needle) => object.body.includes(Buffer.from(needle, "utf8"))),
        sample: object.body.subarray(0, sampleBytes),
        storageKey
      };
    },
    async putObject(input) {
      objects.set(input.storageKey, input);
    },
    async putObjectStream(input) {
      throwIfAborted(input.signal);
      const chunks: Buffer[] = [];
      let byteSize = 0;
      for await (const value of input.body as unknown as AsyncIterable<Uint8Array>) {
        throwIfAborted(input.signal);
        const chunk = Buffer.from(value);
        byteSize += chunk.byteLength;
        if (byteSize > input.byteSize) {
          throw new StoredObjectTooLargeError({
            maxBytes: input.byteSize,
            observedBytes: byteSize
          });
        }
        chunks.push(chunk);
      }
      if (byteSize !== input.byteSize) throw new Error("stored_object_size_mismatch");
      const body = Buffer.concat(chunks, byteSize);
      if (input.checksum && createHash("sha256").update(body).digest("hex") !== input.checksum) throw new Error("stored_object_checksum_mismatch");
      objects.set(input.storageKey, {
        body,
        contentType: input.contentType,
        storageKey: input.storageKey
      });
    }
  };
}

/**
 * Memory storage behind an explicit connection pool, like the S3 client's
 * bounded socket pool: an open body holds its slot until it is read to the
 * end or cancelled, and further opens wait unless their signal aborts. A
 * missing key answers at once and returns its slot. `stalls` holds a key's
 * body after its first chunk until the promise settles.
 */
export function createPooledStorageAdapter(capacity: number) {
  const memory = createMemoryStorageAdapter();
  const stats = { maxOpen: 0, open: 0, opened: 0, waiting: 0 };
  const waiters: Array<() => void> = [];
  const stalls = new Map<string, Promise<void>>();
  const releaseSlot = () => {
    stats.open -= 1;
    waiters.shift()?.();
  };
  async function acquire(signal?: AbortSignal) {
    while (stats.open >= capacity) {
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        stats.waiting += 1;
        const wake = () => {
          stats.waiting -= 1;
          signal?.removeEventListener("abort", aborted);
          resolve();
        };
        const aborted = () => {
          const index = waiters.indexOf(wake);
          if (index >= 0) waiters.splice(index, 1);
          stats.waiting -= 1;
          reject(signal!.reason);
        };
        signal?.addEventListener("abort", aborted, { once: true });
        waiters.push(wake);
      });
    }
    stats.open += 1;
    stats.opened += 1;
    stats.maxOpen = Math.max(stats.maxOpen, stats.open);
  }
  const storage: StorageAdapter = {
    ...memory,
    async getObjectStream(storageKey, options) {
      await acquire(options?.signal);
      const object = memory.objects.get(storageKey);
      if (!object) {
        releaseSlot();
        throw Object.assign(new Error("stored_object_not_found"), { name: "NoSuchKey" });
      }
      let offset = 0;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        releaseSlot();
      };
      return {
        body: new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (offset > 0) await stalls.get(storageKey);
            if (offset >= object.body.byteLength) {
              release();
              controller.close();
              return;
            }
            controller.enqueue(new Uint8Array(object.body.subarray(offset, offset + 7)));
            offset += 7;
          },
          cancel() { release(); }
        }),
        byteSize: object.body.byteLength,
        contentType: object.contentType,
        storageKey
      };
    }
  };
  return { memory, stalls, stats, storage };
}
