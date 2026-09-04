import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
  PutObjectCommand,
  S3Client,
  UploadPartCommand
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export type StoredObjectInput = {
  body: Buffer;
  contentType: string;
  storageKey: string;
};

export type StoredObjectReadOptions = {
  maxBytes?: number;
  signal?: AbortSignal;
};

export type StoredObjectInspectionOptions = StoredObjectReadOptions & Readonly<{
  needles?: readonly string[];
  sampleBytes?: number;
}>;

export type StoredObjectInspection = Readonly<{
  byteSize: number;
  checksum: string;
  contentType: string;
  foundNeedles: string[];
  sample: Buffer;
  storageKey: string;
}>;

export type StoredObjectStreamInput = Readonly<{
  body: ReadableStream<Uint8Array>;
  byteSize: number;
  contentType: string;
  signal?: AbortSignal;
  storageKey: string;
}>;

export type StoredObjectReadStream = Readonly<{
  body: ReadableStream<Uint8Array>;
  byteSize: number;
  contentType: string;
  storageKey: string;
}>;

export type StoredMultipartPart = Readonly<{
  etag: string;
  partNumber: number;
}>;

export type DirectMultipartUploadAdapter = Readonly<{
  abortMultipartUpload(input: Readonly<{ storageKey: string; uploadId: string }>): Promise<void>;
  completeMultipartUpload(input: Readonly<{
    parts: readonly StoredMultipartPart[];
    storageKey: string;
    uploadId: string;
  }>): Promise<void>;
  createMultipartUpload(input: Readonly<{
    contentType: string;
    storageKey: string;
  }>): Promise<Readonly<{ uploadId: string }>>;
  presignMultipartPart(input: Readonly<{
    expiresInSeconds: number;
    partNumber: number;
    storageKey: string;
    uploadId: string;
  }>): Promise<string>;
}>;

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
  getObjectStream?(
    storageKey: string,
    options?: StoredObjectReadOptions
  ): Promise<StoredObjectReadStream>;
  inspectObject?(
    storageKey: string,
    options?: StoredObjectInspectionOptions
  ): Promise<StoredObjectInspection>;
  putObject(input: StoredObjectInput): Promise<void>;
  putObjectStream?(input: StoredObjectStreamInput): Promise<void>;
  directMultipartUpload?: DirectMultipartUploadAdapter;
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

function byteStream(value: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(value);
      controller.close();
    }
  });
}

