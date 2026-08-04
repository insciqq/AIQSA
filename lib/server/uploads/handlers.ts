import { createHash, randomUUID } from "node:crypto";
import type { RequestAuthResolver } from "../auth/requestAuth";
import { readBoundedFormData, RequestBodyTooLargeError } from "../http/requestBody";
import { getRequestBodyConfig, type RequestBodyConfig } from "../http/requestBodyConfig";
import { resolveUploadPermitGate, type UploadPermitGate } from "../http/uploadPermitGate";
import { extractImageMetadata, type ImageMetadata } from "./imageMetadata";
import { extractPdfTextChunks, type PdfExtractionResult } from "./pdf";
import { createS3StorageAdapter, type StorageAdapter } from "./storage";
import { DEFAULT_EXTRACTED_TEXT_MAX_CHARS, extractTextDocument } from "./textDocuments";
import { defaultUploadMaxBytes, validateUpload, type UploadKind } from "./validation";

export type CreatedAttachment = {
  byteSize: number;
  checksum: string;
  extractedText: string | null;
  fileName: string;
  id: string;
  kind: UploadKind;
  metadata: unknown;
  mimeType: string;
  status: "ready";
  storageKey: string;
};

export type UploadHandlerDeps = {
  createAttachment(input: Omit<CreatedAttachment, "id"> & { userId: string }): Promise<CreatedAttachment>;
  deletionOutbox?: {
    complete(jobId: string): Promise<void>;
    stage(storageKey: string): Promise<{ id: string }>;
  };
  extractImageMetadata?: (buffer: Buffer, mimeType: string) => ImageMetadata;
  extractPdfTextChunks?: (buffer: Buffer) => Promise<PdfExtractionResult>;
  getBodyConfig?: (uploadMaxBytes: number) => Pick<RequestBodyConfig, "uploadMaxConcurrency" | "uploadMultipartMaxBytes">;
  getMaxBytes?: () => number;
  resolveAuth: RequestAuthResolver;
  storage?: StorageAdapter;
  uploadPermitGate?: UploadPermitGate;
};

