import { IMAGE_GENERATION_CALLS_PER_ANSWER } from "../tools/imageGeneration";

export type ImageInputErrorCode = "image_input_invalid" | "image_parameters_invalid" |
  "image_reference_not_found" | "image_reference_unsupported" | "image_reference_invalid" | "image_reference_unavailable" |
  "image_tool_budget_exhausted";

/** A correctable refusal before the paid dispatch; reference IDs are model input, never log fields. */
export class ImageInputError extends Error {
  constructor(readonly code: ImageInputErrorCode, readonly referenceId?: string) {
    super(code);
    this.name = "ImageInputError";
  }
}

/** A failure of the run's image binding, access, call record or publication; never one the model caused. */
export type ImageToolErrorCode = "image_tool_unavailable" | "image_binding_unavailable" | "image_editing_unavailable" |
  "image_generation_unavailable" | "image_run_inactive" | "image_access_revoked" | "image_tool_not_claimed" |
  "image_provider_revoked" | "image_dispatch_claimed" | "image_publication_stale";

export class ImageToolError extends Error {
  constructor(readonly code: ImageToolErrorCode) {
    super(code);
    this.name = "ImageToolError";
  }
}

const NOT_SENT = "Nothing was sent to the image provider.";

export function imageInputFailure(error: unknown): Readonly<{ code: ImageInputErrorCode; message: string }> | null {
  if (!(error instanceof ImageInputError)) return null;
  const reference = error.referenceId === undefined ? "The reference image" : `Reference image_id ${JSON.stringify(error.referenceId)}`;
  const messages: Record<ImageInputErrorCode, string> = {
    image_input_invalid: "The image request is invalid or exceeds the input limits. Correct the prompt or image_ids and try again.",
    image_parameters_invalid: "The image settings are unsupported. Correct the parameters and try again.",
    image_reference_not_found: `${reference} was not found among the available image references. Copy the exact image_id from the conversation or an earlier image result and try again.`,
    image_reference_unsupported: `${reference} is unsupported or its bytes do not match its MIME type. Accepted references are valid, static PNG, JPEG or WebP images within the image limits. Choose a supported reference; images are not automatically converted.`,
    image_reference_invalid: `${reference} failed its stored size or checksum check. Choose another valid reference and try again.`,
    image_reference_unavailable: `${reference} could not be read from storage right now. Try again later or choose another reference.`,
    image_tool_budget_exhausted: `This answer already started the maximum of ${IMAGE_GENERATION_CALLS_PER_ANSWER} image generations. Finish the answer with the images it has; the user can ask for more in a new message.`
  };
  return { code: error.code, message: `${messages[error.code]} ${NOT_SENT}` };
}

/** Failures the image service raised before its dispatch claim: nothing reached the image provider. */
const notSent = new WeakSet<object>();

/** Marks a failure raised before the dispatch claim, so the engine settles it as an ordinary error, not an unknown effect. */
export function markImageFailureNotSent<T>(error: T): T {
  if (typeof error === "object" && error !== null) notSent.add(error);
  return error;
}

const notSentMessages: Readonly<Partial<Record<ImageToolErrorCode, string>>> = {
  image_editing_unavailable: "Image editing is unavailable with this chat's image model. Create a new image with empty image_ids instead, or tell the user that editing is unavailable.",
  image_generation_unavailable: "Creating new images is unavailable with this chat's image model; only editing an existing image by its image_id is available."
};

/**
 * The model-facing code and message of a failure that sent nothing
 * (`markImageFailureNotSent`): a correctable refusal reads its own guidance,
 * any other failure only its registered code, never its text. Null for every
 * other failure, whose effect stays unknown.
 */
export function imageNotSentFailure(error: unknown): Readonly<{ code: string; message: string }> | null {
  if (typeof error !== "object" || error === null || !notSent.has(error)) return null;
  const input = imageInputFailure(error);
  if (input) return input;
  const code = error instanceof ImageToolError ? error.code : "image_tool_unavailable";
  const message = notSentMessages[code] ?? "The image tool could not run this call. Tell the user the image was not created.";
  return { code, message: `${message} ${NOT_SENT}` };
}
