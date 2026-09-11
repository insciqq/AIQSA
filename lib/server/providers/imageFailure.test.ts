import { describe, expect, it } from "vitest";
import { imageFailureDiagnostic } from "./imageFailure";
import { decodeAdminProviderCapabilityAttempts } from "../../contracts/adminProviders";

describe("content-free image rejection diagnostics", () => {
  it.each([
    ["invalid_parameter", "invalid_parameter"], ["content_policy_violation", "safety"], ["insufficient_quota", "quota"],
    ["rate_limit_exceeded", "rate_limit"], ["permission_denied", "authorization"], ["service_unavailable", "upstream_unavailable"]
  ])("normalizes %s without retaining provider content", (code, category) => {
    const result = imageFailureDiagnostic(JSON.stringify({ error: { code, param: "resolution", message: "private prompt and secret",
      provider: "private-upstream", metadata: { private: "private" } } }), 400);
    expect(result).toEqual({ category, parameter: "resolution" });
  });

  it("recognizes bounded structured upstream errors but never infers a cause from raw prose", () => {
    expect(imageFailureDiagnostic(JSON.stringify({ error: { code: 400, metadata: { raw: JSON.stringify({ error: {
      code: "unsupported_parameter", param: "quality", message: "private details" } }) } } }), 400))
      .toEqual({ category: "invalid_parameter", parameter: "quality" });
    for (const text of ["malformed", "x".repeat(32769), JSON.stringify({ error: { message: "blocked by safety", param: "private-secret", code: "private-code" } }),
      JSON.stringify({ error: { code: "__proto__", param: "constructor" } })]) {
      expect(imageFailureDiagnostic(text, 400)).toEqual({ category: "unknown" });
    }
  });

  it("reads old receipts and rejects arbitrary diagnostic fields before persistence or display", () => {
    const attempt = { attempts: 1, status: "incomplete", reason: "invalid_input", httpStatus: 400 };
    expect(decodeAdminProviderCapabilityAttempts({ imageGeneration: attempt })).toEqual({ imageGeneration: attempt });
    const current = { ...attempt, imageFailure: { category: "invalid_parameter", parameter: "resolution" } };
    expect(decodeAdminProviderCapabilityAttempts({ imageGeneration: current })).toEqual({ imageGeneration: current });
    for (const imageFailure of [{ category: "private" }, { category: "unknown", parameter: "private" }, { category: "unknown", message: "private" }]) {
      expect(decodeAdminProviderCapabilityAttempts({ imageGeneration: { ...attempt, imageFailure } })).toBeNull();
    }
    expect(decodeAdminProviderCapabilityAttempts({ structuredOutput: current })).toBeNull();
  });
});
