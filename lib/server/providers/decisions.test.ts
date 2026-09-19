import { describe, expect, it, vi } from "vitest";
import { jevModelConfiguration, JEV_SERVED_MODEL_ID } from "../../domain/decisionModels";
import { runWithContext } from "../observability";
import { createOpenRouterDecisionAdapter, MAX_DECISION_REQUEST_BYTES, type DecisionRequest } from "./decisions";
import { normalizeProviderModelConfiguration, providerRequestEndpoint } from "./providerConfiguration";

const connection = { allowPrivateNetwork: false, apiRoot: "https://openrouter.ai/api/v1",
  authenticationMode: "bearer" as const, responseTimeoutMs: 5_000 };
const model = jevModelConfiguration();
const request: DecisionRequest = { state: { query: "Что я предпочитаю?", memory: "Предпочитаю короткие ответы." },
  questions: { useful: { type: "noul", instructions: "Does memory help answer the query?",
    criteria: { true: "Useful evidence.", false: "Unrelated evidence." } } } };
const responseBody = { id: "decision-request", model: JEV_SERVED_MODEL_ID, provider: "TypeSafe",
  answers: { useful: { type: "noul", noul: 0.93 } }, usage: { input_tokens: 45, output_tokens: 21, cost: 0.00000189 } };
function response(overrides: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ ...responseBody, ...overrides }));
}
function adapter(fetchFn: typeof fetch, options: { secret?: string | (() => Promise<string>); responseMaxBytes?: number } = {}) {
  return createOpenRouterDecisionAdapter({ connection, model, network: { fetchFn, responseMaxBytes: options.responseMaxBytes },
    secret: options.secret ?? "PRIVATE_CREDENTIAL_CANARY" });
}

