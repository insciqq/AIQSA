import type { RequestAuthResolver } from "@/lib/server/auth/requestAuth";
import {
  getStoredObjectStream,
  type StorageAdapter
} from "./storage";

export type AttachmentDownloadRecord = Readonly<{
  byteSize: number;
  fileName: string;
  id: string;
  mimeType: string;
  storageKey: string;
}>;

export type AttachmentDownloadRepository = Readonly<{
  resolve(input: Readonly<{
    attachmentId: string;
    userId: string;
  }>): Promise<AttachmentDownloadRecord | null>;
}>;

function contentDisposition(fileName: string): string {
  const normalized = fileName.normalize("NFC").replace(/[\u0000-\u001f\u007f]/gu, "");
  const ascii = normalized.replace(/[^\x20-\x7e]/gu, "_").replace(/["\\]/gu, "_")
    .slice(0, 120) || "download";
  const encoded = encodeURIComponent(normalized || "download")
    .replace(/['()*]/gu, (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`
    );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function privateHeaders(record: AttachmentDownloadRecord): Headers {
  return new Headers({
    "cache-control": "private, no-store, max-age=0",
    "content-disposition": contentDisposition(record.fileName),
    "content-length": String(record.byteSize),
    "content-type": record.mimeType,
    "x-content-type-options": "nosniff"
  });
}

export function createAttachmentDownloadHandler(input: Readonly<{
  repository: AttachmentDownloadRepository;
  resolveAuth: RequestAuthResolver;
  storage: StorageAdapter;
}>) {
  return async function GET(
    request: Request,
    context: { params: Promise<{ attachmentId: string }> | { attachmentId: string } }
  ): Promise<Response> {
    const auth = await input.resolveAuth(request);
    if (!auth) return Response.json({ error: "unauthorized" }, { status: 401 });
    const { attachmentId } = await context.params;
    if (!attachmentId || attachmentId.length > 128) {
      return Response.json({ error: "attachment_not_found" }, { status: 404 });
    }
    const record = await input.repository.resolve({ attachmentId, userId: auth.userId });
    if (!record) return Response.json({ error: "attachment_not_found" }, { status: 404 });
    if (
      !Number.isSafeInteger(record.byteSize) ||
      record.byteSize < 1 ||
      record.fileName.length < 1 ||
      record.fileName.length > 512 ||
      record.mimeType.length < 1 ||
      record.mimeType.length > 255
    ) {
      return Response.json({ error: "attachment_unavailable" }, { status: 503 });
    }
    try {
      const object = await getStoredObjectStream(input.storage, record.storageKey, {
        maxBytes: record.byteSize,
        signal: request.signal
      });
      if (object.byteSize !== record.byteSize) {
        await object.body.cancel("stored_object_size_mismatch").catch(() => undefined);
        return Response.json({ error: "attachment_unavailable" }, { status: 503 });
      }
      return new Response(object.body, {
        headers: privateHeaders(record),
        status: 200
      });
    } catch {
      return Response.json(
        { error: "attachment_unavailable" },
        { headers: { "cache-control": "private, no-store, max-age=0" }, status: 503 }
      );
    }
  };
}
