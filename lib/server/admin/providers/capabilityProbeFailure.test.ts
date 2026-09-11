import { describe, expect, it } from "vitest";
import { capabilityFailureAttempt, retryCapabilityAttempt } from "./capabilityProbeFailure";
import { GeminiHttpError } from "../../providers/geminiInteractionsTransport";

const input = { attempts: 1, capability: "directPdf" as const,
  adapterKind: "openrouter_chat_completions" as const, accessVerified: true, timedOut: false };

describe("bounded capability failure receipts", () => {
  it("limits an exact Anthropic forced-call rejection to that capability", () => {
    const error = Object.assign(new Error("provider_capability_unsupported"), {
      httpStatus: 400, unsupportedCapability: "forcedToolCall"
    });
    const anthropic = { ...input, adapterKind: "anthropic_messages" as const };
    expect(capabilityFailureAttempt(error, { ...anthropic, capability: "forcedToolCall" }))
      .toMatchObject({ status: "unsupported", reason: "route_unsupported", httpStatus: 400 });
    expect(capabilityFailureAttempt(error, { ...anthropic, capability: "toolCalling" }).status).toBe("incomplete");
  });
  it.each(["malformed_tool_call", "malformed_function_call"] as const)("retries generated %s once, preserving input and auth failures", (code) => {
    const gemini = { ...input, adapterKind: "gemini_interactions_native" as const, capability: "parallelToolCalls" as const };
    const receipt = capabilityFailureAttempt(new GeminiHttpError(400, code), gemini);
    expect(receipt).toEqual({ attempts: 1, status: "incomplete", reason: "malformed_tool_output", httpStatus: 400 });
    expect(retryCapabilityAttempt(receipt)).toBe(true);
    expect(retryCapabilityAttempt({ ...receipt, attempts: 2 })).toBe(false);
    expect(capabilityFailureAttempt(new GeminiHttpError(401, code), gemini).reason).toBe("authorization");
    expect(capabilityFailureAttempt(new GeminiHttpError(400, "invalid_request"), gemini).reason).toBe("invalid_input");
    expect(capabilityFailureAttempt(new GeminiHttpError(400, "parameter_unknown"), gemini).reason).toBe("invalid_input");
    expect(capabilityFailureAttempt(Object.assign(new Error("private"), { code, httpStatus: 400 }), gemini).reason).toBe("invalid_input");
  });

  it.each([
    [400, "invalid_input", false], [401, "authorization", false], [403, "authorization", false],
    [429, "rate_limit", true], [503, "http_error", true]
  ] as const)("keeps HTTP %s inconclusive and projects no provider payload", (status, reason, retry) => {
    const receipt = capabilityFailureAttempt(Object.assign(new Error("private response"), {
      httpStatus: status, response: { secret: "private-body" }
    }), input);
    expect(receipt).toEqual({ attempts: 1, status: "incomplete", reason, httpStatus: status });
    expect(retryCapabilityAttempt(receipt)).toBe(retry);
    expect(retryCapabilityAttempt({ ...receipt, attempts: 3 })).toBe(false);
  });

  it("settles only explicit deterministic incompatibility or an accessible OpenRouter capability route", () => {
    const unsupported = Object.assign(new Error("provider_capability_unsupported"), { httpStatus: 400 });
    expect(capabilityFailureAttempt(unsupported, input).status).toBe("incomplete");
    expect(capabilityFailureAttempt(Object.assign(unsupported, { unsupportedInput: true }), input).status).toBe("unsupported");
    const missing = Object.assign(new Error("provider_request_failed"), { httpStatus: 404 });
    expect(capabilityFailureAttempt(missing, input)).toMatchObject({ status: "unsupported", reason: "route_unsupported" });
    for (const override of [{ accessVerified: false }, { capability: "modelAccess" as const }, { capability: "streaming" as const },
      { adapterKind: "openai_responses_compatible" as const }]) {
      expect(capabilityFailureAttempt(missing, { ...input, ...override }).status).toBe("incomplete");
    }
    expect(capabilityFailureAttempt(Object.assign(new Error("blocked"), { code: "provider_response_not_retryable", httpStatus: 404 }), input).status).toBe("incomplete");
  });

  it.each(["refusal", "budget_exhausted", "semantic_inconclusive"] as const)("bounds %s to two attempts", (reason) => {
    const receipt = capabilityFailureAttempt(Object.assign(new Error("private"), { capabilityFailureReason: reason }), input);
    expect(receipt.reason).toBe(reason);
    expect(retryCapabilityAttempt(receipt)).toBe(true);
    expect(retryCapabilityAttempt({ ...receipt, attempts: 2 })).toBe(false);
  });

  it("separates deadline and network errors and refuses invented reason/status values", () => {
    expect(capabilityFailureAttempt(new TypeError("private host"), input).reason).toBe("network");
    const timeout = capabilityFailureAttempt(new Error("private"), { ...input, timedOut: true });
    expect(timeout.reason).toBe("timeout");
    expect(retryCapabilityAttempt(timeout)).toBe(false);
    expect(capabilityFailureAttempt({ httpStatus: 999, capabilityFailureReason: "private", raw: "private" }, input))
      .toEqual({ attempts: 1, status: "incomplete", reason: "semantic_inconclusive" });
  });
});
