// @vitest-environment node

import { describe, expect, it } from "vitest";
import { getAuthConfig, TEST_AUTH_TOKEN } from "../auth/config";
import { createTestAuth } from "../auth/testRequestAuth";
import { createMemoryStorageAdapter } from "./storage";
import { createUploadHandler } from "./handlers";

const oneByOnePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
);
const config = getAuthConfig({
  AIQSA_BOOTSTRAP_AUTH_TOKEN: TEST_AUTH_TOKEN,
  AUTH_SESSION_SECRET: "secret"
});
const auth = createTestAuth({
  user: {
    id: config.bootstrapUserId
  }
});

function authenticatedUploadRequest(file: File): Request {
  const form = new FormData();
  form.set("file", file);

  return new Request("http://app.local/api/uploads", {
    body: form,
    headers: {
      cookie: auth.cookie
    },
    method: "POST"
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

  it("stores an authenticated image upload and persists metadata", async () => {
    const storage = createMemoryStorageAdapter();
    const POST = createUploadHandler({
      createAttachment: async (input) => ({
        ...input,
        id: "attachment-1"
      }),
      resolveAuth: auth.resolveAuth,
      storage
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
      storage
    });

    await expect(
      POST(authenticatedUploadRequest(new File([oneByOnePng], "failed.png", { type: "image/png" })))
    ).rejects.toThrow("attachment_row_failed");
    expect(staged).toHaveLength(1);
    expect(completed).toEqual(["cleanup-job"]);
    expect(storage.objects.size).toBe(0);
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
      storage
    });
    const response = await POST(
      authenticatedUploadRequest(new File([Buffer.from("%PDF-1.4\n")], "spoof.png", { type: "image/png" }))
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "unsupported_type" });
    expect(attachmentCreated).toBe(false);
    expect(storage.objects.size).toBe(0);
  });

  it("rejects complex PDFs before storage or attachment creation", async () => {
    const storage = createMemoryStorageAdapter();
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
        throw new Error("pdf_too_complex");
      },
      resolveAuth: auth.resolveAuth,
      storage
    });
    const response = await POST(
      authenticatedUploadRequest(new File([Buffer.from("%PDF-1.4\n")], "large.pdf", { type: "application/pdf" }))
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "pdf_too_complex" });
    expect(attachmentCreated).toBe(false);
    expect(storage.objects.size).toBe(0);
  });
});
