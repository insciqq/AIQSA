import { describe, expect, it } from "vitest";
import { contextRejectionDiagnostics, maskedDiagnostic, providerErrorFromBody } from "./context-rejection-smoke-support";

describe("context-rejection smoke diagnostics", () => {
  it("masks every digit and bounds the sentence", () => {
    expect(maskedDiagnostic("The input token count (1200000) exceeds 1048576.", 240))
      .toBe("The input token count (#######) exceeds #######.");
    expect(maskedDiagnostic(400, 64)).toBe("###");
    expect(maskedDiagnostic("x".repeat(500), 240)).toHaveLength(240);
    expect(maskedDiagnostic({ message: "nested" }, 64)).toBeNull();
  });

  it("reads the error of a JSON envelope, a streaming array or the newest SSE failure", () => {
    expect(providerErrorFromBody(JSON.stringify({ error: { code: 400, message: "m", status: "INVALID_ARGUMENT" } })))
      .toEqual({ code: 400, message: "m", status: "INVALID_ARGUMENT" });
    expect(providerErrorFromBody(JSON.stringify([{ error: { code: "invalid_request", message: "m" } }])))
      .toEqual({ code: "invalid_request", message: "m" });
    const sse = [
      "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"r\"}}",
      "data: ",
      "event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"context_length_exceeded\",\"message\":\"m\"}}}",
      "event: error\ndata: not-json"
    ].join("\n\n");
    expect(providerErrorFromBody(sse)).toEqual({ code: "context_length_exceeded", message: "m" });
    expect(providerErrorFromBody("data: {\"type\":\"error\",\"code\":\"c\",\"message\":\"m\"}\n\n"))
      .toEqual({ code: "c", message: "m", type: "error" });
    expect(providerErrorFromBody("<html>busy</html>")).toBeNull();
  });

  it("reports only the transport identity, a local code and masked provider facts", () => {
    const gemini = Object.assign(new Error("Gemini request failed with status 400"), { code: undefined, httpStatus: 400 });
    expect(contextRejectionDiagnostics(gemini, JSON.stringify({ error: { code: 400, status: "INVALID_ARGUMENT",
      message: "Input of 1200000 tokens is over the 1048576 limit" } }))).toEqual({
      identity: null, localCode: null, message: "Input of ####### tokens is over the ####### limit",
      providerCode: "###", providerStatus: "INVALID_ARGUMENT"
    });
    expect(contextRejectionDiagnostics(new Error("openai_response_identity_mismatch"), "")).toEqual({
      identity: null, localCode: "openai_response_identity_mismatch", message: null, providerCode: null, providerStatus: null
    });
    // A local message that is not a snake_case code never passes through.
    expect(contextRejectionDiagnostics(new Error("Provider said: PRIVATE_TEXT"), "").localCode).toBeNull();
  });
});
