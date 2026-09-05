import { pdfPageCountFromMetadata, decodePdfProcessing, type UploadedAttachmentWire } from "../../contracts/uploads";
import type { RequestAuthResolver } from "../auth/requestAuth";

export type AttachmentLifecycleRecord = Readonly<{
  byteSize: number;
  extractedText: string | null;
  fileName: string;
  id: string;
  kind: string;
  metadata: unknown;
  mimeType: string;
  processingErrorCode: string | null;
  status: "failed" | "processing" | "ready";
  updatedAt: Date | string;
}>;

export type AttachmentRetryResult =
  | Readonly<{ attachment: AttachmentLifecycleRecord; kind: "retried" }>
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "not_retryable" }>;

export type AttachmentLifecycleRepository = Readonly<{
  load(input: { attachmentId: string; userId: string }): Promise<AttachmentLifecycleRecord | null>;
  retry(input: { attachmentId: string; now: Date; userId: string }): Promise<AttachmentRetryResult>;
}>;

type HandlerContext = {
  params: Promise<{ attachmentId: string }> | { attachmentId: string };
};

export function serializeAttachmentLifecycle(record: AttachmentLifecycleRecord): UploadedAttachmentWire {
  const pdf = record.kind === "pdf" &&
    typeof record.metadata === "object" && record.metadata !== null &&
    "pdf" in record.metadata
    ? decodePdfProcessing((record.metadata as { pdf?: unknown }).pdf)
    : null;
  const pageCount = record.kind === "pdf" ? pdfPageCountFromMetadata(record.metadata) : null;
  return {
    ...(pageCount ? { pageCount } : {}),
    byteSize: record.byteSize,
    extractedText: record.extractedText,
    fileName: record.fileName,
    id: record.id,
    kind: record.kind === "image" || record.kind === "pdf" ? record.kind : "document",
    ...(record.kind === "pdf" ? {} : { metadata: record.metadata }),
    mimeType: record.mimeType,
    ...(pdf ? { processing: pdf } : {}),
    processingErrorCode: record.processingErrorCode,
    status: record.status,
    updatedAt: new Date(record.updatedAt).toISOString()
  };
}

async function attachmentId(context: HandlerContext): Promise<string | null> {
  const value = (await context.params).attachmentId;
  return typeof value === "string" && value.length > 0 && value.length <= 128
    ? value
    : null;
}

export function createAttachmentStatusHandler(input: Readonly<{
  repository: AttachmentLifecycleRepository;
  resolveAuth: RequestAuthResolver;
}>) {
  return async function GET(request: Request, context: HandlerContext): Promise<Response> {
    const auth = await input.resolveAuth(request);
    if (!auth) return Response.json({ error: "unauthorized" }, { status: 401 });
    const id = await attachmentId(context);
    if (!id) return Response.json({ error: "attachment_not_found" }, { status: 404 });
    const record = await input.repository.load({ attachmentId: id, userId: auth.userId });
    if (!record) return Response.json({ error: "attachment_not_found" }, { status: 404 });
    return Response.json(
      { attachment: serializeAttachmentLifecycle(record) },
      { headers: { "cache-control": "no-store" } }
    );
  };
}

export function createAttachmentRetryHandler(input: Readonly<{
  kickProcessing?: () => void;
  now?: () => Date;
  repository: AttachmentLifecycleRepository;
  resolveAuth: RequestAuthResolver;
}>) {
  return async function POST(request: Request, context: HandlerContext): Promise<Response> {
    const auth = await input.resolveAuth(request);
    if (!auth) return Response.json({ error: "unauthorized" }, { status: 401 });
    const id = await attachmentId(context);
    if (!id) return Response.json({ error: "attachment_not_found" }, { status: 404 });
    const result = await input.repository.retry({
      attachmentId: id,
      now: input.now?.() ?? new Date(),
      userId: auth.userId
    });
    if (result.kind === "not_found") {
      return Response.json({ error: "attachment_not_found" }, { status: 404 });
    }
    if (result.kind === "not_retryable") {
      return Response.json({ error: "attachment_retry_not_available" }, { status: 409 });
    }
    try {
      input.kickProcessing?.();
    } catch {
      // Retry state and its durable job have already committed. A later
      // coordinator reconciliation can safely advance them.
    }
    return Response.json({ attachment: serializeAttachmentLifecycle(result.attachment) });
  };
}
