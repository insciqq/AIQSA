import {
  DeleteObjectCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { createReadStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type StoredObjectInput = {
  body: Buffer;
  contentType: string;
  storageKey: string;
};

export type StoredObjectReadOptions = {
  maxBytes?: number;
  signal?: AbortSignal;
};

export class StoredObjectTooLargeError extends Error {
  readonly code = "stored_object_too_large";
  readonly maxBytes: number;
  readonly observedBytes: number;

  constructor(input: { maxBytes: number; observedBytes: number }) {
    super("stored_object_too_large");
    this.name = "StoredObjectTooLargeError";
    this.maxBytes = input.maxBytes;
    this.observedBytes = input.observedBytes;
  }
}

export function isStoredObjectTooLargeError(error: unknown): error is StoredObjectTooLargeError {
  return (
    error instanceof StoredObjectTooLargeError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "stored_object_too_large" &&
      Number.isSafeInteger((error as { maxBytes?: unknown }).maxBytes) &&
      Number.isSafeInteger((error as { observedBytes?: unknown }).observedBytes))
  );
}

export type StorageAdapter = {
  deleteObject(storageKey: string): Promise<void>;
  getObject(storageKey: string, options?: StoredObjectReadOptions): Promise<StoredObjectInput>;
  putObject(input: StoredObjectInput): Promise<void>;
};

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function normalizedMaxBytes(maxBytes: number | undefined): number | undefined {
  if (typeof maxBytes === "undefined") {
    return undefined;
  }

  // Keep maxBytes + 1 representable: bounded S3 reads request exactly one
  // sentinel byte beyond the accepted payload.
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("invalid_stored_object_max_bytes");
  }

  return maxBytes;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortReason(signal);
  }
}

function assertWithinLimit(actualBytes: number, maxBytes: number | undefined): void {
  if (typeof maxBytes !== "undefined" && actualBytes > maxBytes) {
    throw new StoredObjectTooLargeError({ maxBytes, observedBytes: actualBytes });
  }
}

export function createMemoryStorageAdapter(): StorageAdapter & { objects: Map<string, StoredObjectInput> } {
  const objects = new Map<string, StoredObjectInput>();

  return {
    objects,
    async deleteObject(storageKey) {
      objects.delete(storageKey);
    },
    async getObject(storageKey, options) {
      const maxBytes = normalizedMaxBytes(options?.maxBytes);
      throwIfAborted(options?.signal);
      const object = objects.get(storageKey);

      if (!object) {
        throw new Error("stored_object_not_found");
      }

      assertWithinLimit(object.body.byteLength, maxBytes);
      throwIfAborted(options?.signal);
      return object;
    },
    async putObject(input) {
      objects.set(input.storageKey, input);
    }
  };
}

export function createFileSystemStorageAdapter(root: string): StorageAdapter {
  return {
    async deleteObject(storageKey) {
      await rm(join(root, storageKey), { force: true });
    },
    async getObject(storageKey, options) {
      const maxBytes = normalizedMaxBytes(options?.maxBytes);
      const signal = options?.signal;
      throwIfAborted(signal);
      const path = join(root, storageKey);
      const metadata = await stat(path);
      throwIfAborted(signal);
      assertWithinLimit(metadata.size, maxBytes);

      const stream = createReadStream(
        path,
        typeof maxBytes === "undefined"
          ? undefined
          : {
              // Read one sentinel byte beyond the accepted boundary so a
              // stat/open race is detected without buffering a full extra chunk.
              end: maxBytes,
              highWaterMark: Math.min(64 * 1024, maxBytes + 1)
            }
      );

      return {
        body: await streamToBuffer(stream, { maxBytes, signal }),
        contentType: "application/octet-stream",
        storageKey
      };
    },
    async putObject(input) {
      const path = join(root, input.storageKey);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, input.body);
    }
  };
}

type CancellableStoredObjectBody = AsyncIterable<unknown> & {
  cancel?: (reason?: unknown) => Promise<unknown> | unknown;
  destroy?: () => unknown;
};

function cancelStoredObjectBody(body: object, reason: unknown): void {
  const cancellable = body as Partial<CancellableStoredObjectBody>;

  try {
    cancellable.destroy?.();
  } catch {
    // Preserve the bounded-read failure that initiated cancellation.
  }

  try {
    const result = cancellable.cancel?.(reason);
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      void Promise.resolve(result).catch(() => {
        // Preserve the bounded-read failure that initiated cancellation.
      });
    }
  } catch {
    // Preserve the bounded-read failure that initiated cancellation.
  }
}

function cancelStoredObjectIterator(iterator: AsyncIterator<unknown> | undefined): void {
  if (!iterator?.return) {
    return;
  }

  try {
    void Promise.resolve(iterator.return()).catch(() => {
      // Preserve the bounded-read failure that initiated cancellation.
    });
  } catch {
    // Preserve the bounded-read failure that initiated cancellation.
  }
}

