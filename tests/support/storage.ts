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
      if (!object) throw new Error("stored_object_not_found");
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
      if (!object) throw new Error("stored_object_not_found");
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
