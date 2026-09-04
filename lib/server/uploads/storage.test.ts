import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  PutObjectCommand,
  UploadPartCommand
} from "@aws-sdk/client-s3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const { presign, s3Send } = vi.hoisted(() => ({ presign: vi.fn(), s3Send: vi.fn() }));

vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-s3")>();

  return {
    ...actual,
    S3Client: class {
      send = s3Send;
    }
  };
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: presign }));

import {
  createFileSystemStorageAdapter,
  createS3StorageAdapter,
  isStoredObjectTooLargeError,
  StoredObjectTooLargeError,
  type StoredObjectInput
} from "./storage";
import { createMemoryStorageAdapter } from "@/tests/support/storage";

const s3Env = {
  S3_ACCESS_KEY_ID: "test-access-key",
  S3_BUCKET: "test-bucket",
  S3_ENDPOINT: "http://127.0.0.1:9000",
  S3_SECRET_ACCESS_KEY: "test-secret-key"
};

function object(body: string, storageKey = "owned/object.bin"): StoredObjectInput {
  return {
    body: Buffer.from(body),
    contentType: "application/octet-stream",
    storageKey
  };
}

const temporaryRoots: string[] = [];

afterEach(async () => {
  presign.mockReset();
  s3Send.mockReset();

  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("memory storage bounded reads", () => {
  it("preserves unbounded callers and accepts an object exactly at maxBytes", async () => {
    const storage = createMemoryStorageAdapter();
    const input = object("four");
    await storage.putObject(input);

    await expect(storage.getObject(input.storageKey)).resolves.toBe(input);
    await expect(storage.getObject(input.storageKey, { maxBytes: 4 })).resolves.toBe(input);
  });

  it("rejects one byte over with the typed stable error", async () => {
    const storage = createMemoryStorageAdapter();
    const input = object("five!");
    await storage.putObject(input);

    const error = await storage.getObject(input.storageKey, { maxBytes: 4 }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(StoredObjectTooLargeError);
    expect(isStoredObjectTooLargeError(error)).toBe(true);
    expect(error).toMatchObject({
      code: "stored_object_too_large",
      maxBytes: 4,
      observedBytes: 5
    });
  });

  it("propagates a caller cancellation reason before returning stored bytes", async () => {
    const storage = createMemoryStorageAdapter();
    const input = object("four");
    await storage.putObject(input);
    const controller = new AbortController();
    const reason = new Error("caller_cancelled");
    controller.abort(reason);

    await expect(storage.getObject(input.storageKey, { maxBytes: 4, signal: controller.signal })).rejects.toBe(reason);
  });

  it("rejects invalid finite boundaries instead of silently disabling them", async () => {
    const storage = createMemoryStorageAdapter();
    const input = object("four");
    await storage.putObject(input);

    await expect(storage.getObject(input.storageKey, { maxBytes: 0 })).rejects.toThrow(
      "invalid_stored_object_max_bytes"
    );
    await expect(storage.getObject(input.storageKey, { maxBytes: Number.POSITIVE_INFINITY })).rejects.toThrow(
      "invalid_stored_object_max_bytes"
    );
  });
});

describe("filesystem storage bounded reads", () => {
  it("accepts the exact boundary and rejects the same object one byte below it", async () => {
    const root = await mkdtemp(join(tmpdir(), "aiqsa-storage-test-"));
    temporaryRoots.push(root);
    const storage = createFileSystemStorageAdapter(root);
    const input = object("five!");
    await storage.putObject(input);

    await expect(storage.getObject(input.storageKey, { maxBytes: 5 })).resolves.toMatchObject({
      body: input.body,
      storageKey: input.storageKey
    });
    await expect(storage.getObject(input.storageKey, { maxBytes: 4 })).rejects.toMatchObject({
      code: "stored_object_too_large",
      maxBytes: 4,
      observedBytes: 5
    });
  });

  it("propagates cancellation without opening an object read", async () => {
    const root = await mkdtemp(join(tmpdir(), "aiqsa-storage-test-"));
    temporaryRoots.push(root);
    const storage = createFileSystemStorageAdapter(root);
    const input = object("four");
    await storage.putObject(input);
    const controller = new AbortController();
    const reason = new Error("filesystem_read_cancelled");
    controller.abort(reason);

    await expect(storage.getObject(input.storageKey, { maxBytes: 4, signal: controller.signal })).rejects.toBe(reason);
  });

  it("streams writes and inspects hashes and markers across read chunks", async () => {
    const root = await mkdtemp(join(tmpdir(), "aiqsa-storage-test-"));
    temporaryRoots.push(root);
    const storage = createFileSystemStorageAdapter(root);
    const body = Buffer.from(`${"a".repeat(65_534)}MARKER-tail`);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(body.subarray(0, 7));
        controller.enqueue(body.subarray(7));
        controller.close();
      }
    });

    await storage.putObjectStream!({
      body: stream,
      byteSize: body.byteLength,
      contentType: "application/octet-stream",
      storageKey: "owned/stream.bin"
    });
    await expect(storage.inspectObject!("owned/stream.bin", {
      maxBytes: body.byteLength,
      needles: ["MARKER"],
      sampleBytes: 8
    })).resolves.toMatchObject({
      byteSize: body.byteLength,
      checksum: expect.stringMatching(/^[0-9a-f]{64}$/u),
      foundNeedles: ["MARKER"],
      sample: Buffer.from("aaaaaaaa")
    });
  });
});

