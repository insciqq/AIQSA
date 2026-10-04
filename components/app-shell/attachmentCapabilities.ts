import type { CatalogModel } from "@/components/app-shell/types";
import type {
  ComposerAttachment,
  ComposerAttachmentWarning,
  ComposerPdfProcessing
} from "@/components/app-shell/attachmentContracts";
import type { ComposerAttachmentPolicy } from "@/components/app-shell/attachmentSelection";
import {
  CHAT_PDF_ROUTE_UNAVAILABLE_LABEL,
  CHAT_PDF_ROUTE_UNAVAILABLE_MESSAGE,
  type ChatPdfRouteAvailability
} from "@/lib/contracts/chatPdfPreparation";
import {
  decodePdfProcessing,
  documentProcessingFromMetadata,
  type DocumentProcessingWire
} from "@/lib/contracts/uploads";
import { uploadAdmissionFormatFor } from "@/lib/domain/uploadFormats";

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

export function documentProcessingForAttachment(
  attachment: ComposerAttachment
): DocumentProcessingWire | null {
  return attachment.kind === "document"
    ? documentProcessingFromMetadata(attachment.metadata)
    : null;
}

/**
 * `pdfRoute` is the server's admission-route preview for the selected answer
 * model. A definite refusal blocks every PDF, also with Workspace: admission
 * resolves a PDF reading route for Workspace runs as well. Unknown (null)
 * keeps the local checks only; server admission stays the authority.
 */
export function attachmentWarningsForModel(
  attachments: readonly ComposerAttachment[],
  model: CatalogModel | undefined,
  workspaceEnabled = false,
  pdfRoute: ChatPdfRouteAvailability | null = null
): ComposerAttachmentWarning[] {
  const warnings: ComposerAttachmentWarning[] = [];

  for (const attachment of attachments) {
    if (attachment.kind === "pdf" && pdfRoute?.available === false) {
      warnings.push({
        attachmentId: attachment.id,
        blocking: true,
        code: pdfRoute.reasonCode,
        label: CHAT_PDF_ROUTE_UNAVAILABLE_LABEL,
        message: CHAT_PDF_ROUTE_UNAVAILABLE_MESSAGE
      });
      continue;
    }
    if (workspaceEnabled) continue;
    const document = documentProcessingForAttachment(attachment);
    if (document?.status === "partial") {
      warnings.push({
        attachmentId: attachment.id,
        blocking: false,
        label: "Text limited",
        message: document.truncated
          ? `Only the first ${document.characterCount.toLocaleString("en-US")} characters of text were extracted. The model is told the rest is missing.`
          : "Part of this file could not be read. The model is told its text is incomplete."
      });
      continue;
    }

    const processing = pdfProcessingForAttachment(attachment);
    if (!processing || processing.status === "complete") {
      continue;
    }
    const original = pdfOriginalReadingCopy(attachment, model, pdfRoute);

    if (processing.status === "partial") {
      if (processing.extractedCharacterCount === 0) {
        warnings.push({
          attachmentId: attachment.id,
          blocking: !original,
          label: "Text limited",
          message: original
            ? `PDF text exceeded the configured limit before any complete text could be retained. ${original}`
            : "No PDF text could be retained within the configured limit. Choose a model with native PDF support or remove this file."
        });
        continue;
      }

      warnings.push({
        attachmentId: attachment.id,
        blocking: false,
        label: "Text limited",
        message: `PDF text was limited after page ${processing.pagesProcessed} of ${processing.pageCount}. ${
          pdfRoute?.available && original ? original : "The available text will be used."}`
      });
      continue;
    }

    warnings.push({
      attachmentId: attachment.id,
      blocking: !original,
      label: "No text",
      message: original
        ? `No extractable text was found. ${original}`
        : "No extractable text was found. Choose a model with native PDF support or remove this file."
    });
  }

  return warnings;
}

export function firstBlockingAttachmentWarning(
  attachments: readonly ComposerAttachment[],
  model: CatalogModel | undefined,
  workspaceEnabled = false,
  pdfRoute: ChatPdfRouteAvailability | null = null
): ComposerAttachmentWarning | null {
  return attachmentWarningsForModel(attachments, model, workspaceEnabled, pdfRoute)
    .find((warning) => warning.blocking) ?? null;
}

/** Routes whose admission reads the settled original instead of local text. */
const originalPdfRoutes = new Set(["direct_pdf", "system_pdf", "system_vision", "selected_model_vision"]);

/**
 * Whether admission will read this PDF's settled original, so local text
 * extraction cannot block it (server `validateAttachmentReadiness` and
 * `validatePdfTextAvailability` skip extraction once a route is admitted).
 * A known route decides; while the preview is unknown only a native-PDF
 * model counts, as before the preview existed.
 */
export function pdfOriginalReadable(
  attachment: ComposerAttachment,
  model: CatalogModel | undefined,
  pdfRoute: ChatPdfRouteAvailability | null = null
): boolean {
  if (attachment.kind !== "pdf") return false;
  if (pdfRoute) return pdfRoute.available && originalPdfRoutes.has(pdfRoute.route);
  return model?.capabilities.documentInputMode === "native_pdf";
}