function boundedExactWebStream(
  source: ReadableStream<Uint8Array>,
  input: Readonly<{
    byteSize: number;
    maxBytes?: number;
    signal?: AbortSignal;
  }>
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let observedBytes = 0;
  let settled = false;
  const abort = () => void reader.cancel(abortReason(input.signal!)).catch(() => undefined);
  input.signal?.addEventListener("abort", abort, { once: true });
  const finish = () => {
    if (settled) return;
    settled = true;
    input.signal?.removeEventListener("abort", abort);
  };
  return new ReadableStream<Uint8Array>({
    async cancel(reason) {
      finish();
      await reader.cancel(reason).catch(() => undefined);
    },
    async pull(controller) {
      try {
        throwIfAborted(input.signal);
        const next = await reader.read();
        throwIfAborted(input.signal);
        if (next.done) {
          finish();
          if (observedBytes !== input.byteSize) {
            controller.error(new Error("stored_object_size_mismatch"));
          } else {
            controller.close();
          }
          reader.releaseLock();
          return;
        }
        observedBytes += next.value.byteLength;
        if (
          observedBytes > input.byteSize ||
          (input.maxBytes !== undefined && observedBytes > input.maxBytes)
        ) {
          const maximum = Math.min(input.byteSize, input.maxBytes ?? input.byteSize);
          const error = new StoredObjectTooLargeError({
            maxBytes: maximum,
            observedBytes
          });
          finish();
          await reader.cancel(error).catch(() => undefined);
          controller.error(error);
          reader.releaseLock();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        finish();
        await reader.cancel(error).catch(() => undefined);
        controller.error(input.signal?.aborted ? abortReason(input.signal) : error);
        reader.releaseLock();
      }
    }
  });
}

export async function getStoredObjectStream(
  storage: StorageAdapter,
  storageKey: string,
  options: StoredObjectReadOptions = {}
): Promise<StoredObjectReadStream> {
  if (storage.getObjectStream) return storage.getObjectStream(storageKey, options);
  const object = await storage.getObject(storageKey, options);
  return {
    body: byteStream(object.body),
    byteSize: object.body.byteLength,
    contentType: object.contentType,
    storageKey: object.storageKey
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
    async getObjectStream(storageKey, options) {
      const maxBytes = normalizedMaxBytes(options?.maxBytes);
      const signal = options?.signal;
      throwIfAborted(signal);
      const path = join(root, storageKey);
      const metadata = await stat(path);
      throwIfAborted(signal);
      assertWithinLimit(metadata.size, maxBytes);
      const source = Readable.toWeb(createReadStream(path, { signal })) as ReadableStream<Uint8Array>;
      return {
        body: boundedExactWebStream(source, {
          byteSize: metadata.size,
          maxBytes,
          signal
        }),
        byteSize: metadata.size,
        contentType: "application/octet-stream",
        storageKey
      };
    },
    async inspectObject(storageKey, options) {
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
          : { end: maxBytes, highWaterMark: Math.min(64 * 1_024, maxBytes + 1) }
      );
      return inspectStoredObjectStream(stream, {
        contentType: "application/octet-stream",
        maxBytes,
        needles: options?.needles,
        sampleBytes: options?.sampleBytes,
        signal,
        storageKey
      });
    },
    async putObject(input) {
      const path = join(root, input.storageKey);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, input.body);
    },
    async putObjectStream(input) {
      if (!Number.isSafeInteger(input.byteSize) || input.byteSize < 1) {
        throw new RangeError("invalid_stored_object_stream_size");
      }
      throwIfAborted(input.signal);
      const path = join(root, input.storageKey);
      const temporaryPath = `${path}.upload-${randomUUID()}`;
      await mkdir(dirname(path), { recursive: true });
      let observedBytes = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          observedBytes += chunk.byteLength;
          callback(
            observedBytes > input.byteSize
              ? new StoredObjectTooLargeError({
                  maxBytes: input.byteSize,
                  observedBytes
                })
              : null,
            chunk
          );
        }
      });
      try {
        await pipeline(
          Readable.from(input.body as unknown as AsyncIterable<Uint8Array>),
          meter,
          createWriteStream(temporaryPath, { flags: "wx" }),
          ...(input.signal ? [{ signal: input.signal }] : [])
        );
        if (observedBytes !== input.byteSize) {
          throw new Error("stored_object_size_mismatch");
        }
        await rename(temporaryPath, path);
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        if (input.signal?.aborted) throw abortReason(input.signal);
        throw error;
      }
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

function normalizedInspectionOptions(options: StoredObjectInspectionOptions): Readonly<{
  maxBytes: number | undefined;
  needleBuffers: Array<Readonly<{ bytes: Buffer; value: string }>>;
  sampleBytes: number;
}> {
  const maxBytes = normalizedMaxBytes(options.maxBytes);
  const sampleBytes = options.sampleBytes ?? 64 * 1_024;
  if (!Number.isSafeInteger(sampleBytes) || sampleBytes < 1 || sampleBytes > 1_048_576) {
    throw new RangeError("invalid_stored_object_sample_bytes");
  }
  const needles = options.needles ?? [];
  if (needles.length > 64 || new Set(needles).size !== needles.length ||
    needles.some((needle) => needle.length < 1 || needle.length > 256 || /\u0000/u.test(needle))) {
    throw new RangeError("invalid_stored_object_needles");
  }
  return {
    maxBytes,
    needleBuffers: needles.map((value) => ({ bytes: Buffer.from(value, "utf8"), value })),
    sampleBytes
  };
}