async function streamToBuffer(
  stream: CancellableStoredObjectBody,
  options: StoredObjectReadOptions = {}
): Promise<Buffer> {
  const maxBytes = normalizedMaxBytes(options.maxBytes);
  const signal = options.signal;
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let iterator: AsyncIterator<unknown> | undefined;
  let rejectForAbort: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectForAbort = reject;
  });
  let abortHandled = false;
  const onAbort = () => {
    if (abortHandled || !signal) {
      return;
    }

    abortHandled = true;
    const reason = abortReason(signal);
    cancelStoredObjectBody(stream, reason);
    cancelStoredObjectIterator(iterator);
    rejectForAbort?.(reason);
  };

  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) {
    onAbort();
  }

  try {
    iterator = stream[Symbol.asyncIterator]();

    while (true) {
      const next = signal ? await Promise.race([iterator.next(), aborted]) : await iterator.next();
      throwIfAborted(signal);

      if (next.done) {
        break;
      }

      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value as Uint8Array);
      const remainingBytes = typeof maxBytes === "undefined" ? chunk.byteLength : maxBytes - totalBytes;

      if (chunk.byteLength > remainingBytes) {
        if (remainingBytes > 0) {
          chunks.push(chunk.subarray(0, remainingBytes));
        }

        const error = new StoredObjectTooLargeError({
          maxBytes: maxBytes as number,
          observedBytes: (maxBytes as number) + 1
        });
        cancelStoredObjectBody(stream, error);
        cancelStoredObjectIterator(iterator);
        throw error;
      }

      totalBytes += chunk.byteLength;
      chunks.push(chunk);
    }

    throwIfAborted(signal);
    return Buffer.concat(chunks, totalBytes);
  } catch (error) {
    cancelStoredObjectIterator(iterator);

    if (signal?.aborted) {
      throw abortReason(signal);
    }

    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

async function s3BodyToBuffer(body: unknown, options: StoredObjectReadOptions): Promise<Buffer> {
  const maxBytes = normalizedMaxBytes(options.maxBytes);
  throwIfAborted(options.signal);

  if (body instanceof Uint8Array) {
    assertWithinLimit(body.byteLength, maxBytes);
    throwIfAborted(options.signal);
    return Buffer.from(body);
  }

  if (typeof body === "object" && body !== null && Symbol.asyncIterator in body) {
    return streamToBuffer(body as CancellableStoredObjectBody, options);
  }

  if (typeof body === "object" && body !== null && "transformToWebStream" in body) {
    const transformer = body as { transformToWebStream(): ReadableStream<Uint8Array> };
    const stream = transformer.transformToWebStream();

    if (!(Symbol.asyncIterator in stream)) {
      throw new Error("unsupported_stored_object_body");
    }

    return streamToBuffer(stream as CancellableStoredObjectBody, options);
  }

  if (
    typeof maxBytes === "undefined" &&
    typeof options.signal === "undefined" &&
    typeof body === "object" &&
    body !== null &&
    "transformToByteArray" in body
  ) {
    const transformer = body as { transformToByteArray(): Promise<Uint8Array> };

    return Buffer.from(await transformer.transformToByteArray());
  }

  throw new Error("unsupported_stored_object_body");
}

export function createS3StorageAdapter(env: Record<string, string | undefined> = process.env): StorageAdapter {
  const bucket = env.S3_BUCKET;
  const endpoint = env.S3_ENDPOINT;

  if (!bucket || !endpoint || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) {
    return createFileSystemStorageAdapter(env.AIQSA_UPLOAD_STORAGE_DIR || ".aiqsa/uploads");
  }

  const client = new S3Client({
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY
    },
    endpoint,
    forcePathStyle: true,
    region: env.S3_REGION || "us-east-1"
  });

  return {
    async deleteObject(storageKey) {
      await client.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: storageKey
        })
      );
    },
    async getObject(storageKey, options) {
      const maxBytes = normalizedMaxBytes(options?.maxBytes);
      const signal = options?.signal;
      throwIfAborted(signal);
      let output: GetObjectCommandOutput;

      try {
        const command = new GetObjectCommand({
          Bucket: bucket,
          Key: storageKey,
          Range: typeof maxBytes === "undefined" ? undefined : `bytes=0-${maxBytes}`
        });
        output = signal
          ? await client.send(command, { abortSignal: signal })
          : await client.send(command);
      } catch (error) {
        if (signal?.aborted) {
          throw abortReason(signal);
        }

        throw error;
      }

      throwIfAborted(signal);

      if (typeof output.ContentLength === "number" && typeof maxBytes !== "undefined" && output.ContentLength > maxBytes) {
        const error = new StoredObjectTooLargeError({
          maxBytes,
          observedBytes: output.ContentLength
        });

        if (typeof output.Body === "object" && output.Body !== null) {
          cancelStoredObjectBody(output.Body, error);
        }

        throw error;
      }

      return {
        body: await s3BodyToBuffer(output.Body, { maxBytes, signal }),
        contentType: output.ContentType ?? "application/octet-stream",
        storageKey
      };
    },
    async putObject(input) {
      await client.send(
        new PutObjectCommand({
          Body: input.body,
          Bucket: bucket,
          ContentType: input.contentType,
          Key: input.storageKey
        })
      );
    }
  };
}
