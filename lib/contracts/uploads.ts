export const PDF_PROCESSING_MAX_PAGES = 500;
export const ATTACHMENT_EXTRACTED_TEXT_MAX_CHARS = 1_000_000;

export type PdfProcessingWire = {
  extractedCharacterCount: number;
  pageCount: number;
  pagesProcessed: number;
  status: "complete" | "partial" | "no_text";
  truncationReason?: "text_limit";
};

export type UploadedAttachmentWire = {
  byteSize?: number;
  extractedText?: string | null;
  fileName: string;
  id: string;
  kind: "document" | "file" | "image" | "pdf";
  metadata?: unknown;
  mimeType?: string;
  processing?: PdfProcessingWire;
  processingErrorCode?: string | null;
  status?: "failed" | "processing" | "ready";
  updatedAt?: string;
};

export type UploadAttachmentResponseWire = {
  attachment: UploadedAttachmentWire;
};

export type AttachmentLibraryItemWire = Readonly<{
  byteSize: number;
  chatId: string | null;
  chatTitle: string | null;
  createdAt: string;
  fileName: string;
  id: string;
  messageId: string | null;
  savedAt: string | null;
  status: "failed" | "processing" | "ready";
}>;

export type AttachmentLibraryResponseWire = Readonly<{
  files: AttachmentLibraryItemWire[];
  nextCursor: string | null;
}>;

export type PdfUploadErrorCode =
  | "pdf_extraction_failed"
  | "pdf_extraction_timeout"
  | "pdf_invalid"
  | "pdf_page_limit_exceeded"
  | "pdf_password_required";