async function inspectStoredObjectStream(
  stream: CancellableStoredObjectBody,
  options: StoredObjectInspectionOptions & Readonly<{
    contentType: string;
    storageKey: string;
  }>
): Promise<StoredObjectInspection> {
  const normalized = normalizedInspectionOptions(options);
  const signal = options.signal;
  const sampleChunks: Buffer[] = [];
  let sampledBytes = 0;
  let totalBytes = 0;
  const hash = createHash("sha256");
  const found = new Set<string>();
  const maximumNeedleBytes = normalized.needleBuffers.reduce(
    (maximum, needle) => Math.max(maximum, needle.bytes.byteLength),
    0
  );
  let tail = Buffer.alloc(0);
  let iterator: AsyncIterator<unknown> | undefined;
  let rejectForAbort: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectForAbort = reject;
  });
  let abortHandled = false;
  const onAbort = () => {
    if (abortHandled || !signal) return;
    abortHandled = true;
    const reason = abortReason(signal);
    cancelStoredObjectBody(stream, reason);
    cancelStoredObjectIterator(iterator);
    rejectForAbort?.(reason);
  };

  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    iterator = stream[Symbol.asyncIterator]();
    while (true) {
      const next = signal ? await Promise.race([iterator.next(), aborted]) : await iterator.next();
      throwIfAborted(signal);
      if (next.done) break;
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value as Uint8Array);
      totalBytes += chunk.byteLength;
      if (typeof normalized.maxBytes !== "undefined" && totalBytes > normalized.maxBytes) {
        const error = new StoredObjectTooLargeError({
          maxBytes: normalized.maxBytes,
          observedBytes: totalBytes
        });
        cancelStoredObjectBody(stream, error);
        cancelStoredObjectIterator(iterator);
        throw error;
      }
      hash.update(chunk);
      if (sampledBytes < normalized.sampleBytes) {
        const accepted = chunk.subarray(
          0,
          Math.min(chunk.byteLength, normalized.sampleBytes - sampledBytes)
        );
        if (accepted.byteLength > 0) {
          sampleChunks.push(accepted);
          sampledBytes += accepted.byteLength;
        }
      }
      if (normalized.needleBuffers.length > found.size) {
        const searchable = tail.byteLength > 0 ? Buffer.concat([tail, chunk]) : chunk;
        for (const needle of normalized.needleBuffers) {
          if (!found.has(needle.value) && searchable.includes(needle.bytes)) {
            found.add(needle.value);
          }
        }
        const retained = Math.max(0, maximumNeedleBytes - 1);
        tail = retained === 0
          ? Buffer.alloc(0)
          : searchable.subarray(Math.max(0, searchable.byteLength - retained));
      }
    }
    throwIfAborted(signal);
    return {
      byteSize: totalBytes,
      checksum: hash.digest("hex"),
      contentType: options.contentType,
      foundNeedles: [...found],
      sample: Buffer.concat(sampleChunks, sampledBytes),
      storageKey: options.storageKey
    };
  } catch (error) {
    cancelStoredObjectIterator(iterator);
    if (signal?.aborted) throw abortReason(signal);
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

function s3BodyToStream(body: unknown): CancellableStoredObjectBody {
  if (typeof body === "object" && body !== null && Symbol.asyncIterator in body) {
    return body as CancellableStoredObjectBody;
  }
  if (typeof body === "object" && body !== null && "transformToWebStream" in body) {
    const transformer = body as { transformToWebStream(): ReadableStream<Uint8Array> };
    const stream = transformer.transformToWebStream();
    if (Symbol.asyncIterator in stream) return stream as CancellableStoredObjectBody;
  }
  throw new Error("unsupported_stored_object_body");
}

function s3BodyToWebStream(body: unknown): ReadableStream<Uint8Array> {
  if (body instanceof Uint8Array) return byteStream(body);
  if (typeof body === "object" && body !== null && "transformToWebStream" in body) {
    return (body as { transformToWebStream(): ReadableStream<Uint8Array> })
      .transformToWebStream();
  }
  if (typeof body === "object" && body !== null && Symbol.asyncIterator in body) {
    return Readable.toWeb(
      Readable.from(body as AsyncIterable<Uint8Array>)
    ) as ReadableStream<Uint8Array>;
  }
  throw new Error("unsupported_stored_object_body");
}

function publicS3Endpoint(value: string | undefined): string | null {
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("invalid_s3_public_endpoint");
  }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("invalid_s3_public_endpoint");
  }
  return parsed.toString().replace(/\/$/u, "");
}

