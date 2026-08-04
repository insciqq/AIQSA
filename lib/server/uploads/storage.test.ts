import { GetObjectCommand } from "@aws-sdk/client-s3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { s3Send } = vi.hoisted(() => ({ s3Send: vi.fn() }));

vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-s3")>();

  return {
    ...actual,
    S3Client: class {
      send = s3Send;
    }
  };
});

import {
  createFileSystemStorageAdapter,
  createMemoryStorageAdapter,
  createS3StorageAdapter,
  isStoredObjectTooLargeError,
  StoredObjectTooLargeError,
  type StoredObjectInput
} from "./storage";

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
});

describe("S3 storage bounded reads", () => {
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

  it("keeps the legacy transformer path but fails closed for a bounded non-streaming body", async () => {
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
});