describe("OpenRouter Decisions adapter", () => {
  it("uses the Decisions API, authorized native routing and provider-reported accounting", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => response());
    const result = await adapter(fetchFn).decide(request);
    expect(fetchFn).toHaveBeenCalledExactlyOnceWith("https://openrouter.ai/api/alpha/decisions", expect.objectContaining({ method: "POST", redirect: "error" }));
    const init = fetchFn.mock.calls[0]![1]!;
    expect(JSON.parse(String(init.body))).toEqual({ model: model.upstreamModelId, state: request.state, questions: request.questions,
      provider: { allow_fallbacks: false, data_collection: "deny", only: ["typesafe"], order: ["typesafe"] } });
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer PRIVATE_CREDENTIAL_CANARY");
    expect(result).toEqual({ model: JEV_SERVED_MODEL_ID, provider: "TypeSafe", requestId: "decision-request",
      answers: responseBody.answers, usage: { inputTokens: 45, outputTokens: 21, costUsd: 0.00000189 } });
  });

  it("keeps a configured proxy origin and prefix and rejects ambiguous roots", () => {
    expect(providerRequestEndpoint({ ...connection, apiRoot: "https://gateway.example.test/openrouter/api/v1" }, "openrouter_decisions"))
      .toBe("https://gateway.example.test/openrouter/api/alpha/decisions");
    expect(() => providerRequestEndpoint({ ...connection, apiRoot: "https://gateway.example.test/unknown" }, "openrouter_decisions"))
      .toThrow("provider_api_root_invalid");
  });

  it.each([
    { modelClass: "answer" }, { modelClass: "reranker" }, { adapterKind: "openrouter_chat_completions" },
    { answerSelectable: true }, { capabilities: { ...model.capabilities, toolCalling: true } },
    { defaultParams: { max_tokens: 65536 } }, { openRouterRouting: undefined }
  ])("does not admit decisions as generation/reranking or allow undeclared parameters (%#)", (change) => {
    expect(() => normalizeProviderModelConfiguration({ ...model, ...change })).toThrow();
  });

  it.each([0, 1])("accepts boundary Noul probability %s", async (noul) => {
    const fetchFn = vi.fn<typeof fetch>(async () => response({ answers: { useful: { type: "noul", noul } } }));
    expect((await adapter(fetchFn).decide(request)).answers.useful).toEqual({ type: "noul", noul });
  });

  it("requires exact, complete choice membership while keeping optional confidence absent", async () => {
    const questions = { route: { type: "choice" as const, instructions: "Which category?", criteria: { source: "Useful source", none: "No source" } } };
    const fetchFn = vi.fn<typeof fetch>(async () => response({ answers: { route: { type: "choice", choice: "none" } } }));
    expect((await adapter(fetchFn).decide({ state: "A greeting", questions })).answers.route)
      .toEqual({ type: "choice", choice: "none", confidence: null, probabilities: null });
    fetchFn.mockImplementation(async () => response({ answers: { route: { type: "choice", choice: "source", confidence: 0.9, probabilities: { source: 0.9, none: 0.1 } } } }));
    expect((await adapter(fetchFn).decide({ state: "Question", questions })).answers.route)
      .toMatchObject({ probabilities: { source: 0.9, none: 0.1 } });
    for (const answer of [
      { type: "choice", choice: "unexpected" },
      { type: "choice", choice: "source", probabilities: { source: 0.9 } },
      { type: "choice", choice: "source", probabilities: { source: 1.1, none: -0.1 } },
      { type: "choice", choice: "source", confidence: -0.1 }
    ]) {
      fetchFn.mockImplementation(async () => response({ answers: { route: answer } }));
      await expect(adapter(fetchFn).decide({ state: "Question", questions })).rejects.toMatchObject({ code: "decision_response_invalid" });
    }
  });

  it.each([
    {}, { unexpected: { type: "noul", noul: 0.8 } },
    { useful: { type: "noul", noul: 1.1 } }, { useful: { type: "noul", noul: -0.1 } },
    { useful: { type: "noul", noul: "0.9" } }, { useful: { type: "noul", noul: null } },
    { useful: { type: "choice", choice: "yes" } },
    { useful: { type: "noul", noul: 0.9 }, extra: { type: "noul", noul: 0.1 } }
  ])("rejects malformed/partial/extra answers as a whole but retains paid accounting (%#)", async (answers) => {
    const fetchFn = vi.fn<typeof fetch>(async () => response({ answers }));
    await expect(adapter(fetchFn).decide(request)).rejects.toMatchObject({ code: "decision_response_invalid",
      receipt: { usage: { inputTokens: 45, outputTokens: 21, costUsd: 0.00000189 } } });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it.each([
    [{ model: "typesafe/jev-1.13-20990101" }, "decision_response_model_mismatch"],
    [{ model: "typesafe/jev-1.12" }, "decision_response_model_mismatch"],
    [{ provider: "TypeSafe-external" }, "decision_response_provider_mismatch"],
    [{ usage: { input_tokens: -1, output_tokens: 1 } }, "decision_response_invalid"],
    [{ usage: { input_tokens: 1.5, output_tokens: 1 } }, "decision_response_invalid"],
    [{ usage: { input_tokens: 1, output_tokens: 1, cost: -0.01 } }, "decision_response_invalid"],
    [{ usage: {} }, "decision_response_invalid"]
  ])("rejects an unqualified served model, route or malformed usage (%#)", async (body, code) => {
    const fetchFn = vi.fn<typeof fetch>(async () => response(body as Record<string, unknown>));
    await expect(adapter(fetchFn).decide(request)).rejects.toMatchObject({ code });
  });

  it("does not invent a price when the provider omits billed cost", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => response({ usage: { input_tokens: 0, output_tokens: 0 } }));
    expect((await adapter(fetchFn).decide(request)).usage).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: null });
  });

  it("rejects invalid/oversized input before credential resolution and network dispatch", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const secret = vi.fn(async () => "secret");
    for (const invalid of [
      { ...request, questions: {} }, { ...request, questions: { useful: { type: "noul", instructions: "" } } },
      { ...request, state: { numeric: Infinity } }
    ]) await expect(adapter(fetchFn, { secret }).decide(invalid as DecisionRequest)).rejects.toMatchObject({ code: "decision_input_invalid" });
    await expect(adapter(fetchFn, { secret }).decide({ ...request, state: "я".repeat(MAX_DECISION_REQUEST_BYTES) }))
      .rejects.toMatchObject({ code: "decision_request_too_large" });
    expect(fetchFn).not.toHaveBeenCalled(); expect(secret).not.toHaveBeenCalled();
  });

  it("keeps revocation and cancellation distinct from optional provider outages", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const revoked = Object.assign(new Error("credential_revoked"), { code: "credential_revoked" });
    await expect(adapter(fetchFn, { secret: async () => { throw revoked; } }).decide(request)).rejects.toBe(revoked);
    const controller = new AbortController(); controller.abort();
    const secret = vi.fn(async () => "secret");
    await expect(adapter(fetchFn, { secret }).decide({ ...request, signal: controller.signal })).rejects.toBe(controller.signal.reason);
    expect(secret).not.toHaveBeenCalled(); expect(fetchFn).not.toHaveBeenCalled();
  });

  it("checks cancellation again after credential resolution", async () => {
    const controller = new AbortController(); const fetchFn = vi.fn<typeof fetch>();
    await expect(adapter(fetchFn, { secret: async () => { controller.abort(); return "secret"; } })
      .decide({ ...request, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("bounds responses and never repeats a possibly paid failed dispatch", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => response());
    await expect(adapter(fetchFn, { responseMaxBytes: 5 }).decide(request)).rejects.toMatchObject({ code: "decision_response_too_large" });
    fetchFn.mockClear().mockImplementation(async () => new Response("PRIVATE_ERROR_CANARY", { status: 429, headers: { "retry-after": "2" } }));
    await expect(adapter(fetchFn).decide(request)).rejects.toMatchObject({ code: "decision_provider_http_error", httpStatus: 429, retryAfterMs: 2000 });
    expect(fetchFn).toHaveBeenCalledOnce();
    fetchFn.mockClear().mockRejectedValue(new Error("PRIVATE_NETWORK_CANARY"));
    await expect(adapter(fetchFn).decide(request)).rejects.toMatchObject({ code: "decision_provider_request_failed" });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("reports a bounded deadline without a hidden second request", async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = vi.fn<typeof fetch>(async (_url, init) => new Promise((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      }));
      const failure = expect(adapter(fetchFn).decide(request)).rejects.toMatchObject({ code: "decision_request_timed_out" });
      await vi.advanceTimersByTimeAsync(5_001); await failure;
      expect(fetchFn).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it("logs safe Decisions diagnostics without content or secrets", async () => {
    const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const fetchFn = vi.fn<typeof fetch>(async () => new Response("PRIVATE_INVALID_JSON_CANARY"));
      await expect(runWithContext({ trace_id: "f".repeat(32) }, () => adapter(fetchFn).decide({ ...request,
        state: "PRIVATE_QUERY_CANARY" }))).rejects.toMatchObject({ code: "decision_response_invalid" });
      const output = writer.mock.calls.map(([chunk]) => String(chunk)).join("");
      expect(output).not.toContain("PRIVATE_");
      const records = output.trim().split("\n").map((line) => JSON.parse(line));
      expect(records).toContainEqual(expect.objectContaining({ event: "provider_operation", stage: "decisions",
        code: "decision_response_invalid", outcome: "failed" }));
    } finally { writer.mockRestore(); }
  });
});
