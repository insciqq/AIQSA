import { ATTACHMENT_EXTRACTED_TEXT_MAX_CHARS } from "../../contracts/uploads";

export type AttachmentTextConfig = Readonly<{
  extractedTextMaxChars: number;
}>;

function reductionOnlyPositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || !/^\d+$/u.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= fallback
    ? parsed
    : fallback;
}

export function getAttachmentTextConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env
): AttachmentTextConfig {
  return Object.freeze({
    extractedTextMaxChars: reductionOnlyPositiveInteger(
      environment.AIQSA_ATTACHMENT_EXTRACTED_TEXT_MAX_CHARS,
      ATTACHMENT_EXTRACTED_TEXT_MAX_CHARS
    )
  });
}