describe("S3 storage bounded reads", () => {
  it("re-chunks a coalesced proxy body below S3-compatible streaming limits", async () => {
    const source = Buffer.alloc(16 * 1_024 * 1_024 + 1, 0x61);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(source);
        controller.close();
      }
    });
    const observedChunkBytes: number[] = [];
    s3Send.mockImplementationOnce(async (command: PutObjectCommand) => {
      expect(command).toBeInstanceOf(PutObjectCommand);
      const uploaded = command.input.Body as AsyncIterable<Uint8Array>;
      for await (const chunk of uploaded) observedChunkBytes.push(chunk.byteLength);
      return {};
    });
    const storage = createS3StorageAdapter(s3Env);

    await storage.putObjectStream!({
      body,
      byteSize: source.byteLength,
      contentType: "application/pdf",
      storageKey: "owned/coalesced.pdf"
    });

    expect(observedChunkBytes).toEqual([8 * 1_024 * 1_024, 8 * 1_024 * 1_024, 1]);
    expect((s3Send.mock.calls[0]?.[0] as PutObjectCommand).input.ContentLength).toBe(source.byteLength);
  });

  it("rejects a failing upload body with the source error and aborts the PUT", async () => {
    const failure = new Error("source_stream_failed");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.error(failure);
      }
    });
    // Like the SDK's node handler: the body is piped with no error listener
    // and the request only settles through its abort signal.
    s3Send.mockImplementationOnce(
      (command: PutObjectCommand, options?: { abortSignal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options?.abortSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("transport aborted", "AbortError")),
            { once: true }
          );
          (command.input.Body as Readable).pipe(new PassThrough());
        })
    );
    const storage = createS3StorageAdapter(s3Env);

    await expect(storage.putObjectStream!({
      body,
      byteSize: 4,
      contentType: "application/octet-stream",
      storageKey: "owned/faulted.bin"
    })).rejects.toBe(failure);
    expect((s3Send.mock.calls[0]?.[1] as { abortSignal?: AbortSignal }).abortSignal?.aborted).toBe(true);
  });

  it("requests only maxBytes plus one sentinel byte and accepts the exact boundary", async () => {
    s3Send.mockResolvedValue({
      Body: {
        async *[Symbol.asyncIterator]() {
          yield Buffer.from("fo");
          yield Buffer.from("ur");
        }
      },
      ContentLength: 4,
      ContentType: "application/pdf"
    });
    const storage = createS3StorageAdapter(s3Env);

    await expect(storage.getObject("owned/object.pdf", { maxBytes: 4 })).resolves.toEqual({
      body: Buffer.from("four"),
      contentType: "application/pdf",
      storageKey: "owned/object.pdf"
    });

    const command = s3Send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect((command as GetObjectCommand).input).toMatchObject({
      Bucket: "test-bucket",
      Key: "owned/object.pdf",
      Range: "bytes=0-4"
    });
  });

  it("stops at one byte over when S3 response metadata understates the stream", async () => {
    const destroy = vi.fn();
    const body = {
      destroy,
      async *[Symbol.asyncIterator]() {
        yield Buffer.from("four");
        yield Buffer.from("!");
        throw new Error("must_not_read_past_sentinel");
      }
    };
    s3Send.mockResolvedValue({ Body: body, ContentLength: 4 });
    const storage = createS3StorageAdapter(s3Env);

    await expect(storage.getObject("owned/object.bin", { maxBytes: 4 })).rejects.toMatchObject({
      code: "stored_object_too_large",
      maxBytes: 4,
      observedBytes: 5
    });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("cancels the response before iteration when declared response bytes exceed the limit", async () => {
    const destroy = vi.fn();
    const iterate = vi.fn();
    const body = {
      destroy,
      [Symbol.asyncIterator]() {
        iterate();
        return {
          async next() {
            return { done: true as const, value: undefined };
          }
        };
      }
    };
    s3Send.mockResolvedValue({ Body: body, ContentLength: 5 });
    const storage = createS3StorageAdapter(s3Env);

    await expect(storage.getObject("owned/object.bin", { maxBytes: 4 })).rejects.toMatchObject({
      code: "stored_object_too_large",
      maxBytes: 4,
      observedBytes: 5
    });
    expect(destroy).toHaveBeenCalledOnce();
    expect(iterate).not.toHaveBeenCalled();
  });

  it("passes the AbortSignal to S3 and cancels an in-flight body with the original reason", async () => {
    let readCount = 0;
    let secondReadStarted: (() => void) | undefined;
    const waitingForSecondRead = new Promise<void>((resolve) => {
      secondReadStarted = resolve;
    });
    const never = new Promise<IteratorResult<Buffer>>(() => undefined);
    const destroy = vi.fn();
    const body = {
      destroy,
      [Symbol.asyncIterator]() {
        return {
          next() {
            readCount += 1;

            if (readCount === 1) {
              return Promise.resolve({ done: false as const, value: Buffer.from("a") });
            }

            secondReadStarted?.();
            return never;
          }
        };
      }
    };
    s3Send.mockResolvedValue({ Body: body, ContentLength: 1 });
    const storage = createS3StorageAdapter(s3Env);
    const controller = new AbortController();
    const reason = new Error("s3_read_cancelled");
    const reading = storage.getObject("owned/object.bin", { maxBytes: 4, signal: controller.signal });
    await waitingForSecondRead;
    controller.abort(reason);

    await expect(reading).rejects.toBe(reason);
    expect(destroy).toHaveBeenCalledOnce();
    expect(s3Send.mock.calls[0]?.[1]).toMatchObject({ abortSignal: controller.signal });
  });

  it("normalizes transport cancellation to the caller's original reason", async () => {
    s3Send.mockImplementation(
      (_command: unknown, options?: { abortSignal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options?.abortSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("transport aborted", "AbortError")),
            { once: true }
          );
        })
    );
    const storage = createS3StorageAdapter(s3Env);
    const controller = new AbortController();
    const reason = new Error("transport_read_cancelled");
    const reading = storage.getObject("owned/object.bin", { maxBytes: 4, signal: controller.signal });
    controller.abort(reason);

    await expect(reading).rejects.toBe(reason);
  });

  it("keeps the byte-array transformer path but fails closed for a bounded non-streaming body", async () => {
    const transformToByteArray = vi.fn().mockResolvedValue(new Uint8Array(Buffer.from("four")));
    s3Send.mockResolvedValue({ Body: { transformToByteArray }, ContentLength: 4 });
    const storage = createS3StorageAdapter(s3Env);

    await expect(storage.getObject("owned/object.bin")).resolves.toMatchObject({ body: Buffer.from("four") });
    expect(transformToByteArray).toHaveBeenCalledOnce();

    transformToByteArray.mockClear();
    await expect(storage.getObject("owned/object.bin", { maxBytes: 4 })).rejects.toThrow(
      "unsupported_stored_object_body"
    );
    expect(transformToByteArray).not.toHaveBeenCalled();
  });

  it("exposes direct multipart authority only for an explicit public endpoint", async () => {
    expect(createS3StorageAdapter(s3Env).directMultipartUpload).toBeUndefined();
    s3Send.mockResolvedValueOnce({ UploadId: "upload-1" });
    presign.mockResolvedValue("https://objects.example.test/signed-part");
    const storage = createS3StorageAdapter({
      ...s3Env,
      S3_PUBLIC_ENDPOINT: "https://objects.example.test"
    });
    const direct = storage.directMultipartUpload!;

    await expect(direct.createMultipartUpload({
      contentType: "application/pdf",
      storageKey: "owned/object.pdf"
    })).resolves.toEqual({ uploadId: "upload-1" });
    expect(s3Send.mock.calls[0]?.[0]).toBeInstanceOf(CreateMultipartUploadCommand);

    await expect(direct.presignMultipartPart({
      expiresInSeconds: 900,
      partNumber: 1,
      storageKey: "owned/object.pdf",
      uploadId: "upload-1"
    })).resolves.toBe("https://objects.example.test/signed-part");
    expect(presign.mock.calls[0]?.[1]).toBeInstanceOf(UploadPartCommand);

    s3Send.mockResolvedValue({});
    await direct.completeMultipartUpload({
      parts: [{ etag: '"etag-1"', partNumber: 1 }],
      storageKey: "owned/object.pdf",
      uploadId: "upload-1"
    });
    await direct.abortMultipartUpload({
      storageKey: "owned/object.pdf",
      uploadId: "upload-2"
    });
    expect(s3Send.mock.calls.at(-2)?.[0]).toBeInstanceOf(CompleteMultipartUploadCommand);
    expect(s3Send.mock.calls.at(-1)?.[0]).toBeInstanceOf(AbortMultipartUploadCommand);
  });

  it("treats an already-finished multipart abort as idempotent", async () => {
    const storage = createS3StorageAdapter({
      ...s3Env,
      S3_PUBLIC_ENDPOINT: "https://objects.example.test"
    });
    const direct = storage.directMultipartUpload!;
    s3Send.mockRejectedValueOnce({ name: "NoSuchUpload" });

    await expect(direct.abortMultipartUpload({
      storageKey: "owned/already-finished.pdf",
      uploadId: "upload-finished"
    })).resolves.toBeUndefined();

    s3Send.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(direct.abortMultipartUpload({
      storageKey: "owned/pending.pdf",
      uploadId: "upload-pending"
    })).rejects.toThrow("storage unavailable");
  });
});
