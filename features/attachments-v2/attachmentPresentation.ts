import {
  attachmentRetryAvailable,
  clientAttachmentFailureMessage
} from "@/components/app-shell/attachmentLifecycle";
import type { AttachmentLimitUsage } from "@/components/app-shell/attachmentLimitUsage";
import type {
  ComposerAttachment,
  ComposerAttachmentWarning
} from "@/components/app-shell/attachmentContracts";
import { attachmentBlocksSend } from "@/components/app-shell/attachmentCapabilities";
import type { CatalogModel } from "@/components/app-shell/types";

export type ComposerAttachmentItemV2 = Readonly<{
  byteSize?: number;
  blocksSend?: boolean;
  detail?: string | null;
  fileName: string;
  id: string;
  kind?: ComposerAttachment["kind"];
  progress?: number | null;
  rejection?: "too_large" | "unsupported_format" | "upload_failed";
  retryable?: boolean;
  status: "failed" | "processing" | "ready" | "rejected" | "uploading";
  warning?: Readonly<{
    blocking: boolean;
    label: string;
    message: string;
  }> | null;
}>;

const processingFailureMessages: Readonly<Record<string, string>> = {
  animated_gif_not_supported: "Animated GIFs are not supported.",
  attachment_checksum_mismatch: "The file failed its integrity check.",
  attachment_object_read_failed: "Could not read the stored file.",
  attachment_object_size_mismatch: "The stored file size did not match.",
  attachment_processing_failed: "Could not process the file.",
  parser_invalid_output: "The parser returned an invalid result.",
  parser_output_too_large: "The processed result is too large.",
  parser_rejected: "The parser rejected the file.",
  parser_timeout: "Document processing took too long.",
  parser_unavailable: "The document processing service is unavailable.",
  pdf_extraction_failed: "Could not extract text from the PDF.",
  pdf_extraction_timeout: "PDF text extraction took too long.",
  pdf_invalid: "The PDF is corrupted or malformed.",
  pdf_page_limit_exceeded: "The PDF exceeds the page limit.",
  pdf_password_required: "Password-protected PDFs are not supported."
};

function failureDetail(attachment: ComposerAttachment): string {
  const clientMessage = clientAttachmentFailureMessage(attachment.processingErrorCode);
  if (clientMessage) return clientMessage;
  return processingFailureMessages[attachment.processingErrorCode ?? ""] ??
    "Could not process the file.";
}

export function attachmentItemsForV2(
  attachments: readonly ComposerAttachment[],
  warnings: readonly ComposerAttachmentWarning[] = [],
  model?: CatalogModel
): ComposerAttachmentItemV2[] {
  const warningById = new Map(warnings.map((warning) => [warning.attachmentId, warning]));
  return attachments.map((attachment) => {
    const status = attachment.status ?? "ready";
    const warning = warningById.get(attachment.id);
    const blocksSend = attachmentBlocksSend(attachment, model);
    const directPdf = attachment.kind === "pdf" &&
      model?.capabilities.documentInputMode === "native_pdf";
    const detail = status === "failed" && directPdf && !blocksSend
      ? "Local text extraction failed. The original PDF will be sent directly to the selected provider."
      : status === "processing" && directPdf && !blocksSend
        ? "The original PDF can be sent directly while local text extraction continues."
        : status === "failed"
          ? failureDetail(attachment)
          : null;
    return {
      ...(attachment.byteSize === undefined ? {} : { byteSize: attachment.byteSize }),
      blocksSend,
      ...(detail ? { detail } : {}),
      fileName: attachment.fileName,
      id: attachment.id,
      kind: attachment.kind,
      retryable: status === "failed" && attachmentRetryAvailable(attachment),
      status,
      ...(warning ? {
        warning: {
          blocking: warning.blocking,
          label: warning.label === "No text" ? "No text" : "Text limited",
          message: warning.message
        }
      } : {})
    };
  });
}

export function attachmentItemBlocksSend(item: ComposerAttachmentItemV2): boolean {
  return (item.blocksSend ?? item.status !== "ready") || Boolean(item.warning?.blocking);
}

function firstBlockingItemReason(items: readonly ComposerAttachmentItemV2[]): string | null {
  const item = items.find(attachmentItemBlocksSend);
  if (!item) return null;
  if (item.status === "uploading") {
    return `Wait for “${item.fileName}” to finish uploading.`;
  }
  if (item.status === "processing") {
    return `Wait for “${item.fileName}” to finish processing.`;
  }
  if (item.status === "rejected") {
    return `Remove the rejected file “${item.fileName}”.`;
  }
  if (item.status === "failed") {
    return `Retry processing or remove “${item.fileName}”.`;
  }
  return item.warning?.message ?? `Check the file “${item.fileName}”.`;
}

export function attachmentSendBlockReasonV2(
  items: readonly ComposerAttachmentItemV2[],
  usage: AttachmentLimitUsage | null | undefined,
  uploading: boolean
): string | null {
  const itemReason = firstBlockingItemReason(items);
  if (itemReason) return itemReason;
  if (uploading) return "Wait for file uploads to finish.";
  if (usage?.blocking) {
    return "Attachment limit exceeded. Remove some files or choose a compatible model.";
  }
  return null;
}

export function attachmentCapacityCopyV2(usage: AttachmentLimitUsage): {
  detail: string | null;
  summary: string;
} {
  const fileWord = usage.count === 1 ? "file" : "files";
  const sourceSize = usage.totalSourceBytes >= 1024 * 1024
    ? `${Number((usage.totalSourceBytes / (1024 * 1024)).toFixed(1))} MB`
    : usage.totalSourceBytes >= 1024
      ? `${Number((usage.totalSourceBytes / 1024).toFixed(1))} KB`
      : `${usage.totalSourceBytes} B`;
  const detail = usage.blocking
    ? "Limit exceeded — remove some files before sending."
    : usage.tone === "caution"
      ? "At least 80% of one attachment limit is used."
      : null;
  return {
    detail,
    summary: `${usage.count} ${fileWord} · ${sourceSize}`
  };
}
