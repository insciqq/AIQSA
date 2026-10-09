import { describe, expect, it } from "vitest";
import { imageDispatchMustStop, imageGenerationFailure } from "./errors";
import { ImageGenerationError, type ImageGenerationErrorCode } from "../providers/imageGeneration";
import { ImageInputError } from "./inputError";
import { observedFailureCode } from "../providers/providerObservability";
import { imageFailureDiagnostic } from "../providers/imageFailure";

const NOT_REPEATED = "The request was not repeated.";
const PRIVATE = ["PRIVATE_PROVIDER_TEXT", "PRIVATE_PROMPT_TEXT", "sk-private-secret", "private_field"];

function httpFailure(status: number, error?: Record<string, unknown>) {
  const body = JSON.stringify({ error: { message: "PRIVATE_PROVIDER_TEXT for PRIVATE_PROMPT_TEXT", key: "sk-private-secret", ...error } });
  return new ImageGenerationError("image_provider_http_error", status, imageFailureDiagnostic(body, status));
}

describe("image generation failure causes", () => {
  it.each([
    [402, undefined, "quota", "reported insufficient quota or credits"],
    [429, undefined, "rate_limit", "is limiting the request rate"],
    [401, undefined, "authorization", "rejected the configured credentials or permissions"],
    [403, undefined, "authorization", "rejected the configured credentials or permissions"],
    [500, undefined, "upstream_unavailable", "is temporarily unavailable"],
    [503, undefined, "upstream_unavailable", "is temporarily unavailable"],
    [400, { code: "content_policy_violation" }, "safety", "declined the request under its content policy"],
    [400, { code: "invalid_parameter" }, "invalid_parameter", "rejected a request parameter"]
  ] as const)("explains HTTP %i %j as %s", (status, error, category, cause) => {
    const failure = imageGenerationFailure(httpFailure(status, error));

    expect(failure.evidence).toEqual({ category, code: "image_provider_http_error", httpStatus: status });
    expect(failure.message).toContain(cause);
    expect(failure.message).toContain(NOT_REPEATED);
    for (const value of PRIVATE) expect(JSON.stringify(failure)).not.toContain(value);
  });

  it("names only an allowlisted rejected parameter", () => {
    const allowed = imageGenerationFailure(httpFailure(400, { code: "invalid_parameter", param: "size" }));
    expect(allowed.evidence).toEqual({ category: "invalid_parameter", code: "image_provider_http_error", httpStatus: 400, parameter: "size" });
    expect(allowed.message).toContain("rejected the “size” parameter");

    const unlisted = imageGenerationFailure(httpFailure(400, { code: "invalid_parameter", param: "private_field" }));
    expect(unlisted.evidence).toEqual({ category: "invalid_parameter", code: "image_provider_http_error", httpStatus: 400 });
    for (const value of PRIVATE) expect(JSON.stringify(unlisted)).not.toContain(value);
  });

  it("reports an unrecognized HTTP rejection by its status only", () => {
    const failure = imageGenerationFailure(httpFailure(404));
    expect(failure.evidence).toEqual({ category: "unknown", code: "image_provider_http_error", httpStatus: 404 });
    expect(failure.message).toContain("HTTP 404");
    expect(failure.message).toContain(NOT_REPEATED);
  });

  it.each([
    ["image_request_timed_out", "outcome is unknown"],
    ["image_provider_request_failed", "outcome is unknown"],
    ["image_response_invalid", "could not be read as an image"],
    ["image_response_too_large", "larger than the allowed size"],
    ["image_output_missing", "responded without an image"]
  ] as const)("gives %s without an HTTP response its own text", (code, cause) => {
    const failure = imageGenerationFailure(new ImageGenerationError(code));
    expect(failure.evidence).toEqual({ category: null, code, httpStatus: null });
    expect(failure.message).toContain(cause);
    expect(failure.message).toContain(NOT_REPEATED);
  });

  it.each([
    ["image_editing_unavailable", "Image editing is unavailable with this chat's image model"],
    ["image_generation_unavailable", "Creating new images is unavailable with this chat's image model"]
  ] as const)("names %s as refused before any dispatch, never as an unknown outcome", (code, cause) => {
    const failure = imageGenerationFailure(new Error(code));
    expect(failure.evidence).toEqual({ category: null, code, httpStatus: null });
    expect(failure.message).toContain(`${cause}, so nothing was sent to the image provider.`);
    expect(failure.message).not.toContain("could not finish");
  });

  it("keeps the unconfirmed text for other failures and never trusts foreign fields", () => {
    const forged = Object.assign(new Error("PRIVATE_PROVIDER_TEXT"), { code: "image_provider_http_error", httpStatus: 429,
      diagnostic: { category: "quota" } });
    for (const error of [new Error("image_publication_stale"), forged, "image_request_timed_out", null]) {
      const failure = imageGenerationFailure(error);
      expect(failure.message).toBe(`Image generation could not finish. ${NOT_REPEATED} Any saved image remains in the chat.`);
      expect(failure.evidence.category).toBeNull();
      expect(failure.evidence.httpStatus).toBeNull();
      for (const value of PRIVATE) expect(JSON.stringify(failure)).not.toContain(value);
    }
    expect(imageGenerationFailure(new Error("image_publication_stale")).evidence.code).toBe("image_publication_stale");
    expect(imageGenerationFailure(forged).evidence.code).toBe("unknown");
    const outOfRange = new ImageGenerationError("image_provider_http_error", 700, { category: "unknown" });
    expect(imageGenerationFailure(outOfRange).evidence.httpStatus).toBeNull();
  });

  it.each(["safety", "blocked", "other"] as const)("retains only the %s finish category of a Gemini refusal", (finishReason) => {
    const error = new ImageGenerationError("image_generation_refused", null, undefined, finishReason);
    const failure = imageGenerationFailure(error);
    expect(failure.evidence).toEqual({ code: "image_generation_refused", category: null, httpStatus: null, finishReason });
    expect(failure.message).toContain(finishReason === "safety" ? "content policy" : finishReason === "blocked" ? "blocked" : "without a completed image");
    expect(imageDispatchMustStop(error)).toBe(true);
    expect(observedFailureCode(error)).toBe(error.code);
  });

  it.each(["image_reference_not_found", "image_reference_unsupported", "image_reference_invalid", "image_input_invalid", "image_parameters_invalid"] as const)(
    "registers the correctable %s refusal without fatal dispatch semantics", (code) => {
      const error = new ImageInputError(code, "private-id");
      expect(imageDispatchMustStop(error)).toBe(false);
      expect(observedFailureCode(error)).toBe(code);
    });

  it("keeps input failures non-fatal and every dispatched failure fatal", () => {
    for (const code of ["image_input_invalid", "image_parameters_invalid"] as const satisfies readonly ImageGenerationErrorCode[]) {
      expect(imageDispatchMustStop(new ImageGenerationError(code))).toBe(false);
    }
    for (const code of ["image_reference_unavailable", "image_reference_invalid"]) expect(imageDispatchMustStop(new Error(code))).toBe(false);
    expect(imageDispatchMustStop(httpFailure(429))).toBe(true);
    expect(imageDispatchMustStop(new ImageGenerationError("image_request_timed_out"))).toBe(true);
  });
});
