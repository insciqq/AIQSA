import type { CatalogModel } from "@/components/app-shell/types";
import type {
  ComposerAttachment,
  ComposerAttachmentWarning,
  ComposerPdfProcessing
} from "@/components/app-shell/attachmentContracts";
import type { ComposerAttachmentPolicy } from "@/components/app-shell/attachmentSelection";
import { decodePdfProcessing } from "@/lib/contracts/uploads";

const directPdfStorageFailureCodes = new Set([
  "attachment_checksum_mismatch",
  "attachment_object_read_failed",
  "attachment_object_size_mismatch",
  "attachment_unavailable"
]);

export function pdfProcessingForAttachment(
  attachment: ComposerAttachment
): ComposerPdfProcessing | null {
  if (attachment.kind !== "pdf") {
    return null;
  }

  return decodePdfProcessing(attachment.processing);
}

export function attachmentWarningsForModel(
  attachments: readonly ComposerAttachment[],
  model: CatalogModel | undefined
): ComposerAttachmentWarning[] {
  const warnings: ComposerAttachmentWarning[] = [];

  for (const attachment of attachments) {
    const processing = pdfProcessingForAttachment(attachment);
    if (!processing || processing.status === "complete") {
      continue;
    }

    if (processing.status === "partial") {
      if (processing.extractedCharacterCount === 0) {
        const nativePdf = model?.capabilities.documentInputMode === "native_pdf";
        warnings.push({
          attachmentId: attachment.id,
          blocking: !nativePdf,
          label: "Text limited",
          message: nativePdf
            ? "PDF text exceeded the configured limit before any complete text could be retained. This model can use the original PDF."
            : "No PDF text could be retained within the configured limit. Choose a model with native PDF support or remove this file."
        });
        continue;
      }

      warnings.push({
        attachmentId: attachment.id,
        blocking: false,
        label: "Text limited",
        message: `PDF text was limited after page ${processing.pagesProcessed} of ${processing.pageCount}. The available text will be used.`
      });
      continue;
    }

    const nativePdf = model?.capabilities.documentInputMode === "native_pdf";
    warnings.push({
      attachmentId: attachment.id,
      blocking: !nativePdf,
      label: "No text",
      message: nativePdf
        ? "No extractable text was found. This model can use the original PDF."
        : "No extractable text was found. Choose a model with native PDF support or remove this file."
    });
  }

  return warnings;
}

export function firstBlockingAttachmentWarning(
  attachments: readonly ComposerAttachment[],
  model: CatalogModel | undefined
): ComposerAttachmentWarning | null {
  return attachmentWarningsForModel(attachments, model).find((warning) => warning.blocking) ?? null;
}

export function attachmentBlocksSend(
  attachment: ComposerAttachment,
  model: CatalogModel | undefined
): boolean {
  const status = attachment.status ?? "ready";
  const directPdf = attachment.kind === "pdf" &&
    model?.capabilities.documentInputMode === "native_pdf";

  if (!directPdf) return status !== "ready";
  if (
    attachment.processingErrorCode &&
    directPdfStorageFailureCodes.has(attachment.processingErrorCode)
  ) return true;
  return status !== "ready" && status !== "processing" && status !== "failed";
}

export function attachmentPolicyForModel(
  model: CatalogModel | undefined
): ComposerAttachmentPolicy {
  return {
    documents: Boolean(model),
    images: Boolean(model?.capabilities.imageInput),
    // Every answer model can consume AIQSA's locally extracted PDF text.
    // documentInputMode only selects local extraction versus verified direct input.
    pdfs: Boolean(model)
  };
}

export function modelSupportsAttachment(
  model: CatalogModel | undefined,
  attachment: ComposerAttachment
): boolean {
  const policy = attachmentPolicyForModel(model);

  if (attachment.kind === "image") {
    return policy.images;
  }

  return attachment.kind === "pdf" ? policy.pdfs : policy.documents;
}

export function partitionAttachmentsForModel(
  attachments: readonly ComposerAttachment[],
  model: CatalogModel | undefined
): {
  supported: ComposerAttachment[];
  unsupported: ComposerAttachment[];
} {
  const supported: ComposerAttachment[] = [];
  const unsupported: ComposerAttachment[] = [];

  for (const attachment of attachments) {
    (modelSupportsAttachment(model, attachment) ? supported : unsupported).push(
      attachment
    );
  }

  return { supported, unsupported };
}

export function unsupportedAttachmentMessage(
  fileNames: readonly string[],
  model: CatalogModel | undefined,
  removed = false
): string {
  const label = model?.displayName ?? "The selected model";
  const names = fileNames.join(", ");
  return removed
    ? `Removed ${fileNames.length === 1 ? "an attachment" : `${fileNames.length} attachments`} unsupported by ${label}: ${names}`
    : `${label} does not support ${fileNames.length === 1 ? "this attachment" : "these attachments"}: ${names}`;
}