export type UploadErrorResponseWire =
  | {
      error: "file_too_large";
      limit?: number;
    }
  | {
      error: "upload_busy";
    }
  | {
      error: "workspace_runtime_unavailable";
    }
  | {
      error: Exclude<PdfUploadErrorCode, "pdf_page_limit_exceeded">;
      message: string;
    }
  | {
      error: "pdf_page_limit_exceeded";
      maxPages: number;
      message: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isSafeErrorMessage(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 240 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function boundedDisplayString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

export function decodeAttachmentLibraryResponse(
  value: unknown
): AttachmentLibraryResponseWire | null {
  if (!isRecord(value) || !Array.isArray(value.files) || value.files.length > 200 ||
    !(value.nextCursor === null || boundedDisplayString(value.nextCursor, 128))) {
    return null;
  }
  const files = value.files.map((file): AttachmentLibraryItemWire | null => {
    if (
      !isRecord(file) ||
      !boundedDisplayString(file.id, 128) ||
      !(file.chatId === null || boundedDisplayString(file.chatId, 128)) ||
      !(file.messageId === null || boundedDisplayString(file.messageId, 128)) ||
      !(file.chatTitle === null || boundedDisplayString(file.chatTitle, 240)) ||
      !(file.savedAt === null || (typeof file.savedAt === "string" && Number.isFinite(Date.parse(file.savedAt)))) ||
      (file.savedAt === null && (!file.chatId || !file.messageId || !file.chatTitle)) ||
      (file.savedAt !== null && (file.chatId !== null || file.messageId !== null || file.chatTitle !== null)) ||
      !boundedDisplayString(file.fileName, 512) ||
      !isNonNegativeSafeInteger(file.byteSize) ||
      (file.status !== "failed" && file.status !== "processing" && file.status !== "ready") ||
      typeof file.createdAt !== "string" ||
      !Number.isFinite(Date.parse(file.createdAt))
    ) {
      return null;
    }
    return {
      byteSize: file.byteSize,
      chatId: file.chatId,
      chatTitle: file.chatTitle,
      createdAt: new Date(file.createdAt).toISOString(),
      fileName: file.fileName,
      id: file.id,
      messageId: file.messageId,
      savedAt: file.savedAt === null ? null : new Date(file.savedAt).toISOString(),
      status: file.status
    };
  });
  return files.some((file) => file === null)
    ? null
    : { files: files as AttachmentLibraryItemWire[], nextCursor: value.nextCursor };
}

export function decodePdfProcessing(value: unknown): PdfProcessingWire | null {
  if (
    !isRecord(value) ||
    !isNonNegativeSafeInteger(value.extractedCharacterCount) ||
    value.extractedCharacterCount > ATTACHMENT_EXTRACTED_TEXT_MAX_CHARS ||
    !isNonNegativeSafeInteger(value.pageCount) ||
    value.pageCount > PDF_PROCESSING_MAX_PAGES ||
    !isNonNegativeSafeInteger(value.pagesProcessed) ||
    value.pagesProcessed > value.pageCount ||
    (value.status !== "complete" && value.status !== "partial" && value.status !== "no_text")
  ) {
    return null;
  }

  if (
    (value.status === "partial" && value.truncationReason !== "text_limit") ||
    (value.status !== "partial" && value.truncationReason !== undefined) ||
    (value.status === "no_text" && value.extractedCharacterCount !== 0) ||
    (value.status === "complete" && value.extractedCharacterCount === 0) ||
    (value.status === "complete" && value.pageCount === 0) ||
    (value.status === "partial" && (value.pageCount === 0 || value.pagesProcessed === 0)) ||
    ((value.status === "complete" || value.status === "no_text") &&
      value.pagesProcessed !== value.pageCount)
  ) {
    return null;
  }

  return {
    extractedCharacterCount: value.extractedCharacterCount,
    pageCount: value.pageCount,
    pagesProcessed: value.pagesProcessed,
    status: value.status,
    ...(value.status === "partial" ? { truncationReason: "text_limit" as const } : {})
  };
}

export function decodeUploadAttachmentResponse(value: unknown): UploadAttachmentResponseWire | null {
  if (!isRecord(value) || !isRecord(value.attachment)) {
    return null;
  }

  const attachment = value.attachment;
  if (
    typeof attachment.id !== "string" ||
    attachment.id.length === 0 ||
    typeof attachment.fileName !== "string" ||
    attachment.fileName.length === 0 ||
    (attachment.kind !== "document" &&
      attachment.kind !== "file" &&
      attachment.kind !== "image" &&
      attachment.kind !== "pdf") ||
    (attachment.byteSize !== undefined &&
      (typeof attachment.byteSize !== "number" ||
        !Number.isFinite(attachment.byteSize) ||
        attachment.byteSize < 0)) ||
    (attachment.extractedText !== undefined &&
      attachment.extractedText !== null &&
      typeof attachment.extractedText !== "string") ||
    !optionalString(attachment.mimeType) ||
    (attachment.status !== undefined &&
      attachment.status !== "failed" &&
      attachment.status !== "processing" &&
      attachment.status !== "ready") ||
    (attachment.processingErrorCode !== undefined &&
      attachment.processingErrorCode !== null &&
      (typeof attachment.processingErrorCode !== "string" ||
        !/^[a-z][a-z0-9_]{0,63}$/u.test(attachment.processingErrorCode))) ||
    (attachment.updatedAt !== undefined &&
      (typeof attachment.updatedAt !== "string" ||
        !Number.isFinite(Date.parse(attachment.updatedAt))))
  ) {
    return null;
  }

  const processing = Object.prototype.hasOwnProperty.call(attachment, "processing")
    ? decodePdfProcessing(attachment.processing)
    : undefined;
  if (
    (Object.prototype.hasOwnProperty.call(attachment, "processing") && !processing) ||
    (processing && attachment.kind !== "pdf")
  ) {
    return null;
  }

  return {
    attachment: {
      ...(attachment.byteSize === undefined ? {} : { byteSize: attachment.byteSize }),
      ...(attachment.extractedText === undefined
        ? {}
        : { extractedText: attachment.extractedText }),
      fileName: attachment.fileName,
      id: attachment.id,
      kind: attachment.kind,
      ...(attachment.kind !== "pdf" && Object.prototype.hasOwnProperty.call(attachment, "metadata")
        ? { metadata: attachment.metadata }
        : {}),
      ...(attachment.mimeType === undefined ? {} : { mimeType: attachment.mimeType }),
      ...(processing ? { processing } : {}),
      ...(attachment.processingErrorCode === undefined
        ? {}
        : { processingErrorCode: attachment.processingErrorCode }),
      ...(attachment.status === undefined ? {} : { status: attachment.status }),
      ...(attachment.updatedAt === undefined ? {} : { updatedAt: attachment.updatedAt })
    }
  };
}

export function decodeUploadErrorResponse(value: unknown): UploadErrorResponseWire | null {
  if (
    !isRecord(value) ||
    (value.error !== "file_too_large" &&
      value.error !== "pdf_extraction_failed" &&
      value.error !== "pdf_extraction_timeout" &&
      value.error !== "pdf_invalid" &&
      value.error !== "pdf_page_limit_exceeded" &&
      value.error !== "pdf_password_required" &&
      value.error !== "upload_busy" &&
      value.error !== "workspace_runtime_unavailable")
  ) {
    return null;
  }

  if (
    (value.limit !== undefined && !isPositiveSafeInteger(value.limit)) ||
    (value.maxPages !== undefined && !isPositiveSafeInteger(value.maxPages)) ||
    (typeof value.maxPages === "number" && value.maxPages > PDF_PROCESSING_MAX_PAGES) ||
    (value.error !== "file_too_large" && value.limit !== undefined) ||
    (value.error !== "pdf_page_limit_exceeded" && value.maxPages !== undefined)
  ) {
    return null;
  }

  if (value.error === "file_too_large") {
    return {
      error: value.error,
      ...(value.limit === undefined ? {} : { limit: value.limit })
    };
  }

  if (value.error === "upload_busy" || value.error === "workspace_runtime_unavailable") {
    return { error: value.error };
  }

  if (!isSafeErrorMessage(value.message)) {
    return null;
  }

  if (value.error === "pdf_page_limit_exceeded") {
    if (!isPositiveSafeInteger(value.maxPages)) {
      return null;
    }

    return {
      error: value.error,
      maxPages: value.maxPages,
      message: value.message
    };
  }

  return {
    error: value.error,
    message: value.message
  };
}
