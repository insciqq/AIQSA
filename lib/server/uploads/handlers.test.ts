// @vitest-environment node

import { describe, expect, it } from "vitest";
import { getAuthConfig, TEST_AUTH_TOKEN } from "../auth/config";
import { createTestAuth } from "../auth/testRequestAuth";
import { createUploadPermitGate } from "../http/uploadPermitGate";
import { PdfExtractionError, type PdfExtractionErrorCode } from "./pdf";
import { createMemoryStorageAdapter } from "./storage";
import { createUploadHandler } from "./handlers";

const oneByOnePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
);
const config = getAuthConfig({
  AIQSA_BOOTSTRAP_AUTH_TOKEN: TEST_AUTH_TOKEN,
  AIQSA_AUTH_SESSION_SECRET: "secret"
});
const auth = createTestAuth({
  user: {
    id: config.bootstrapUserId
  }
});

function authenticatedUploadRequest(file: File, signal?: AbortSignal): Request {
  const form = new FormData();
  form.set("file", file);

  return new Request("http://app.local/api/uploads", {
    body: form,
    headers: {
      cookie: auth.cookie
    },
    method: "POST",
    ...(signal ? { signal } : {})
  });
}

describe("upload handler", () => {
  it("rejects anonymous uploads", async () => {
    const POST = createUploadHandler({
      createAttachment: async () => {
        throw new Error("should not create");
      },
      resolveAuth: auth.resolveAuth
    });

    const response = await POST(new Request("http://app.local/api/uploads", { method: "POST" }));

    expect(response.status).toBe(401);
  });

  it("rejects an oversized multipart envelope before parsing it", async () => {
    const boundary = "aiqsa-test-boundary";
    const multipartChunk = new TextEncoder().encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="avatar.png"\r\nContent-Type: image/png\r\n\r\noversized`
    );
    let cancelledWith: unknown;
    const POST = createUploadHandler({
      createAttachment: async () => {
        throw new Error("should not create");
      },
      getBodyConfig: () => ({ uploadMaxConcurrency: 1, uploadMultipartMaxBytes: 16 }),
      resolveAuth: auth.resolveAuth,
      uploadPermitGate: createUploadPermitGate(1)
    });
    const request = new Request("http://app.local/api/uploads", {
      body: new ReadableStream<Uint8Array>({
        cancel(reason) {
          cancelledWith = reason;
        },
        start(controller) {
          controller.enqueue(multipartChunk);
        }
      }),
      duplex: "half",
      headers: {
        cookie: auth.cookie,
        "content-type": `multipart/form-data; boundary=${boundary}`
      },
      method: "POST"
    } as RequestInit);

    const response = await POST(request);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: "file_too_large", limit: 16 });
    expect(cancelledWith).toMatchObject({
      actualBytes: multipartChunk.byteLength,
      limitBytes: 16,
      message: "request_body_too_large",
      name: "RequestBodyTooLargeError"
    });
  });

  it("rejects upload concurrency without reading the request body", async () => {
    const gate = createUploadPermitGate(1);
    const release = gate.tryAcquire();
    const POST = createUploadHandler({
      createAttachment: async () => {
        throw new Error("should not create");
      },
      getBodyConfig: () => ({ uploadMaxConcurrency: 1, uploadMultipartMaxBytes: 1024 }),
      resolveAuth: auth.resolveAuth,
      uploadPermitGate: gate
    });
    const request = authenticatedUploadRequest(new File([oneByOnePng], "avatar.png", { type: "image/png" }));
    const originalBody = request.body;
    let bodyReads = 0;
    Object.defineProperty(request, "body", {
      configurable: true,
      get() {
        bodyReads += 1;
        return originalBody;
      }
    });

    const response = await POST(request);

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(bodyReads).toBe(0);
    release?.();
  });

  it("releases the upload permit after malformed multipart input", async () => {
    const gate = createUploadPermitGate(1);
    const POST = createUploadHandler({
      createAttachment: async () => {
        throw new Error("should not create");
      },
      getBodyConfig: () => ({ uploadMaxConcurrency: 1, uploadMultipartMaxBytes: 1024 }),
      resolveAuth: auth.resolveAuth,
      uploadPermitGate: gate
    });
    const response = await POST(new Request("http://app.local/api/uploads", {
      body: "not-multipart",
      headers: { cookie: auth.cookie, "content-type": "multipart/form-data; boundary=missing" },
      method: "POST"
    }));

    expect(response.status).toBe(400);
    expect(gate.snapshot().active).toBe(0);
    expect(gate.tryAcquire()).toBeTypeOf("function");
  });

  it("releases the upload permit when the request is cancelled", async () => {
    const gate = createUploadPermitGate(1);
    const controller = new AbortController();
    const reason = new Error("upload_cancelled");
    const POST = createUploadHandler({
      createAttachment: async () => {
        throw new Error("should not create");
      },
      getBodyConfig: () => ({ uploadMaxConcurrency: 1, uploadMultipartMaxBytes: 1024 }),
      resolveAuth: auth.resolveAuth,
      uploadPermitGate: gate
    });
    const request = new Request("http://app.local/api/uploads", {
      body: new ReadableStream<Uint8Array>(),
      duplex: "half",
      headers: {
        cookie: auth.cookie,
        "content-type": "multipart/form-data; boundary=pending"
      },
      method: "POST",
      signal: controller.signal
    } as RequestInit);

    controller.abort(reason);

    await expect(POST(request)).rejects.toBe(reason);
    expect(gate.snapshot().active).toBe(0);
  });

  it("stores an authenticated image upload and persists metadata", async () => {
    const storage = createMemoryStorageAdapter();
    const gate = createUploadPermitGate(1);
    const POST = createUploadHandler({
      createAttachment: async (input) => ({
        ...input,
        id: "attachment-1"
      }),
      resolveAuth: auth.resolveAuth,
      storage,
      uploadPermitGate: gate
    });
    const response = await POST(authenticatedUploadRequest(new File([oneByOnePng], "avatar.png", { type: "image/png" })));

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      attachment: {
        checksum: string;
        id: string;
        metadata: { image: { height: number; width: number } };
        storageKey: string;
      };
    };

    expect(body.attachment.id).toBe("attachment-1");
    expect(body.attachment.metadata.image).toMatchObject({ height: 1, width: 1 });
    expect(storage.objects.has(body.attachment.storageKey)).toBe(true);
    expect(gate.snapshot().active).toBe(0);
  });

  it("uses a unique object key for identical uploads", async () => {
    const storage = createMemoryStorageAdapter();
    let nextId = 1;
    const POST = createUploadHandler({
      createAttachment: async (input) => ({
        ...input,
        id: `attachment-${nextId++}`
      }),
      resolveAuth: auth.resolveAuth,
      storage
    });
    const upload = () =>
      POST(authenticatedUploadRequest(new File([oneByOnePng], "same.png", { type: "image/png" })));
    const first = (await (await upload()).json()) as { attachment: { checksum: string; storageKey: string } };
    const second = (await (await upload()).json()) as { attachment: { checksum: string; storageKey: string } };

    expect(first.attachment.checksum).toBe(second.attachment.checksum);
    expect(first.attachment.storageKey).not.toBe(second.attachment.storageKey);
    expect(storage.objects.size).toBe(2);
  });

  it("removes a just-written object and settles its outbox job when attachment persistence fails", async () => {
    const storage = createMemoryStorageAdapter();
    const gate = createUploadPermitGate(1);
    const staged: string[] = [];
    const completed: string[] = [];
    const POST = createUploadHandler({
      createAttachment: async () => {
        throw new Error("attachment_row_failed");
      },
      deletionOutbox: {
        async complete(jobId) {
          completed.push(jobId);
        },
        async stage(storageKey) {
          staged.push(storageKey);
          return { id: "cleanup-job" };
        }
      },
      resolveAuth: auth.resolveAuth,
      storage,
      uploadPermitGate: gate
    });

    await expect(
      POST(authenticatedUploadRequest(new File([oneByOnePng], "failed.png", { type: "image/png" })))
    ).rejects.toThrow("attachment_row_failed");
    expect(staged).toHaveLength(1);
    expect(completed).toEqual(["cleanup-job"]);
    expect(storage.objects.size).toBe(0);
    expect(gate.snapshot().active).toBe(0);
  });

  it("releases the upload permit when object storage fails", async () => {
    const gate = createUploadPermitGate(1);
    const POST = createUploadHandler({
      createAttachment: async () => {
        throw new Error("should not create");
      },
      resolveAuth: auth.resolveAuth,
      storage: {
        async deleteObject() {},
        async getObject() {
          throw new Error("should not read");
        },
        async putObject() {
          throw new Error("storage_unavailable");
        }
      },
      uploadPermitGate: gate
    });

    await expect(
      POST(authenticatedUploadRequest(new File([oneByOnePng], "failed.png", { type: "image/png" })))
    ).rejects.toThrow("storage_unavailable");
    expect(gate.snapshot().active).toBe(0);
  });

  it("leaves a durable cleanup job when post-put object deletion fails", async () => {
    const memory = createMemoryStorageAdapter();
    const staged: string[] = [];
    const completed: string[] = [];
    const POST = createUploadHandler({
      createAttachment: async () => {
        throw new Error("attachment_row_failed");
      },
      deletionOutbox: {
        async complete(jobId) {
          completed.push(jobId);
        },
        async stage(storageKey) {
          staged.push(storageKey);
          return { id: "retryable-cleanup-job" };
        }
      },
      resolveAuth: auth.resolveAuth,
      storage: {
        ...memory,
        async deleteObject() {
          throw new Error("storage_unavailable");
        }
      }
    });

    await expect(
      POST(authenticatedUploadRequest(new File([oneByOnePng], "retry.png", { type: "image/png" })))
    ).rejects.toThrow("attachment_row_failed");
    expect(staged).toHaveLength(1);
    expect(completed).toEqual([]);
    expect(memory.objects.has(staged[0]!)).toBe(true);
  });

  it("stores a text document upload with extracted text and document metadata", async () => {
    const storage = createMemoryStorageAdapter();
    const POST = createUploadHandler({
      createAttachment: async (input) => ({
        ...input,
        id: "attachment-1"
      }),
      resolveAuth: auth.resolveAuth,
      storage
    });
    const response = await POST(
      authenticatedUploadRequest(new File([Buffer.from("# Runbook\r\nUse search.\r\n")], "runbook.md", { type: "text/plain" }))
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      attachment: {
        extractedText: string;
        kind: string;
        metadata: { document: { characterCount: number; kind: string } };
        storageKey: string;
      };
    };

    expect(body.attachment.kind).toBe("document");
    expect(body.attachment.extractedText).toBe("# Runbook\nUse search.\n");
    expect(body.attachment).toMatchObject({
      mimeType: "text/markdown"
    });
    expect(body.attachment.metadata.document).toEqual({
      characterCount: body.attachment.extractedText.length,
      extractedTextMaxChars: 20000,
      kind: "markdown",
      truncated: false
    });
    expect(storage.objects.has(body.attachment.storageKey)).toBe(true);
  });

  it("pretty-prints JSON document uploads before persistence", async () => {
    const POST = createUploadHandler({
      createAttachment: async (input) => ({
        ...input,
        id: "attachment-1"
      }),
      resolveAuth: auth.resolveAuth,
      storage: createMemoryStorageAdapter()
    });
    const response = await POST(
      authenticatedUploadRequest(new File([Buffer.from("{\"count\":2}")], "payload.json", { type: "application/json" }))
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      attachment: {
        extractedText: string;
        metadata: { document: { kind: string } };
      };
    };

    expect(body.attachment.extractedText).toBe("{\n  \"count\": 2\n}\n");
    expect(body.attachment.metadata.document.kind).toBe("json");
  });

  it("caps extracted document text before persistence", async () => {
    const POST = createUploadHandler({
      createAttachment: async (input) => ({
        ...input,
        id: "attachment-1"
      }),
      resolveAuth: auth.resolveAuth,
      storage: createMemoryStorageAdapter()
    });
    const response = await POST(
      authenticatedUploadRequest(new File([Buffer.from("a".repeat(20_050))], "notes.txt", { type: "text/plain" }))
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      attachment: {
        extractedText: string;
        metadata: { document: { extractedTextMaxChars: number; truncated: boolean } };
      };
    };

    expect(body.attachment.extractedText).toHaveLength(20_000);
    expect(body.attachment.metadata.document).toMatchObject({
      extractedTextMaxChars: 20_000,
      truncated: true
    });
  });

  it("rejects spoofed magic bytes before storage or attachment creation", async () => {
    const storage = createMemoryStorageAdapter();
    const gate = createUploadPermitGate(1);
    let attachmentCreated = false;
    const POST = createUploadHandler({
      createAttachment: async (input) => {
        attachmentCreated = true;

        return {
          ...input,
          id: "attachment-1"
        };
      },
      resolveAuth: auth.resolveAuth,
      storage,
      uploadPermitGate: gate
    });
    const response = await POST(
      authenticatedUploadRequest(new File([Buffer.from("%PDF-1.4\n")], "spoof.png", { type: "image/png" }))
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "unsupported_type" });
    expect(attachmentCreated).toBe(false);
    expect(storage.objects.size).toBe(0);
    expect(gate.snapshot().active).toBe(0);
  });

  it("stores bounded partial PDF text with a strict processing projection", async () => {
    const storage = createMemoryStorageAdapter();
    const POST = createUploadHandler({
      createAttachment: async (input) => ({
        ...input,
        id: "attachment-partial"
      }),
      extractPdfTextChunks: async (_buffer, options) => {
        expect(options?.signal).toBeInstanceOf(AbortSignal);
        expect(options?.config).toMatchObject({
          extractedTextMaxChars: 20_000,
          maxPages: 500,
          timeoutMs: 20_000
        });

        return {
          chunks: [{ index: 0, page: 1, text: "Bounded PDF text" }],
          extractedCharacterCount: 16,
          pageCount: 8,
          pagesProcessed: 3,
          status: "partial",
          text: "Bounded PDF text",
          truncationReason: "text_limit"
        };
      },
      resolveAuth: auth.resolveAuth,
      storage
    });

    const response = await POST(
      authenticatedUploadRequest(new File([Buffer.from("%PDF-1.4\n")], "partial.pdf", { type: "application/pdf" }))
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      attachment: {
        extractedText: string;
        metadata: { pdf: Record<string, unknown> };
        processing: Record<string, unknown>;
        status: string;
        storageKey: string;
      };
    };
    const processing = {
      extractedCharacterCount: 16,
      pageCount: 8,
      pagesProcessed: 3,
      status: "partial",
      truncationReason: "text_limit"
    };

    expect(body.attachment).toMatchObject({
      extractedText: "Bounded PDF text",
      processing,
      status: "ready"
    });
    expect(body.attachment.metadata.pdf).toEqual({
      chunks: [{ index: 0, page: 1, text: "Bounded PDF text" }],
      extractedTextMaxChars: 20_000,
      ...processing
    });
    expect(body.attachment.metadata.pdf).not.toHaveProperty("originalCharacterCount");
    expect(storage.objects.has(body.attachment.storageKey)).toBe(true);
  });

  it("stores a textless PDF as ready without fabricating extracted text", async () => {
    const storage = createMemoryStorageAdapter();
    const POST = createUploadHandler({
      createAttachment: async (input) => ({
        ...input,
        id: "attachment-no-text"
      }),
      extractPdfTextChunks: async () => ({
        chunks: [],
        extractedCharacterCount: 0,
        pageCount: 2,
        pagesProcessed: 2,
        status: "no_text",
        text: ""
      }),
      resolveAuth: auth.resolveAuth,
      storage
    });

    const response = await POST(
      authenticatedUploadRequest(new File([Buffer.from("%PDF-1.4\n")], "scan.pdf", { type: "application/pdf" }))
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      attachment: {
        extractedText: string | null;
        processing: Record<string, unknown>;
        status: string;
        storageKey: string;
      };
    };
    expect(body.attachment).toMatchObject({
      extractedText: null,
      processing: {
        extractedCharacterCount: 0,
        pageCount: 2,
        pagesProcessed: 2,
        status: "no_text"
      },
      status: "ready"
    });
    expect(storage.objects.has(body.attachment.storageKey)).toBe(true);
  });

  it("stores a zero-emitted partial PDF as ready with no usable fallback text", async () => {
    const storage = createMemoryStorageAdapter();
    const POST = createUploadHandler({
      createAttachment: async (input) => ({
        ...input,
        id: "attachment-zero-partial"
      }),
      extractPdfTextChunks: async () => ({
        chunks: [],
        extractedCharacterCount: 0,
        pageCount: 1,
        pagesProcessed: 1,
        status: "partial",
        text: "",
        truncationReason: "text_limit"
      }),
      resolveAuth: auth.resolveAuth,
      storage
    });

    const response = await POST(
      authenticatedUploadRequest(new File([Buffer.from("%PDF-1.4\n")], "unicode.pdf", { type: "application/pdf" }))
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      attachment: {
        extractedText: string | null;
        metadata: { pdf: Record<string, unknown> };
        processing: Record<string, unknown>;
        status: string;
      };
    };
    const processing = {
      extractedCharacterCount: 0,
      pageCount: 1,
      pagesProcessed: 1,
      status: "partial",
      truncationReason: "text_limit"
    };
    expect(body.attachment).toMatchObject({
      extractedText: null,
      processing,
      status: "ready"
    });
    expect(body.attachment.metadata.pdf).toMatchObject(processing);
    expect(storage.objects.size).toBe(1);
  });

  it.each<{
    code: PdfExtractionErrorCode;
    expected: Record<string, unknown>;
  }>([
    {
      code: "pdf_page_limit_exceeded",
      expected: {
        error: "pdf_page_limit_exceeded",
        maxPages: 500,
        message: "This PDF has more than 500 pages."
      }
    },
    {
      code: "pdf_extraction_timeout",
      expected: { error: "pdf_extraction_timeout", message: "PDF processing timed out." }
    },
    {
      code: "pdf_password_required",
      expected: {
        error: "pdf_password_required",
        message: "Password-protected PDFs are not supported."
      }
    },
    {
      code: "pdf_invalid",
      expected: { error: "pdf_invalid", message: "This PDF is damaged or invalid." }
    },
    {
      code: "pdf_extraction_failed",
      expected: { error: "pdf_extraction_failed", message: "This PDF could not be processed." }
    }
  ])("returns stable $code without storing the PDF", async ({ code, expected }) => {
    const storage = createMemoryStorageAdapter();
    const gate = createUploadPermitGate(1);
    let attachmentCreated = false;
    const POST = createUploadHandler({
      createAttachment: async (input) => {
        attachmentCreated = true;

        return {
          ...input,
          id: "attachment-1"
        };
      },
      extractPdfTextChunks: async () => {
        throw new PdfExtractionError(code);
      },
      resolveAuth: auth.resolveAuth,
      storage,
      uploadPermitGate: gate
    });
    const response = await POST(
      authenticatedUploadRequest(new File([Buffer.from("%PDF-1.4\n")], "failed.pdf", { type: "application/pdf" }))
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(expected);
    expect(attachmentCreated).toBe(false);
    expect(storage.objects.size).toBe(0);
    expect(gate.snapshot().active).toBe(0);
  });

  it.each([new Error("pdf_too_complex"), new Error("private parser path and details")])(
    "sanitizes legacy and unknown PDF errors before returning them",
    async (error) => {
      const storage = createMemoryStorageAdapter();
      const POST = createUploadHandler({
        createAttachment: async (input) => ({ ...input, id: "should-not-create" }),
        extractPdfTextChunks: async () => {
          throw error;
        },
        resolveAuth: auth.resolveAuth,
        storage
      });

      const response = await POST(
        authenticatedUploadRequest(new File([Buffer.from("%PDF-1.4\n")], "failed.pdf", { type: "application/pdf" }))
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "pdf_extraction_failed",
        message: "This PDF could not be processed."
      });
      expect(storage.objects.size).toBe(0);
    }
  );

  it("rethrows request cancellation and releases the permit during PDF processing", async () => {
    const controller = new AbortController();
    const reason = new Error("operator_cancelled_upload");
    const gate = createUploadPermitGate(1);
    const storage = createMemoryStorageAdapter();
    const POST = createUploadHandler({
      createAttachment: async (input) => ({ ...input, id: "should-not-create" }),
      extractPdfTextChunks: async (_buffer, options) => {
        expect(options?.signal?.aborted).toBe(false);
        controller.abort(reason);
        throw reason;
      },
      resolveAuth: auth.resolveAuth,
      storage,
      uploadPermitGate: gate
    });
    const request = authenticatedUploadRequest(
      new File([Buffer.from("%PDF-1.4\n")], "cancelled.pdf", { type: "application/pdf" }),
      controller.signal
    );

    await expect(POST(request)).rejects.toBe(reason);
    expect(storage.objects.size).toBe(0);
    expect(gate.snapshot().active).toBe(0);
  });
});
