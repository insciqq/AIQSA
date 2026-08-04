// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  readBoundedFormData,
  readBoundedRequestBody,
  readJsonBody,
  RequestBodyTooLargeError
} from "./requestBody";
import { createUploadPermitGate } from "./uploadPermitGate";

function streamingRequest(chunks: Uint8Array[], headers?: HeadersInit): { cancelled: unknown[]; request: Request } {
  const cancelled: unknown[] = [];
  const body = new ReadableStream<Uint8Array>({
    cancel(reason) {
      cancelled.push(reason);
    },
    pull(controller) {
      const next = chunks.shift();
      if (next) {
        controller.enqueue(next);
      } else {
        controller.close();
      }
    }
  });

  return {
    cancelled,
    request: new Request("http://app.local/body", {
      body,
      duplex: "half",
      headers,
      method: "POST"
    } as RequestInit)
  };
}

describe("bounded request bodies", () => {
  it("accepts an exact byte limit across fragmented chunks", async () => {
    const { request } = streamingRequest([new Uint8Array([1, 2]), new Uint8Array([3])]);

    await expect(readBoundedRequestBody(request, { maxBytes: 3 })).resolves.toEqual(new Uint8Array([1, 2, 3]));
  });

  it("rejects a declared body before reading", async () => {
    let reads = 0;
    let cancellations = 0;
    const request = {
      body: {
        cancel: async () => {
          cancellations += 1;
        },
        getReader() {
          return {
            cancel: async () => undefined,
            read: async () => {
              reads += 1;
              return { done: true, value: undefined };
            },
            releaseLock: () => undefined
          };
        }
      },
      headers: new Headers({ "content-length": "4" }),
      signal: new AbortController().signal
    } as unknown as Request;

    await expect(readBoundedRequestBody(request, { maxBytes: 3 })).rejects.toMatchObject({
      actualBytes: 4,
      limitBytes: 3
    });
    expect(reads).toBe(0);
    expect(cancellations).toBe(1);
  });

  it.each([
    ["0004", 4],
    ["9007199254740992", 9_007_199_254_740_992n]
  ])("rejects the valid decimal content length %s before reading", async (contentLength, actualBytes) => {
    let reads = 0;
    const request = {
      body: {
        cancel: async () => undefined,
        getReader() {
          return {
            cancel: async () => undefined,
            read: async () => {
              reads += 1;
              return { done: true, value: undefined };
            },
            releaseLock: () => undefined
          };
        }
      },
      headers: new Headers({ "content-length": contentLength }),
      signal: new AbortController().signal
    } as unknown as Request;

    await expect(readBoundedRequestBody(request, { maxBytes: 3 })).rejects.toMatchObject({
      actualBytes,
      limitBytes: 3
    });
    expect(reads).toBe(0);
  });

  it("counts actual bytes and cancels on the first chunk over the limit", async () => {
    const cancelled: unknown[] = [];
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];
    const request = {
      body: {
        getReader() {
          return {
            cancel: async (reason: unknown) => {
              cancelled.push(reason);
            },
            read: async () => {
              const value = chunks.shift();
              return value ? { done: false, value } : { done: true, value: undefined };
            },
            releaseLock: () => undefined
          };
        }
      },
      headers: new Headers({ "content-length": "2" }),
      signal: new AbortController().signal
    } as unknown as Request;

    await expect(readBoundedRequestBody(request, { maxBytes: 3 })).rejects.toBeInstanceOf(RequestBodyTooLargeError);
    expect(cancelled).toHaveLength(1);
  });

  it("treats malformed content length as untrusted and enforces actual bytes", async () => {
    const { request } = streamingRequest([new Uint8Array([1, 2, 3, 4])], { "content-length": "invalid" });

    await expect(readBoundedRequestBody(request, { maxBytes: 3 })).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });

  it("accepts actual bytes when a larger valid content length remains within the limit", async () => {
    const { request } = streamingRequest([new Uint8Array([1, 2])], { "content-length": "10" });

    await expect(readBoundedRequestBody(request, { maxBytes: 10 })).resolves.toEqual(new Uint8Array([1, 2]));
  });

  it("does not trust a zero content length when actual bytes arrive", async () => {
    const { request } = streamingRequest([new Uint8Array([1, 2, 3, 4])], { "content-length": "0" });

    await expect(readBoundedRequestBody(request, { maxBytes: 3 })).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });

  it("preserves an explicit abort reason", async () => {
    const controller = new AbortController();
    const reason = new Error("caller_cancelled");
    const cancelled: unknown[] = [];
    controller.abort(reason);
    const request = new Request("http://app.local/body", {
      body: new ReadableStream<Uint8Array>({
        cancel(cancelReason) {
          cancelled.push(cancelReason);
        }
      }),
      duplex: "half",
      headers: { "content-length": "99" },
      method: "POST"
    } as RequestInit);

    await expect(readBoundedRequestBody(request, { maxBytes: 3, signal: controller.signal })).rejects.toBe(reason);
    expect(cancelled).toEqual([reason]);
  });

  it("cancels a pending reader when the caller aborts", async () => {
    const controller = new AbortController();
    const reason = new Error("pending_cancelled");
    const cancelled: unknown[] = [];
    const request = new Request("http://app.local/body", {
      body: new ReadableStream<Uint8Array>({
        cancel(cancelReason) {
          cancelled.push(cancelReason);
        }
      }),
      duplex: "half",
      method: "POST"
    } as RequestInit);
    const reading = readBoundedRequestBody(request, { maxBytes: 3, signal: controller.signal });

    controller.abort(reason);

    await expect(reading).rejects.toBe(reason);
    expect(cancelled).toEqual([reason]);
  });

  it("closes the race when abort happens while the reader is acquired", async () => {
    const controller = new AbortController();
    const reason = new Error("acquire_cancelled");
    const cancelled: unknown[] = [];
    const request = {
      body: {
        getReader() {
          controller.abort(reason);
          return {
            cancel: async (cancelReason: unknown) => {
              cancelled.push(cancelReason);
            },
            read: async () => new Promise(() => undefined),
            releaseLock: () => undefined
          };
        }
      },
      headers: new Headers(),
      signal: controller.signal
    } as unknown as Request;

    await expect(
      readBoundedRequestBody(request, { maxBytes: 3, signal: controller.signal })
    ).rejects.toBe(reason);
    expect(cancelled).toEqual([reason]);
  });

  it("parses bounded UTF-8 JSON", async () => {
    const previous = process.env.AIQSA_JSON_REQUEST_BODY_MAX_BYTES;
    process.env.AIQSA_JSON_REQUEST_BODY_MAX_BYTES = "64";
    try {
      const request = new Request("http://app.local/body", {
        body: JSON.stringify({ text: "Привет" }),
        headers: { "content-type": "application/json" },
        method: "POST"
      });

      await expect(readJsonBody(request)).resolves.toEqual({ text: "Привет" });
    } finally {
      if (previous === undefined) delete process.env.AIQSA_JSON_REQUEST_BODY_MAX_BYTES;
      else process.env.AIQSA_JSON_REQUEST_BODY_MAX_BYTES = previous;
    }
  });

  it("reconstructs bounded multipart form data", async () => {
    const form = new FormData();
    form.set("name", "bounded");
    const request = new Request("http://app.local/body", { body: form, method: "POST" });

    const parsed = await readBoundedFormData(request, 1024);
    expect(parsed.get("name")).toBe("bounded");
  });
});

describe("upload permit gate", () => {
  it("rejects immediately at capacity and releases idempotently", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const gate = createUploadPermitGate(1);
    const release = gate.tryAcquire();

    expect(release).toBeTypeOf("function");
    expect(gate.tryAcquire()).toBeNull();
    expect(gate.snapshot()).toEqual({ active: 1, capacity: 1, rejected: 1 });
    release?.();
    release?.();
    expect(gate.snapshot().active).toBe(0);
    expect(gate.tryAcquire()).toBeTypeOf("function");
    warn.mockRestore();
  });

  it("counts every rejection while bounding structured warnings", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const gate = createUploadPermitGate(1);
    const release = gate.tryAcquire();

    for (let index = 0; index < 5; index += 1) {
      expect(gate.tryAcquire()).toBeNull();
    }

    expect(gate.snapshot().rejected).toBe(5);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls.map(([entry]) => JSON.parse(String(entry)).rejected)).toEqual([1, 2, 4]);
    release?.();
    warn.mockRestore();
  });
});
