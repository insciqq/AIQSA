import { estimateApproxTokens } from "../../domain/contextBudget";
import { imageTokenEstimator, type ImageDimensions, type ImageTokenEstimate } from "../../domain/imageTokenEstimate";
import { pdfPageCountFromMetadata } from "../../contracts/uploads";
import type { ProviderAttachment, ProviderModelCapabilities } from "./types";

export function usesNativePdfInput(attachment: Pick<ProviderAttachment, "kind" | "pdfDelivery">,
  capabilities: Pick<ProviderModelCapabilities, "nativePdfInput">): boolean {
  return attachment.kind === "pdf" && attachment.pdfDelivery !== "prepared_text" && capabilities.nativePdfInput === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function metadataRecord(attachment: ProviderAttachment, key: string): Record<string, unknown> {
  return isRecord(attachment.metadata) && isRecord(attachment.metadata[key])
    ? attachment.metadata[key]
    : {};
}

export function truncateProviderAttachmentText(text: string, maxChars?: number): string {
  if (maxChars === undefined || text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} chars]`;
}

export function providerAttachmentTextLabel(attachment: ProviderAttachment): string {
  if (attachment.kind === "pdf") {
    return `Attached PDF: ${attachment.fileName}`;
  }

  return `Attached document: ${attachment.fileName} (${attachment.mimeType || "unknown type"})`;
}

export function providerAttachmentText(
  attachment: ProviderAttachment,
  maxChars?: number
): string | null {
  if (!attachment.extractedText?.trim()) {
    return null;
  }

  return `[${providerAttachmentTextLabel(attachment)}]\n${truncateProviderAttachmentText(
    attachment.extractedText,
    maxChars
  )}`;
}

export const providerAttachmentPreviewFilename = "[attachment filename omitted]";
export const providerAttachmentPreviewMediaType = "[attachment media type omitted]";

export function providerAttachmentPreviewText(
  attachment: ProviderAttachment
): string | null {
  if (!attachment.extractedText?.trim()) {
    return null;
  }

  return attachment.kind === "pdf"
    ? "[PDF attachment text omitted]"
    : "[Document attachment text omitted]";
}

function imageDimensions(attachment: ProviderAttachment): ImageDimensions | null {
  const image = metadataRecord(attachment, "image");
  const width = numberValue(image.width);
  const height = numberValue(image.height);
  return width && height ? { height, width } : null;
}

const undeclaredImageTokens = imageTokenEstimator({ provider: "unknown" });

function nativePdfProxyTokens(attachment: ProviderAttachment, estimateTokens: (value: unknown) => number): number {
  const pageCount = pdfPageCountFromMetadata(attachment.metadata)
    ?? pdfPageCountFromMetadata({ pdfPageCount: metadataRecord(attachment, "pdf").pageCount });
  const extractedTextTokens = attachment.extractedText?.trim()
    ? estimateTokens(attachment.extractedText)
    : 0;
  const pageTokens = pageCount ? pageCount * 512 : 0;
  const fallbackByteTokens = !pageTokens && !extractedTextTokens
    ? Math.ceil(Math.max(attachment.byteSize, 1) / 4096) * 256
    : 0;

  return Math.max(256, extractedTextTokens + pageTokens, fallbackByteTokens);
}

export function providerAttachmentBudgetTokens(input: {
  attachments: ProviderAttachment[];
  /** The request's context estimate; defaults to the character weights. */
  estimateTokens?: (value: unknown) => number;
  /** The request's image policy (`imageTokenEstimator`); defaults to the
   * conservative fallback of an undeclared provider family. */
  estimateImageTokens?: ImageTokenEstimate;
  maxAttachmentTextChars?: number;
  modelCapabilities: ProviderModelCapabilities;
}): number {
  const estimateTokens = input.estimateTokens ?? estimateApproxTokens;
  const estimateImageTokens = input.estimateImageTokens ?? undeclaredImageTokens;
  return input.attachments.reduce((total, attachment) => {
    if (attachment.kind === "image") {
      return total + (input.modelCapabilities.vision ? estimateImageTokens(imageDimensions(attachment)) : 0);
    }

    if (usesNativePdfInput(attachment, input.modelCapabilities)) {
      return total + nativePdfProxyTokens(attachment, estimateTokens);
    }

    if (attachment.kind === "pdf" || attachment.kind === "document") {
      const text = providerAttachmentText(attachment, input.maxAttachmentTextChars);
      return total + (text ? estimateTokens(text) : 0);
    }

    return total;
  }, 0);
}