// S3-compatible servers may reject a single aws-chunked frame at 16 MiB even
// though the complete object is valid and much larger. A framework proxy can
// legitimately coalesce the request body into one Uint8Array, so normalize the
// transport chunks here instead of relying on upstream stream boundaries.
const S3_UPLOAD_STREAM_CHUNK_BYTES = 8 * 1_024 * 1_024;

function createBoundedS3UploadBody(input: StoredObjectStreamInput): Readonly<{
  body: Readable;
  observedBytes(): number;
}> {
  let observedBytes = 0;
  const source = input.body as unknown as AsyncIterable<Uint8Array>;

  async function* chunks(): AsyncGenerator<Buffer> {
    for await (const chunk of source) {
      observedBytes += chunk.byteLength;
      if (observedBytes > input.byteSize) {
        throw new StoredObjectTooLargeError({
          maxBytes: input.byteSize,
          observedBytes
        });
      }

      const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      for (let offset = 0; offset < bytes.byteLength; offset += S3_UPLOAD_STREAM_CHUNK_BYTES) {
        yield bytes.subarray(
          offset,
          Math.min(offset + S3_UPLOAD_STREAM_CHUNK_BYTES, bytes.byteLength)
        );
      }
    }
  }

  return {
    body: Readable.from(chunks()),
    observedBytes: () => observedBytes
  };
}

