import { describe, expect, it, vi } from "vitest";
import { createMemoryStorageAdapter } from "@/tests/support/storage";
import { createAttachmentDownloadHandler } from "./downloadHandlers";

function auth(userId = "user-1") {
  return {
    user: { id: userId, role: "user", status: "active" },
    userId
  };
}

describe("attachment download handler", () => {
  it("authorizes before lookup and streams with private safe headers", async () => {
    const storage = createMemoryStorageAdapter();
    await storage.putObject({
      body: Buffer.from("durable output"),
      contentType: "application/octet-stream",
      storageKey: "workspace/output-1"
    });
    const repository = {
      resolve: vi.fn().mockResolvedValue({
        byteSize: 14,
        fileName: "отчёт'(*\"\r\n.txt",
        id: "attachment-1",
        mimeType: "text/plain",
        storageKey: "workspace/output-1"
      })
    };
    const handler = createAttachmentDownloadHandler({
      repository,
      resolveAuth: vi.fn().mockResolvedValue(auth()) as never,
      storage
    });
    const response = await handler(
      new Request("http://local.test/api/attachments/attachment-1/content"),
      { params: { attachmentId: "attachment-1" } }
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(response.headers.get("content-disposition")).not.toMatch(/[\r\n]/u);
    expect(response.headers.get("content-disposition")).toContain("filename*=UTF-8''");
    expect(response.headers.get("content-disposition")).toContain("%27%28%2A");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(response.text()).resolves.toBe("durable output");
  });

  it("does not reveal or read an attachment without authorization", async () => {
    const repository = { resolve: vi.fn() };
    const storage = createMemoryStorageAdapter();
    const handler = createAttachmentDownloadHandler({
      repository,
      resolveAuth: vi.fn().mockResolvedValue(null),
      storage
    });
    const response = await handler(
      new Request("http://local.test/api/attachments/private/content"),
      { params: { attachmentId: "private" } }
    );
    expect(response.status).toBe(401);
    expect(repository.resolve).not.toHaveBeenCalled();
  });

  it("fails closed when object metadata disagrees with the database", async () => {
    const storage = createMemoryStorageAdapter();
    await storage.putObject({
      body: Buffer.from("short"),
      contentType: "text/plain",
      storageKey: "workspace/short"
    });
    const handler = createAttachmentDownloadHandler({
      repository: {
        async resolve() {
          return {
            byteSize: 6,
            fileName: "result.txt",
            id: "attachment-1",
            mimeType: "text/plain",
            storageKey: "workspace/short"
          };
        }
      },
      resolveAuth: vi.fn().mockResolvedValue(auth()) as never,
      storage
    });
    const response = await handler(
      new Request("http://local.test/api/attachments/attachment-1/content"),
      { params: { attachmentId: "attachment-1" } }
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "attachment_unavailable" });
  });
});
