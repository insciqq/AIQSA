import type { UploadedAttachmentWire } from "@/lib/contracts/uploads";

export const ATTACHMENT_POLL_TIMEOUT_ERROR_CODE = "attachment_poll_timeout";
export const ATTACHMENT_UNAVAILABLE_ERROR_CODE = "attachment_unavailable";

type AttachmentFailure = Pick<UploadedAttachmentWire, "processingErrorCode">;

export function attachmentRetryAvailable(attachment: AttachmentFailure): boolean {
  return attachment.processingErrorCode !== ATTACHMENT_UNAVAILABLE_ERROR_CODE;
}

export function clientAttachmentFailureMessage(
  processingErrorCode: string | null | undefined
): string | null {
  if (processingErrorCode === ATTACHMENT_UNAVAILABLE_ERROR_CODE) {
    return "This file is no longer available.";
  }
  if (processingErrorCode === ATTACHMENT_POLL_TIMEOUT_ERROR_CODE) {
    return "Processing is taking longer than expected.";
  }
  return null;
}
