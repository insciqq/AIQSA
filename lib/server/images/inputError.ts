export type ImageInputErrorCode = "image_input_invalid" | "image_parameters_invalid" |
  "image_reference_not_found" | "image_reference_unsupported" | "image_reference_invalid" | "image_reference_unavailable";

/** A correctable refusal before the paid dispatch; reference IDs are model input, never log fields. */
export class ImageInputError extends Error {
  constructor(readonly code: ImageInputErrorCode, readonly referenceId?: string) {
    super(code);
    this.name = "ImageInputError";
  }
}

export function imageInputFailure(error: unknown): Readonly<{ code: ImageInputErrorCode; message: string }> | null {
  if (!(error instanceof ImageInputError)) return null;
  const reference = error.referenceId === undefined ? "The reference image" : `Reference image_id ${JSON.stringify(error.referenceId)}`;
  const messages: Record<ImageInputErrorCode, string> = {
    image_input_invalid: "The image request is invalid or exceeds the input limits. Correct the prompt or image_ids and try again.",
    image_parameters_invalid: "The image settings are unsupported. Correct the parameters and try again.",
    image_reference_not_found: `${reference} was not found among the available image references. Copy the exact image_id from the conversation or an earlier image result and try again.`,
    image_reference_unsupported: `${reference} is unsupported or its bytes do not match its MIME type. Accepted references are valid, static PNG, JPEG or WebP images within the image limits. Choose a supported reference; images are not automatically converted.`,
    image_reference_invalid: `${reference} failed its stored size or checksum check. Choose another valid reference and try again.`,
    image_reference_unavailable: `${reference} could not be read from storage right now. Try again later or choose another reference.`
  };
  return { code: error.code, message: `${messages[error.code]} Nothing was sent to the image provider.` };
}