export function createS3StorageAdapter(env: Record<string, string | undefined> = process.env): StorageAdapter {
  const bucket = env.S3_BUCKET;
  const endpoint = env.S3_ENDPOINT;

  if (!bucket || !endpoint || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) {
    return createFileSystemStorageAdapter(env.AIQSA_UPLOAD_STORAGE_DIR || ".aiqsa/uploads");
  }

  const credentials = {
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY
  };
  const region = env.S3_REGION || "us-east-1";
  const client = new S3Client({
    credentials,
    endpoint,
    forcePathStyle: true,
    region
  });

  const publicEndpoint = publicS3Endpoint(env.S3_PUBLIC_ENDPOINT);
  const publicClient = publicEndpoint
    ? new S3Client({ credentials, endpoint: publicEndpoint, forcePathStyle: true, region })
    : null;

  async function readOutput(
    storageKey: string,
    options: StoredObjectReadOptions = {}
  ): Promise<GetObjectCommandOutput> {
    const maxBytes = normalizedMaxBytes(options.maxBytes);
    const signal = options.signal;
    throwIfAborted(signal);
    try {
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: storageKey,
        Range: typeof maxBytes === "undefined" ? undefined : `bytes=0-${maxBytes}`
      });
      const output = signal
        ? await client.send(command, { abortSignal: signal })
        : await client.send(command);
      throwIfAborted(signal);
      if (typeof output.ContentLength === "number" && typeof maxBytes !== "undefined" &&
        output.ContentLength > maxBytes) {
        const error = new StoredObjectTooLargeError({
          maxBytes,
          observedBytes: output.ContentLength
        });
        if (typeof output.Body === "object" && output.Body !== null) {
          cancelStoredObjectBody(output.Body, error);
        }
        throw error;
      }
      return output;
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      throw error;
    }
  }

  const directMultipartUpload: DirectMultipartUploadAdapter | undefined = publicClient
    ? {
        async abortMultipartUpload(input) {
          try {
            await client.send(new AbortMultipartUploadCommand({
              Bucket: bucket,
              Key: input.storageKey,
              UploadId: input.uploadId
            }));
          } catch (error) {
            const record = typeof error === "object" && error !== null
              ? error as { $metadata?: { httpStatusCode?: number }; name?: string }
              : null;
            if (record?.name !== "NoSuchUpload" && record?.$metadata?.httpStatusCode !== 404) {
              throw error;
            }
          }
        },
        async completeMultipartUpload(input) {
          await client.send(new CompleteMultipartUploadCommand({
            Bucket: bucket,
            Key: input.storageKey,
            MultipartUpload: {
              Parts: input.parts.map((part) => ({
                ETag: part.etag,
                PartNumber: part.partNumber
              }))
            },
            UploadId: input.uploadId
          }));
        },
        async createMultipartUpload(input) {
          const created = await client.send(new CreateMultipartUploadCommand({
            Bucket: bucket,
            ContentType: input.contentType,
            Key: input.storageKey
          }));
          if (!created.UploadId) throw new Error("multipart_upload_id_missing");
          return { uploadId: created.UploadId };
        },
        async presignMultipartPart(input) {
          if (!Number.isSafeInteger(input.partNumber) || input.partNumber < 1 ||
            input.partNumber > 10_000 || !Number.isSafeInteger(input.expiresInSeconds) ||
            input.expiresInSeconds < 1 || input.expiresInSeconds > 3_600) {
            throw new RangeError("multipart_presign_input_invalid");
          }
          return getSignedUrl(
            publicClient,
            new UploadPartCommand({
              Bucket: bucket,
              Key: input.storageKey,
              PartNumber: input.partNumber,
              UploadId: input.uploadId
            }),
            { expiresIn: input.expiresInSeconds }
          );
        }
      }
    : undefined;

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
      const output = await readOutput(storageKey, { maxBytes, signal });

      return {
        body: await s3BodyToBuffer(output.Body, { maxBytes, signal }),
        contentType: output.ContentType ?? "application/octet-stream",
        storageKey
      };
    },
    async getObjectStream(storageKey, options) {
      const maxBytes = normalizedMaxBytes(options?.maxBytes);
      const signal = options?.signal;
      const output = await readOutput(storageKey, { maxBytes, signal });
      const byteSize = output.ContentLength;
      if (!Number.isSafeInteger(byteSize) || Number(byteSize) < 0 || !output.Body) {
        throw new Error("stored_object_metadata_invalid");
      }
      return {
        body: boundedExactWebStream(s3BodyToWebStream(output.Body), {
          byteSize: Number(byteSize),
          maxBytes,
          signal
        }),
        byteSize: Number(byteSize),
        contentType: output.ContentType ?? "application/octet-stream",
        storageKey
      };
    },
    async inspectObject(storageKey, options) {
      const maxBytes = normalizedMaxBytes(options?.maxBytes);
      const signal = options?.signal;
      const output = await readOutput(storageKey, { maxBytes, signal });
      return inspectStoredObjectStream(s3BodyToStream(output.Body), {
        contentType: output.ContentType ?? "application/octet-stream",
        maxBytes,
        needles: options?.needles,
        sampleBytes: options?.sampleBytes,
        signal,
        storageKey
      });
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
    },
    async putObjectStream(input) {
      if (!Number.isSafeInteger(input.byteSize) || input.byteSize < 1) {
        throw new RangeError("invalid_stored_object_stream_size");
      }
      const upload = createBoundedS3UploadBody(input);
      try {
        const command = new PutObjectCommand({
          Body: upload.body,
          Bucket: bucket,
          ContentLength: input.byteSize,
          ContentType: input.contentType,
          Key: input.storageKey
        });
        if (input.signal) await client.send(command, { abortSignal: input.signal });
        else await client.send(command);
        if (upload.observedBytes() !== input.byteSize) throw new Error("stored_object_size_mismatch");
      } catch (error) {
        if (input.signal?.aborted) throw abortReason(input.signal);
        throw error;
      }
    },
    ...(directMultipartUpload ? { directMultipartUpload } : {})
  };
}
