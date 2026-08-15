import {
  StoredObjectTooLargeError,
  type StorageAdapter,
  type StoredObjectInput
} from "@/lib/server/uploads/storage";

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
    async putObject(input) {
      objects.set(input.storageKey, input);
    }
  };
}
