import { ATTACHMENT_EXTRACTED_TEXT_MAX_CHARS } from "../../contracts/uploads";

export type AttachmentTextConfig = Readonly<{
  extractedTextMaxChars: number;
}>;

const ATTACHMENT_EXTRACTED_TEXT_MAX_CHARS_ENV = "AIQSA_ATTACHMENT_EXTRACTED_TEXT_MAX_CHARS";

/** The operator may only lower the wire bound. A malformed or larger value is
 * rejected rather than silently replaced by the default; Compose forwards an
 * unset optional value as an empty string. */
function reductionOnlyPositiveInteger(value: string | undefined, ceiling: number): number {
  if (value === undefined || value.trim() === "") return ceiling;
  const parsed = /^\d+$/u.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > ceiling) {
    throw Object.assign(
      new Error(`attachment_text_config_invalid: ${ATTACHMENT_EXTRACTED_TEXT_MAX_CHARS_ENV} must be an integer from 1 to ${ceiling}`),
      { code: "attachment_text_config_invalid", setting: ATTACHMENT_EXTRACTED_TEXT_MAX_CHARS_ENV }
    );
  }
  return parsed;
}

export function getAttachmentTextConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env
): AttachmentTextConfig {
  return Object.freeze({
    extractedTextMaxChars: reductionOnlyPositiveInteger(
      environment[ATTACHMENT_EXTRACTED_TEXT_MAX_CHARS_ENV],
      ATTACHMENT_EXTRACTED_TEXT_MAX_CHARS
    )
  });
}