function safeFileName(fileName: string): string {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function checksum(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function capExtractedText(text: string, maxChars = DEFAULT_EXTRACTED_TEXT_MAX_CHARS) {
  return {
    text: text.length > maxChars ? text.slice(0, maxChars) : text,
    truncated: text.length > maxChars
  };
}

function capPdfChunks(chunks: PdfExtractionResult["chunks"], maxChars = DEFAULT_EXTRACTED_TEXT_MAX_CHARS) {
  const capped: PdfExtractionResult["chunks"] = [];
  let remaining = maxChars;

  for (const chunk of chunks) {
    if (remaining <= 0) {
      break;
    }

    const text = chunk.text.slice(0, remaining);
    capped.push({
      ...chunk,
      text
    });
    remaining -= text.length;
  }

  return capped;
}

async function buildMetadata(
  kind: UploadKind,
  mimeType: string,
  buffer: Buffer,
  deps: UploadHandlerDeps,
  fileName: string
) {
  if (kind === "pdf") {
    const extraction = await (deps.extractPdfTextChunks ?? extractPdfTextChunks)(buffer);
    const cappedText = capExtractedText(extraction.text);

    return {
      extractedText: cappedText.text,
      metadata: {
        pdf: {
          chunks: capPdfChunks(extraction.chunks),
          extractedTextMaxChars: DEFAULT_EXTRACTED_TEXT_MAX_CHARS,
          pageCount: extraction.pageCount,
          truncated: cappedText.truncated,
          ...(cappedText.truncated ? { originalCharacterCount: extraction.text.length } : {})
        }
      }
    };
  }

  if (kind === "document") {
    const extraction = extractTextDocument(buffer, { fileName, maxChars: DEFAULT_EXTRACTED_TEXT_MAX_CHARS, mimeType });

    return {
      extractedText: extraction.text,
      metadata: {
        document: {
          characterCount: extraction.text.length,
          extractedTextMaxChars: DEFAULT_EXTRACTED_TEXT_MAX_CHARS,
          kind: extraction.kind,
          truncated: extraction.truncated,
          ...(extraction.truncated ? { originalByteSize: buffer.byteLength } : {})
        }
      }
    };
  }

  const image = (deps.extractImageMetadata ?? extractImageMetadata)(buffer, mimeType);

  if (image.format === "gif" && image.animated) {
    throw new Error("animated_gif_not_supported");
  }

  return {
    extractedText: null,
    metadata: {
      image
    }
  };
}

export function createUploadHandler(deps: UploadHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    const auth = await deps.resolveAuth(request);
    if (!auth) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    const maxBytes = deps.getMaxBytes?.() ?? defaultUploadMaxBytes();
    const bodyConfig = deps.getBodyConfig?.(maxBytes) ?? getRequestBodyConfig(process.env, maxBytes);
    const permitGate = deps.uploadPermitGate ?? resolveUploadPermitGate(bodyConfig.uploadMaxConcurrency);
    const releasePermit = permitGate.tryAcquire();

    if (!releasePermit) {
      return Response.json(
        { error: "upload_busy", message: "Upload capacity is busy. Try again shortly." },
        { headers: { "retry-after": "1" }, status: 429 }
      );
    }

    try {
      let form: FormData;
      try {
        form = await readBoundedFormData(request, bodyConfig.uploadMultipartMaxBytes);
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError) {
          return Response.json(
            {
              error: "file_too_large",
              limit: bodyConfig.uploadMultipartMaxBytes,
              message: `Upload envelope exceeds the ${bodyConfig.uploadMultipartMaxBytes}-byte limit.`
            },
            { status: 413 }
          );
        }

        if (request.signal.aborted) {
          throw error;
        }

        return Response.json({ error: "file_required" }, { status: 400 });
      }

      const file = form.get("file");

      if (!(file instanceof File)) {
        return Response.json({ error: "file_required" }, { status: 400 });
      }

      const initialValidation = validateUpload({
        byteSize: file.size,
        fileName: file.name,
        maxBytes,
        mimeType: file.type
      });

      if (!initialValidation.ok) {
        return Response.json(
          { error: initialValidation.code },
          { status: initialValidation.code === "file_too_large" ? 413 : 400 }
        );
      }

      const buffer = Buffer.from(await file.arrayBuffer());
      const validation = validateUpload({
        byteSize: buffer.byteLength,
        bytes: buffer,
        fileName: file.name,
        maxBytes,
        mimeType: file.type
      });

      if (!validation.ok) {
        return Response.json({ error: validation.code }, { status: validation.code === "file_too_large" ? 413 : 400 });
      }

      let processed: Awaited<ReturnType<typeof buildMetadata>>;
      try {
        processed = await buildMetadata(validation.kind, validation.mimeType, buffer, deps, file.name);
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "attachment_processing_failed" },
          { status: 400 }
        );
      }

      const digest = checksum(buffer);
      const storageKey = `${auth.userId}/${randomUUID()}-${digest.slice(0, 16)}-${safeFileName(file.name)}`;
      const storage = deps.storage ?? createS3StorageAdapter();
      await storage.putObject({
        body: buffer,
        contentType: validation.mimeType,
        storageKey
      });

      let attachment: CreatedAttachment;
      try {
        attachment = await deps.createAttachment({
          byteSize: buffer.byteLength,
          checksum: digest,
          extractedText: processed.extractedText,
          fileName: file.name,
          kind: validation.kind,
          metadata: processed.metadata,
          mimeType: validation.mimeType,
          status: "ready",
          storageKey,
          userId: auth.userId
        });
      } catch (error) {
        let cleanupJob: { id: string } | null = null;

        try {
          cleanupJob = (await deps.deletionOutbox?.stage(storageKey)) ?? null;
        } catch {
          // Direct object cleanup remains useful when persistence itself is unavailable.
        }

        try {
          await storage.deleteObject(storageKey);
          if (cleanupJob) {
            await deps.deletionOutbox?.complete(cleanupJob.id);
          }
        } catch {
          // A staged job is retryable; if staging failed, preserve the original DB error.
        }

        throw error;
      }

      return Response.json({
        attachment
      });
    } finally {
      releasePermit();
    }
  };
}
