export type UploadedAttachmentWire = {
  byteSize?: number;
  extractedText?: string | null;
  fileName: string;
  id: string;
  kind: "document" | "image" | "pdf";
  metadata?: unknown;
  mimeType?: string;
  status?: string;
};

export type UploadAttachmentResponseWire = {
  attachment: UploadedAttachmentWire;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
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
    (attachment.kind !== "document" && attachment.kind !== "image" && attachment.kind !== "pdf") ||
    (attachment.byteSize !== undefined &&
      (typeof attachment.byteSize !== "number" ||
        !Number.isFinite(attachment.byteSize) ||
        attachment.byteSize < 0)) ||
    (attachment.extractedText !== undefined &&
      attachment.extractedText !== null &&
      typeof attachment.extractedText !== "string") ||
    !optionalString(attachment.mimeType) ||
    !optionalString(attachment.status)
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
      ...(Object.prototype.hasOwnProperty.call(attachment, "metadata")
        ? { metadata: attachment.metadata }
        : {}),
      ...(attachment.mimeType === undefined ? {} : { mimeType: attachment.mimeType }),
      ...(attachment.status === undefined ? {} : { status: attachment.status })
    }
  };
}
