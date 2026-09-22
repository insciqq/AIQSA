import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { createMemoryStorageAdapter } from "@/tests/support/storage";
import { IMAGE_MAX_BYTES } from "@/lib/contracts/imageGeneration";
import { TEXT_PREVIEW_MAX_BYTES } from "@/lib/domain/attachmentPreview";
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

describe("authenticated attachment previews", () => {
  async function fixture(bytes: Buffer, mimeType: string, fileName: string) {
    const storage = createMemoryStorageAdapter();
    const storageKey = "synthetic-preview/original";
    await storage.putObject({ body: bytes, contentType: mimeType, storageKey });
    const record = { byteSize: bytes.length, fileName, id: "preview-1", mimeType, storageKey };
    const repository = { resolve: vi.fn().mockResolvedValue(record) };
    const getObject = vi.spyOn(storage, "getObject");
    const resolveAuth = vi.fn().mockResolvedValue(auth());
    const handler = createAttachmentDownloadHandler({ repository, resolveAuth, storage });
    return { getObject, record, repository, resolveAuth, storage,
      read: (mode: string) => handler(new Request(`http://local.test/api/attachments/preview-1/content?preview=${mode}`),
        { params: { attachmentId: "preview-1" } }) };
  }

  function expectPrivateHeaders(response: Response, type: string) {
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(response.headers.get("content-disposition")).toBe("inline");
    expect(response.headers.get("content-type")).toBe(type);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
  }

  it.each(["png", "jpeg", "webp", "gif"] as const)("returns the original %s bytes and an independently decodable static thumbnail", async format => {
    const bytes = format === "gif"
      ? Buffer.from("47494638396101000100800000000000ffffff21f90400010000002c000000000100010000020244010021f90400010000002c00000000010001000002024401003b", "hex")
      : await sharp({ create: { width: 320, height: 200, channels: 3, background: "#123456" } })[format]().toBuffer();
    const f = await fixture(bytes, `image/${format}`, `picture.${format}`);
    const original = await f.read("image");
    expect(original.status).toBe(200);
    expectPrivateHeaders(original, `image/${format}`);
    expect(Buffer.from(await original.arrayBuffer())).toEqual(bytes);
    expect(Number(original.headers.get("content-length"))).toBe(bytes.length);
    const thumb = await f.read("thumb");
    expect(thumb.status).toBe(200);
    expectPrivateHeaders(thumb, "image/webp");
    const thumbBytes = Buffer.from(await thumb.arrayBuffer());
    expect(thumbBytes.equals(bytes)).toBe(false);
    const metadata = await sharp(thumbBytes).metadata();
    expect(metadata.format).toBe("webp");
    expect(metadata.pages ?? 1).toBe(1);
    expect(Math.max(metadata.width, metadata.height)).toBeLessThanOrEqual(160);
    expect(Number(thumb.headers.get("content-length"))).toBe(thumbBytes.length);
    expect(f.getObject).toHaveBeenCalledWith(f.record.storageKey, { maxBytes: bytes.length, signal: expect.any(AbortSignal) });
    const download = await f.read("");
    expect(download.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes);
  });

  it.each(["image", "thumb", "text"])("reauthorizes %s before every object read and reveals no missing attachment", async mode => {
    const f = await fixture(Buffer.from("synthetic"), "text/plain", "note.txt");
    f.resolveAuth.mockResolvedValueOnce(null);
    expect((await f.read(mode)).status).toBe(401);
    expect(f.repository.resolve).not.toHaveBeenCalled();
    f.repository.resolve.mockResolvedValueOnce(null);
    const missing = await f.read(mode);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "attachment_not_found" });
    expect(f.getObject).not.toHaveBeenCalled();
    expect(f.repository.resolve).toHaveBeenCalledWith({ attachmentId: "preview-1", userId: "user-1" });
  });

  it("strictly decodes original UTF-8 with BOM and serves HTML/SVG as inert text", async () => {
    for (const [fileName, mimeType, text] of [["page.html", "text/html", '<script>fetch("https://example.invalid")</script>'],
      ["shape.svg", "image/svg+xml", '<svg onload="alert(1)"/>'], ["note.md", "text/markdown", "# Привет🙂\r\n"]] as const) {
      const f = await fixture(Buffer.from(`\ufeff${text}`), mimeType, fileName);
      const response = await f.read("text");
      expect(response.status).toBe(200);
      expectPrivateHeaders(response, "text/plain; charset=utf-8");
      expect(await response.text()).toBe(text);
      expect(Number(response.headers.get("content-length"))).toBe(Buffer.byteLength(text));
    }
    const invalid = await fixture(Buffer.from([0xff, 0xfe, 0, 0]), "text/plain", "note.txt");
    const response = await invalid.read("text");
    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({ error: "text_preview_unavailable" });
  });

  it("bounds reads and rejects metadata, format and mode mismatches without exposing storage details", async () => {
    const bytes = await sharp({ create: { width: 1, height: 1, channels: 3, background: "red" } }).png().toBuffer();
    for (const mode of ["image", "thumb"]) {
      const f = await fixture(bytes, "image/jpeg", "picture.jpg");
      const mismatch = await f.read(mode);
      expect(mismatch.status).toBe(415);
      expect(await mismatch.json()).toEqual({ error: "image_preview_unavailable" });
      f.record.byteSize = IMAGE_MAX_BYTES + 1;
      f.getObject.mockClear();
      expect((await f.read(mode)).status).toBe(415);
      expect(f.getObject).not.toHaveBeenCalled();
    }
    const text = await fixture(Buffer.from("abc"), "text/plain", "note.txt");
    for (const size of [2, 4, TEXT_PREVIEW_MAX_BYTES + 1]) {
      text.record.byteSize = size;
      const response = await text.read("text");
      expect(response.status).toBe(415);
      expect(await response.json()).toEqual({ error: "text_preview_unavailable" });
    }
    text.record.byteSize = 3;
    expect((await text.read("image")).status).toBe(415);
    expect((await text.read("unknown")).status).toBe(400);
    text.record.fileName = "document.pdf";
    text.record.mimeType = "application/pdf";
    expect((await text.read("text")).status).toBe(415);
    text.record.fileName = "note.txt";
    text.record.mimeType = "text/plain";
    text.storage.objects.clear();
    expect((await text.read("text")).status).toBe(503);
  });
});
