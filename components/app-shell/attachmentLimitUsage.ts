import type { CatalogModel } from "@/components/app-shell/types";
import type { ComposerAttachment } from "@/components/app-shell/attachmentContracts";
import {
  DEFAULT_CATALOG_ATTACHMENT_LIMITS,
  type CatalogAttachmentLimits
} from "@/lib/contracts/catalog";

const ATTACHMENT_LIMIT_CAUTION_FRACTION = 0.8;
const FALLBACK_IMAGE_MIME_TYPE = "application/octet-stream";

export type AttachmentLimitUsage = {
  binaryAttachmentCount: number;
  blocking: boolean;
  count: number;
  encodedBytes: number;
  feedback: string | null;
  limits: CatalogAttachmentLimits | null;
  materializedBytes: number;
  summary: string;
  tone: "caution" | "critical" | "neutral";
  totalSourceBytes: number;
};

function safeByteSize(attachment: ComposerAttachment): number | null {
  return typeof attachment.byteSize === "number" &&
    Number.isSafeInteger(attachment.byteSize) &&
    attachment.byteSize >= 0
    ? attachment.byteSize
    : null;
}

function saturatingAdd(left: number, right: number): number {
  if (left >= Number.MAX_SAFE_INTEGER - right) {
    return Number.MAX_SAFE_INTEGER;
  }

  return left + right;
}

function base64EncodedSize(byteSize: number): number {
  const encoded = 4 * Math.ceil(byteSize / 3);
  return Number.isSafeInteger(encoded) ? encoded : Number.MAX_SAFE_INTEGER;
}

function imageDataUrlPrefixSize(attachment: ComposerAttachment): number {
  const mimeType =
    typeof attachment.mimeType === "string" &&
    attachment.mimeType.length <= 128 &&
    /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu.test(attachment.mimeType)
      ? attachment.mimeType
      : FALLBACK_IMAGE_MIME_TYPE;

  return `data:${mimeType};base64,`.length;
}

function isBinaryMaterialized(
  attachment: ComposerAttachment,
  model: CatalogModel | undefined
): boolean {
  if (!model) {
    return attachment.kind === "image" || attachment.kind === "pdf";
  }

  if (attachment.kind === "image") {
    return model.capabilities.imageInput;
  }

  return (
    attachment.kind === "pdf" &&
    model?.capabilities.documentInputMode === "native_pdf"
  );
}

function uniqueAttachments(
  attachments: readonly ComposerAttachment[]
): ComposerAttachment[] {
  const seen = new Set<string>();
  const unique: ComposerAttachment[] = [];

  for (const attachment of attachments) {
    if (seen.has(attachment.id)) {
      continue;
    }

    seen.add(attachment.id);
    unique.push(attachment);
  }

  return unique;
}

export function formatAttachmentBytes(bytes: number): string {
  const mebibytes = bytes / (1024 * 1024);
  if (mebibytes >= 1) {
    const digits = mebibytes >= 10 ? 1 : 2;
    return `${Number(mebibytes.toFixed(digits))} MB`;
  }

  const kibibytes = bytes / 1024;
  if (kibibytes >= 1) {
    return `${Number(kibibytes.toFixed(kibibytes >= 10 ? 1 : 2))} KB`;
  }

  return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
}

function atCautionThreshold(value: number, maximum: number): boolean {
  return value / maximum >= ATTACHMENT_LIMIT_CAUTION_FRACTION;
}

function blockingFeedback(
  count: number,
  materializedBytes: number,
  encodedBytes: number,
  limits: CatalogAttachmentLimits
): string | null {
  const messages: string[] = [];

  if (count > limits.maxCount) {
    const excess = count - limits.maxCount;
    messages.push(
      `${count} attachments selected. Remove at least ${excess} ${excess === 1 ? "attachment" : "attachments"} before sending.`
    );
  }

  if (materializedBytes > limits.maxMaterializedBytes) {
    messages.push(
      `Selected attachments require about ${formatAttachmentBytes(materializedBytes)} of the ${formatAttachmentBytes(limits.maxMaterializedBytes)} attachment-data limit. Remove files or choose a model that uses extracted text.`
    );
  }

  if (encodedBytes > limits.maxEncodedBytes) {
    messages.push(
      `Selected attachments require about ${formatAttachmentBytes(encodedBytes)} of the ${formatAttachmentBytes(limits.maxEncodedBytes)} provider-input limit. Remove files or choose a model that uses extracted text.`
    );
  }

  return messages.length > 0 ? messages.join(" ") : null;
}

