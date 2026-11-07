import { describe, expect, it } from "vitest";
import { GeminiHttpError } from "./geminiInteractionsTransport";
import { ProviderRequestTimeoutError } from "./network";
import { providerFailureMessage } from "./providerFailureMessage";
import { providerResponseFailure } from "./responseFailure";
import { markProviderStreamDrop } from "./streamDrop";
import { ProviderStreamIdleTimeoutError } from "./streamSafety";

const names = { connection: "OpenAI (CodexLB)", model: "GPT-6-Astra" };
const TRANSIENT = "This is a problem on the provider's side, not in AIQSA. Try again in a few minutes, or choose another model.";
const REJECTED = "The provider rejected it, not AIQSA, so sending it again will not help: change the request or its attachments, or choose another model.";
const coded = (code: string, fields: Record<string, unknown> = {}) => Object.assign(new Error("PRIVATE_PROVIDER_TEXT"), { code, ...fields });

describe("provider failure text", () => {
  it.each([
    ["a stream that kept dropping", markProviderStreamDrop(new Error("stream_incomplete"), "truncated"),
      `GPT-6-Astra via OpenAI (CodexLB) kept failing before the response was complete. ${TRANSIENT}`],
    ["a response.failed server_error", markProviderStreamDrop(providerResponseFailure("openai_response_failed",
      { error: { code: "server_error", message: "PRIVATE_PROVIDER_TEXT" }, status: "failed" }), "response_failed"),
    `GPT-6-Astra via OpenAI (CodexLB) kept failing before the response was complete. ${TRANSIENT}`],
    ["a failed response without a drop", providerResponseFailure("openai_response_failed",
      { error: { code: "server_error", message: "PRIVATE_PROVIDER_TEXT" }, status: "failed" }),
    `GPT-6-Astra via OpenAI (CodexLB) could not complete the response. ${TRANSIENT}`],
    ["an HTTP 502", Object.assign(new Error("PRIVATE_PROVIDER_TEXT"), { status: 502 }),
      `GPT-6-Astra via OpenAI (CodexLB) returned a server error (HTTP 502) and kept failing when retried. ${TRANSIENT}`],
    ["a rate limit", Object.assign(new Error("PRIVATE_PROVIDER_TEXT"), { status: 429 }),
      `GPT-6-Astra via OpenAI (CodexLB) is limiting requests (HTTP 429) and the retries did not succeed. ${TRANSIENT}`],
    ["a request deadline", new ProviderRequestTimeoutError(900_000), `GPT-6-Astra via OpenAI (CodexLB) did not answer in time. ${TRANSIENT}`],
    ["a silent stream", new ProviderStreamIdleTimeoutError({ idleTimeoutMs: 900_000, observedIdleMs: 900_000 }),
      `GPT-6-Astra via OpenAI (CodexLB) did not answer in time. ${TRANSIENT}`],
    ["an unsupported capability", coded("provider_capability_unsupported"),
      `GPT-6-Astra via OpenAI (CodexLB) does not support part of this request, such as an attachment type or a tool. ${REJECTED}`],
    ["a rejected value", providerResponseFailure("provider_response_failed",
      { error: { code: "invalid_value", message: "PRIVATE_PROVIDER_TEXT" }, status: "failed" }),
    `GPT-6-Astra via OpenAI (CodexLB) rejected this request. ${REJECTED}`],
    ["a typed invalid request", new GeminiHttpError(400, "invalid_request"),
      `GPT-6-Astra via OpenAI (CodexLB) rejected the request (HTTP 400: invalid_request). ${REJECTED}`],
    ["a refusal", coded("provider_response_not_retryable", { capabilityFailureReason: "refusal" }),
      `GPT-6-Astra via OpenAI (CodexLB) refused to answer this request. ${REJECTED}`],
    ["rejected credentials", Object.assign(new Error("PRIVATE_PROVIDER_TEXT"), { status: 401 }),
      "GPT-6-Astra via OpenAI (CodexLB) rejected the configured credentials (HTTP 401). Ask an administrator to check the provider key."],
    ["an empty account", Object.assign(new Error("PRIVATE_PROVIDER_TEXT"), { status: 402 }),
      "GPT-6-Astra via OpenAI (CodexLB) reports that the account has no remaining quota or balance (HTTP 402). Ask an administrator to check the provider account."],
    ["an unreachable provider", coded("provider_http_request_failed"),
      "AIQSA could not reach GPT-6-Astra via OpenAI (CodexLB). Try again in a few minutes, or choose another model; if it keeps failing, ask an administrator to check the connection."]
  ])("names the model, its connection and the provider's side for %s", (_name, error, message) => {
    const text = providerFailureMessage(error, names);
    expect(text).toBe(message);
    expect(text).not.toContain("PRIVATE_");
  });

  it("keeps the unknown outcome of a lost request unclaimed, and names who was reached", () => {
    expect(providerFailureMessage(coded("provider_request_outcome_unknown"), names)).toBe(
      "The connection to GPT-6-Astra via OpenAI (CodexLB) was lost after the request may have been sent. Its outcome and any provider " +
      "charge are unknown, so it was not repeated automatically. Try again in a few minutes, or choose another model.");
  });

  it("names only what the binding has, and never guesses a missing name", () => {
    const failed = Object.assign(new Error("x"), { status: 503 });
    const tail = `returned a server error (HTTP 503) and kept failing when retried. ${TRANSIENT}`;
    expect(providerFailureMessage(failed, { model: "GPT-6-Astra" })).toBe(`The provider of GPT-6-Astra ${tail}`);
    expect(providerFailureMessage(failed, { connection: "OpenAI (CodexLB)", model: "  " })).toBe(`The model provider OpenAI (CodexLB) ${tail}`);
    expect(providerFailureMessage(failed, { connection: "x".repeat(121), model: null })).toBe(`The model provider ${tail}`);
    expect(providerFailureMessage(failed)).toBe(`The model provider ${tail}`);
    expect(providerFailureMessage(coded("provider_http_tls_failed"), { model: "GPT-6-Astra" }))
      .toMatch(/^AIQSA could not reach the provider of GPT-6-Astra\./u);
  });

  it("leaves AIQSA's own failures to their own wording", () => {
    expect(providerFailureMessage(new Error("bookkeeping"), names)).toBeNull();
    expect(providerFailureMessage(coded("workspace_tool_timeout"), names)).toBeNull();
    expect(providerFailureMessage(coded("provider_http_request_body_too_large"), names)).toBeNull();
    expect(providerFailureMessage(coded("provider_http_address_forbidden"), names)).toBeNull();
  });
});
