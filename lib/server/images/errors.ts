import { decodeImageFailureDiagnostic, type ImageFailureDiagnostic } from "../../contracts/imageGeneration";
import { ImageGenerationError, type ImageGenerationErrorCode, type ImageFinishReason } from "../providers/imageGeneration";
import { ImageInputError } from "./inputError";

/** A new LLM call must not automatically retry an uncertain paid image dispatch. */
export function imageDispatchMustStop(error: unknown): boolean {
  if (error instanceof ImageInputError) return false;
  const code = error instanceof Error ? error.message : "";
  return !["image_input_invalid", "image_parameters_invalid", "image_reference_unavailable", "image_reference_invalid"].includes(code);
}

const adapterCodes: Readonly<Record<ImageGenerationErrorCode, true>> = {
  image_input_invalid: true, image_parameters_invalid: true, image_response_invalid: true, image_response_too_large: true,
  image_provider_http_error: true, image_provider_request_failed: true, image_request_timed_out: true,
  image_request_cancelled: true, image_output_missing: true, image_generation_refused: true
};
// Stable codes the image service and run paths throw before or around dispatch.
const serviceCodes = new Set([
  "image_access_revoked", "image_binding_unavailable", "image_dispatch_claimed", "image_editing_unavailable",
  "image_generation_unavailable", "image_provider_revoked", "image_publication_stale", "image_reference_invalid",
  "image_reference_unavailable", "image_run_inactive", "image_tool_budget_exhausted", "image_tool_not_claimed",
  "image_tool_unavailable"
]);

/** Persisted with the failed call and the run error: allowlisted codes and
 * numbers only, never provider text, prompts or credentials. */
export type ImageFailureEvidence = Readonly<{
  code: string;
  /** The adapter's classification of an HTTP rejection; null without one. */
  category: ImageFailureDiagnostic["category"] | null;
  httpStatus: number | null;
  finishReason?: ImageFinishReason;
  parameter?: NonNullable<ImageFailureDiagnostic["parameter"]>;
}>;

const NOT_REPEATED = "The request was not repeated.";
const SAVED = "Any saved image remains in the chat.";
const UNCONFIRMED = `Image generation could not finish. ${NOT_REPEATED} ${SAVED}`;

const categoryMessages: Readonly<Record<Exclude<ImageFailureDiagnostic["category"], "invalid_parameter" | "unknown">, string>> = {
  quota: `Image generation failed because the image provider reported insufficient quota or credits. ${NOT_REPEATED} An administrator may need to add credits or raise the limit before you try again. ${SAVED}`,
  rate_limit: `Image generation failed because the image provider is limiting the request rate. ${NOT_REPEATED} Wait a minute before asking again. ${SAVED}`,
  authorization: `Image generation failed because the image provider rejected the configured credentials or permissions. ${NOT_REPEATED} Ask an administrator to check the image provider settings. ${SAVED}`,
  safety: `Image generation failed because the image provider declined the request under its content policy. ${NOT_REPEATED} Rephrasing the request may help. ${SAVED}`,
  upstream_unavailable: `Image generation failed because the image provider is temporarily unavailable. ${NOT_REPEATED} Try again later. ${SAVED}`
};
const codeMessages: Readonly<Partial<Record<ImageGenerationErrorCode, string>>> = {
  image_generation_refused: `The image provider answered without a completed image. ${NOT_REPEATED} Rephrasing the request may help. ${SAVED}`,
  image_request_timed_out: `Image generation timed out waiting for the image provider, so its outcome is unknown. ${NOT_REPEATED} ${SAVED}`,
  image_provider_request_failed: `The connection to the image provider failed before a response arrived, so the outcome is unknown. ${NOT_REPEATED} ${SAVED}`,
  image_response_invalid: `The image provider returned a response that could not be read as an image. ${NOT_REPEATED} ${SAVED}`,
  image_response_too_large: `The image provider returned a response larger than the allowed size. ${NOT_REPEATED} ${SAVED}`,
  image_output_missing: `The image provider responded without an image. ${NOT_REPEATED} Rephrasing the request may help. ${SAVED}`
};
// The run's image model lacks the verified capability: refused before any
// dispatch, and no other model stands in.
const capabilityMessages: Readonly<Record<string, string>> = {
  image_editing_unavailable: `Image editing is unavailable with this chat's image model, so nothing was sent to the image provider. Ask for a new image instead, or use an image model that can edit images. ${SAVED}`,
  image_generation_unavailable: `Creating new images is unavailable with this chat's image model, so nothing was sent to the image provider. Ask to edit an existing image instead, or use an image model that can create images. ${SAVED}`
};

function evidenceMessage(evidence: ImageFailureEvidence): string {
  if (evidence.code === "image_generation_refused" && evidence.finishReason === "safety") return categoryMessages.safety;
  if (evidence.code === "image_generation_refused" && evidence.finishReason === "blocked") {
    return `The image provider blocked the request and did not complete an image. ${NOT_REPEATED} Rephrasing the request may help. ${SAVED}`;
  }
  if (evidence.category === "invalid_parameter") {
    return `Image generation failed because the image provider rejected ${evidence.parameter ? `the “${evidence.parameter}” parameter` : "a request parameter"}. ${NOT_REPEATED} Try different image settings or a different request. ${SAVED}`;
  }
  if (evidence.category === "unknown") {
    return `Image generation failed because the image provider rejected the request${evidence.httpStatus ? ` with HTTP ${evidence.httpStatus}` : ""}. ${NOT_REPEATED} ${SAVED}`;
  }
  if (evidence.category) return categoryMessages[evidence.category];
  if (Object.hasOwn(capabilityMessages, evidence.code)) return capabilityMessages[evidence.code]!;
  return Object.hasOwn(codeMessages, evidence.code) ? codeMessages[evidence.code as ImageGenerationErrorCode]! : UNCONFIRMED;
}

/** The one owner of a run-ending image failure's cause and user-facing text,
 * shared by execution and recovery so an identical failure reads the same. */
export function imageGenerationFailure(error: unknown): Readonly<{ evidence: ImageFailureEvidence; message: string }> {
  let evidence: ImageFailureEvidence;
  if (error instanceof ImageGenerationError && Object.hasOwn(adapterCodes, error.code)) {
    const httpStatus = Number.isInteger(error.httpStatus) && error.httpStatus! >= 100 && error.httpStatus! <= 599 ? error.httpStatus : null;
    const diagnostic = error.code === "image_provider_http_error" && httpStatus !== null
      ? decodeImageFailureDiagnostic(error.diagnostic) : null;
    evidence = { category: diagnostic?.category ?? (httpStatus !== null ? "unknown" : null), code: error.code, httpStatus,
      ...(error.code === "image_generation_refused" && ["safety", "blocked", "other"].includes(error.finishReason ?? "")
        ? { finishReason: error.finishReason } : {}),
      ...(diagnostic?.parameter ? { parameter: diagnostic.parameter } : {}) };
  } else {
    const code = error instanceof Error && serviceCodes.has(error.message) ? error.message : "unknown";
    evidence = { category: null, code, httpStatus: null };
  }
  return { evidence, message: evidenceMessage(evidence) };
}
