import { estimateApproxTokens } from "../../domain/contextBudget";
import type { ProviderAttachment, ProviderModelCapabilities } from "./types";

export const defaultMaxAttachmentTextChars = 20000;

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

export function truncateProviderAttachmentText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
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
  maxChars = defaultMaxAttachmentTextChars
): string | null {
  if (!attachment.extractedText?.trim()) {
    return null;
  }

  return `[${providerAttachmentTextLabel(attachment)}]\n${truncateProviderAttachmentText(
    attachment.extractedText,
    maxChars
  )}`;
}

function imageProxyTokens(attachment: ProviderAttachment): number {
  const image = metadataRecord(attachment, "image");
  const width = numberValue(image.width);
  const height = numberValue(image.height);

  if (!width || !height) {
    return 512;
  }

  return 85 + Math.ceil(width / 512) * Math.ceil(height / 512) * 170;
}

function nativePdfProxyTokens(attachment: ProviderAttachment): number {
  const pdf = metadataRecord(attachment, "pdf");
  const pageCount = numberValue(pdf.pageCount);
  const extractedTextTokens = attachment.extractedText?.trim()
    ? estimateApproxTokens(attachment.extractedText)
    : 0;
  const pageTokens = pageCount ? pageCount * 512 : 0;
  const fallbackByteTokens = !pageTokens && !extractedTextTokens
    ? Math.ceil(Math.max(attachment.byteSize, 1) / 4096) * 256
    : 0;

  return Math.max(256, extractedTextTokens + pageTokens, fallbackByteTokens);
}

export function providerAttachmentBudgetTokens(input: {
  attachments: ProviderAttachment[];
  maxAttachmentTextChars?: number;
  modelCapabilities: ProviderModelCapabilities;
}): number {
  const maxChars = input.maxAttachmentTextChars ?? defaultMaxAttachmentTextChars;

  return input.attachments.reduce((total, attachment) => {
    if (attachment.kind === "image") {
      return total + imageProxyTokens(attachment);
    }

    if (attachment.kind === "pdf" && input.modelCapabilities.nativePdfInput) {
      return total + nativePdfProxyTokens(attachment);
    }

    if (attachment.kind === "pdf" || attachment.kind === "document") {
      const text = providerAttachmentText(attachment, maxChars);
      return total + (text ? estimateApproxTokens(text) : 0);
    }

    return total;
  }, 0);
}