function cautionFeedback(
  count: number,
  materializedBytes: number,
  encodedBytes: number,
  limits: CatalogAttachmentLimits
): string | null {
  const messages: string[] = [];

  if (atCautionThreshold(count, limits.maxCount)) {
    messages.push(`${count} of ${limits.maxCount} attachments selected.`);
  }

  if (atCautionThreshold(materializedBytes, limits.maxMaterializedBytes)) {
    messages.push(
      `Selected attachments require about ${formatAttachmentBytes(materializedBytes)} of the ${formatAttachmentBytes(limits.maxMaterializedBytes)} attachment-data limit.`
    );
  }

  if (atCautionThreshold(encodedBytes, limits.maxEncodedBytes)) {
    messages.push(
      `Selected attachments require about ${formatAttachmentBytes(encodedBytes)} of the ${formatAttachmentBytes(limits.maxEncodedBytes)} provider-input limit.`
    );
  }

  return messages.length > 0 ? messages.join(" ") : null;
}

export function attachmentCountSelectionLimitMessage(input: {
  attemptedCount: number;
  currentCount: number;
  maxCount: number;
}): string {
  return `This selection would raise the attachment count from ${input.currentCount} to ${input.attemptedCount}; the limit is ${input.maxCount}.`;
}

const attachmentLimitFeedbackSuffixes = [
  /(?:^|\s)This selection would raise the attachment count from \d+ to \d+; the limit is \d+\.$/u,
  /(?:^|\s)This run contains \d+ attachments; the limit is \d+\.$/u,
  /(?:^|\s)Selected attachments require (?:about )?(?:\d+|more than the supported number of) (?:source|encoded) bytes; the limit is \d+\.$/u,
  /(?:^|\s)An attachment object did not match its recorded size\.$/u
] as const;

export function withoutAttachmentLimitFeedbackMessage(
  value: string | null
): string | null {
  if (!value) {
    return null;
  }

  for (const pattern of attachmentLimitFeedbackSuffixes) {
    const match = pattern.exec(value);
    if (match) {
      return value.slice(0, match.index).trim() || null;
    }
  }

  return value;
}

export function withAttachmentLimitFeedbackMessage(
  current: string | null,
  message: string
): string {
  const retained = withoutAttachmentLimitFeedbackMessage(current);
  return retained ? `${retained} ${message}` : message;
}

export function calculateAttachmentLimitUsage(
  attachments: readonly ComposerAttachment[],
  model: CatalogModel | undefined,
  limits: CatalogAttachmentLimits | undefined
): AttachmentLimitUsage {
  const unique = uniqueAttachments(attachments);
  let binaryAttachmentCount = 0;
  let encodedBytes = 0;
  let materializedBytes = 0;
  let totalSourceBytes = 0;
  let allSourceSizesKnown = true;

  for (const attachment of unique) {
    const binaryMaterialized = isBinaryMaterialized(attachment, model);
    if (binaryMaterialized) {
      binaryAttachmentCount += 1;
    }

    const byteSize = safeByteSize(attachment);
    if (byteSize === null) {
      allSourceSizesKnown = false;
      continue;
    }

    totalSourceBytes = saturatingAdd(totalSourceBytes, byteSize);
    if (!binaryMaterialized) {
      continue;
    }

    materializedBytes = saturatingAdd(materializedBytes, byteSize);
    encodedBytes = saturatingAdd(encodedBytes, base64EncodedSize(byteSize));
    if (attachment.kind === "image") {
      encodedBytes = saturatingAdd(encodedBytes, imageDataUrlPrefixSize(attachment));
    }
  }

  const count = unique.length;
  const summary = allSourceSizesKnown
    ? `${count} ${count === 1 ? "file" : "files"} · ${formatAttachmentBytes(totalSourceBytes)}`
    : `${count} ${count === 1 ? "file" : "files"}`;
  const resolvedLimits = limits ?? DEFAULT_CATALOG_ATTACHMENT_LIMITS;
  const blocking = blockingFeedback(count, materializedBytes, encodedBytes, resolvedLimits);
  const caution = blocking
    ? null
    : cautionFeedback(count, materializedBytes, encodedBytes, resolvedLimits);

  return {
    binaryAttachmentCount,
    blocking: Boolean(blocking),
    count,
    encodedBytes,
    feedback: blocking ?? caution,
    limits: resolvedLimits,
    materializedBytes,
    summary,
    tone: blocking ? "critical" : caution ? "caution" : "neutral",
    totalSourceBytes
  };
}