/** Who reads the original PDF, or null when local text is required. */
export function pdfOriginalReadingCopy(
  attachment: ComposerAttachment,
  model: CatalogModel | undefined,
  pdfRoute: ChatPdfRouteAvailability | null = null
): string | null {
  if (!pdfOriginalReadable(attachment, model, pdfRoute)) return null;
  return pdfRoute?.available && pdfRoute.route !== "direct_pdf"
    ? "The assigned PDF reader will read the original PDF."
    : "This model can use the original PDF.";
}

export function attachmentBlocksSend(
  attachment: ComposerAttachment,
  model: CatalogModel | undefined,
  workspaceEnabled = false,
  pdfRoute: ChatPdfRouteAvailability | null = null
): boolean {
  const status = attachment.status ?? "ready";
  if (workspaceEnabled) {
    // Upload settlement happens before an attachment enters the composer.
    // Parser work is optional for Workspace; storage-integrity failures are not.
    return status === "failed" && directPdfStorageFailureCodes.has(
      attachment.processingErrorCode ?? ""
    );
  }
  if (!pdfOriginalReadable(attachment, model, pdfRoute)) return status !== "ready";
  if (
    attachment.processingErrorCode &&
    directPdfStorageFailureCodes.has(attachment.processingErrorCode)
  ) return true;
  return status !== "ready" && status !== "processing" && status !== "failed";
}

/**
 * Whether an image can be sent with this model outside Workspace, exactly as
 * run admission accepts it: the model's own image input, the System Vision
 * Model for a model without it, or editing by the run's image model. The
 * routes are the server's catalog projection; absent means none.
 */
export function imageRouteAvailable(model: CatalogModel | undefined): boolean {
  const routes = model?.capabilities.imageRoutes;
  return Boolean(model?.capabilities.imageInput || routes?.systemVision || routes?.imageEditing);
}

/** Why no route takes an image with this model, and what the user can do. */
export function imageRouteUnavailableMessage(
  model: CatalogModel | undefined,
  workspaceAvailable = false
): string {
  const label = model?.displayName ?? "The selected model";
  const tools = model?.capabilities.toolCalling === true;
  const steps = [
    "choose a model that supports images",
    ...(workspaceAvailable ? ["turn on Workspace"] : []),
    ...(tools ? ["ask an administrator to assign the Vision Model"] : [])
  ];
  const recovery = steps.length > 1 ? `${steps.slice(0, -1).join(", ")} or ${steps.at(-1)}` : steps[0];
  return `${label} can't read images${tools ? ", and no Vision Model is available to analyze them" : ""}. To use images, ${recovery}.`;
}

export function attachmentPolicyForModel(
  model: CatalogModel | undefined,
  workspaceFilesAvailable = false
): ComposerAttachmentPolicy {
  if (workspaceFilesAvailable) {
    return { documents: true, files: true, images: true, pdfs: true };
  }
  return {
    documents: Boolean(model),
    images: imageRouteAvailable(model),
    // PDFs stay attachable so a missing reading route is explained on the
    // chip instead of hiding the file type. Whether this model can read a PDF
    // (native input, the PDF reader or page images) comes only from the
    // server's route preview; see attachmentWarningsForModel.
    pdfs: Boolean(model)
  };
}

export function modelSupportsAttachment(
  model: CatalogModel | undefined,
  attachment: ComposerAttachment,
  workspaceEnabled = false
): boolean {
  const policy = attachmentPolicyForModel(model, workspaceEnabled);

  if (attachment.kind === "file") {
    return Boolean(policy.files);
  }

  if (attachment.kind === "image") {
    return policy.images;
  }

  return attachment.kind === "pdf" ? policy.pdfs : policy.documents;
}

export function partitionAttachmentsForModel(
  attachments: readonly ComposerAttachment[],
  model: CatalogModel | undefined,
  workspaceEnabled = false
): {
  supported: ComposerAttachment[];
  unsupported: ComposerAttachment[];
} {
  const supported: ComposerAttachment[] = [];
  const unsupported: ComposerAttachment[] = [];

  for (const attachment of attachments) {
    (modelSupportsAttachment(model, attachment, workspaceEnabled) ? supported : unsupported).push(
      attachment
    );
  }

  return { supported, unsupported };
}

export function unsupportedAttachmentMessage(
  fileNames: readonly string[],
  model: CatalogModel | undefined,
  removed = false,
  workspaceAvailable = false
): string {
  const label = model?.displayName ?? "The selected model";
  const names = fileNames.join(", ");
  const message = removed
    ? `Removed ${fileNames.length === 1 ? "an attachment" : `${fileNames.length} attachments`} unsupported by ${label}: ${names}`
    : `${label} does not support ${fileNames.length === 1 ? "this attachment" : "these attachments"}: ${names}`;
  // A refused image names why no image route exists and how to get one.
  const image = !imageRouteAvailable(model) &&
    fileNames.some((fileName) => uploadAdmissionFormatFor(fileName, "", "attachment")?.kind === "image");
  return image ? `${message}. ${imageRouteUnavailableMessage(model, workspaceAvailable)}` : message;
}
