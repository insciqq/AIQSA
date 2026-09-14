import { describe, expect, it, vi } from "vitest";
import type { AdminProviderTestEvidence } from "../../../contracts/adminProviders";
import { createAdminProviderDraftTester, type AdminProviderDraftTesterInput } from "./tester";
import { capabilitySetupIncomplete, initiallyVerifiedModelConfiguration, reusableCapabilitySetupEvidence } from "./initialCapabilitySetup";
import { decodeHostedSearchVerificationEvidence } from "./hostedSearchCapability";

function input(): { -readonly [Key in keyof AdminProviderDraftTesterInput]: AdminProviderDraftTesterInput[Key] } {
  const evidence: AdminProviderTestEvidence = {
    detail: "ok", method: "tiny_generation", selectedProviders: [], upstreamModelId: "synthetic-model",
    capabilitySetup: { activation: "initial", policyVersion: 2, checks: {
      modelAccess: "verified", structuredOutput: "unsupported", toolCalling: "unsupported", forcedToolCall: "unsupported",
      parallelToolCalls: "unsupported", vision: "unsupported", directPdf: "unsupported", streaming: "verified"
    } },
    compatibility: { probeVersion: 2, modelAccess: "verified", structuredOutput: "not_supported",
      directPdf: "not_supported", streaming: "verified", usage: "verified" }
  };
  return {
    connection: { apiRoot: "https://gateway.example.test/compatible", allowPrivateNetwork: false, authenticationMode: "bearer",
      responseTimeoutMs: 300_000, responsesRequestIsolation: "auto", responsesRequestIsolationDetected: true },
    connectionDisplayName: "Synthetic gateway", connectionId: "connection", credentialId: "credential",
    credentialVersionIdentity: "key-version", providerModelId: "model", providerFamily: "openai_compatible",
    initialSetup: true, reuseSetupEvidence: evidence, mode: "tiny_generation", modelDisplayName: "Synthetic model", secret: "synthetic-secret",
    model: { adapterKind: "openai_responses_compatible", modelClass: "answer", answerSelectable: true,
      capabilities: { nativeSearch: false, nativePdfInput: false, pdf: false, reasoning: false, vision: false },
      upstreamModelId: "synthetic-model", defaultParams: {} }
  };
}

function searchResponse(options: { operation?: boolean; sources?: boolean; status?: string } = {}) {
  return Response.json({ id: "synthetic-response", status: options.status ?? "completed",
    output: [
      ...(options.operation === false ? [] : [{ type: "web_search_call", id: "search", status: "completed", action: {
        type: "search", sources: options.sources === false ? [] : [{ url: "https://openai.com", title: "OpenAI" }]
      } }]),
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "The official OpenAI home page." }] }
    ], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } });
}

describe("detected codex-lb Hosted Search capability", () => {
  it.each(["bearer", "none"] as const)("probes the exact compatible route with %s authentication before enabling", async (authenticationMode) => {
    const value = input();
    if (authenticationMode === "none") {
      value.connection = { ...value.connection, allowPrivateNetwork: true, authenticationMode, apiRoot: "http://127.0.0.1:2455/compatible" };
      value.secret = null;
    }
    const fetchFn = vi.fn<typeof fetch>(async () => searchResponse());
    const tester = createAdminProviderDraftTester({ createFetch: () => fetchFn, retrySleep: async () => {} });
    expect(value.model.capabilities.nativeSearch).toBe(false);
    const result = await tester.test(value);
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe(`${value.connection.apiRoot}/responses`);
    expect(new Headers(init?.headers).get("authorization")).toBe(authenticationMode === "none" ? null : "Bearer synthetic-secret");
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ model: "synthetic-model", include: ["web_search_call.action.sources"],
      tool_choice: "required", tools: [{ type: "web_search" }], stream: false, store: false, max_output_tokens: 2_048 });
    expect(body).not.toHaveProperty("background");
    expect(result.evidence.hostedSearch).toEqual({ adapterKind: "openai_responses_compatible", normalizedSourceCount: 1,
      probeVersion: 1, upstreamModelId: "synthetic-model", verified: true });
    expect(result.evidence.capabilitySetup?.checks.hostedSearch).toBe("verified");
    expect(initiallyVerifiedModelConfiguration(value.model, result.evidence).capabilities.nativeSearch).toBe(true);
    expect(capabilitySetupIncomplete(result.evidence)).toBe(false);
  });

  it.each([undefined, false])("does not infer Search from an isolation override or gateway-like name (detected=%s)", async (detected) => {
    const value = input();
    value.connection = { ...value.connection, responsesRequestIsolation: "on", responsesRequestIsolationDetected: detected };
    value.connectionDisplayName = "codex-lb";
    const fetchFn = vi.fn<typeof fetch>();
    const result = await createAdminProviderDraftTester({ createFetch: () => fetchFn }).test(value);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(result.evidence.hostedSearch).toBeUndefined();
    expect(result.evidence.capabilitySetup?.checks.hostedSearch).toBeUndefined();
  });

  it("keeps detection independent from an explicit isolation disable", async () => {
    const value = input();
    value.connection = { ...value.connection, responsesRequestIsolation: "off" };
    const fetchFn = vi.fn<typeof fetch>(async () => searchResponse());
    const result = await createAdminProviderDraftTester({ createFetch: () => fetchFn }).test(value);
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetchFn.mock.calls[0]![1]?.body))).not.toHaveProperty("prompt_cache_key");
    expect(result.evidence.capabilitySetup?.checks.hostedSearch).toBe("verified");
  });

  it("does not probe a detected gateway through Chat Completions", async () => {
    const value = input();
    value.model = { ...value.model, adapterKind: "openai_chat_completions_compatible" };
    const fetchFn = vi.fn<typeof fetch>();
    const result = await createAdminProviderDraftTester({ createFetch: () => fetchFn }).test(value);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(result.evidence.hostedSearch).toBeUndefined();
  });

  it.each([{ operation: false }, { sources: false }, { status: "incomplete" }])("requires a completed search with usable sources (%j)", async (options) => {
    const value = input();
    const fetchFn = vi.fn<typeof fetch>(async () => searchResponse(options));
    const result = await createAdminProviderDraftTester({ createFetch: () => fetchFn, retrySleep: async () => {} }).test(value);
    expect(result.status).toBe("available");
    expect(result.evidence.hostedSearch).toBeUndefined();
    expect(result.evidence.capabilitySetup?.checks.hostedSearch).toBe("incomplete");
    expect(initiallyVerifiedModelConfiguration(value.model, result.evidence).capabilities.nativeSearch).toBe(false);
  });

  it.each([{ status: 401, reason: "authorization", attempts: 1 }, { status: 503, reason: "http_error", attempts: 3 }])(
    "preserves ordinary model access when Search fails with HTTP $status", async ({ status, reason, attempts }) => {
      const value = input();
      const fetchFn = vi.fn<typeof fetch>(async () => Response.json({ error: { message: "synthetic private upstream failure" } }, { status }));
      const result = await createAdminProviderDraftTester({ createFetch: () => fetchFn, retrySleep: async () => {} }).test(value);
      expect(fetchFn).toHaveBeenCalledTimes(attempts);
      expect(result.status).toBe("available");
      expect(result.evidence.capabilitySetup?.attempts?.hostedSearch).toEqual({ attempts, reason, status: "incomplete", httpStatus: status });
      expect(JSON.stringify(result.evidence)).not.toContain("synthetic private upstream failure");
      expect(initiallyVerifiedModelConfiguration(value.model, result.evidence).capabilities.nativeSearch).toBe(false);
    }
  );

  it("reuses successful exact-current proofs and preserves a later admin disable", async () => {
    const value = input();
    const fetchFn = vi.fn<typeof fetch>(async () => searchResponse());
    const tester = createAdminProviderDraftTester({ createFetch: () => fetchFn });
    const initial = await tester.test(value);
    const refreshed = await tester.test({ ...value, initialSetup: false, reuseSetupEvidence: initial.evidence });
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(refreshed.evidence.hostedSearch).toEqual(initial.evidence.hostedSearch);
    expect(initiallyVerifiedModelConfiguration(value.model, refreshed.evidence).capabilities.nativeSearch).toBe(false);
  });

  it("adds the newly implemented probe to old settled setup receipts without repeating other capabilities", () => {
    const value = input();
    expect(capabilitySetupIncomplete(value.reuseSetupEvidence!)).toBe(false);
    const reused = reusableCapabilitySetupEvidence(value.reuseSetupEvidence, value.model, value.connection)!;
    expect(reused.capabilitySetup?.checks.hostedSearch).toBe("not_checked");
    expect(reused.capabilitySetup?.checks.streaming).toBe("verified");
    expect(capabilitySetupIncomplete(reused)).toBe(true);
  });

  it("invalidates wrong-model and malformed Search proofs before reuse or activation", async () => {
    const value = input();
    const tester = createAdminProviderDraftTester({ createFetch: () => async () => searchResponse() });
    const result = await tester.test(value);
    for (const patch of [{ upstreamModelId: "another-model" }, { normalizedSourceCount: 0 }, { adapterKind: "openai_responses_native" }]) {
      const invalid = { ...result.evidence, hostedSearch: { ...result.evidence.hostedSearch!, ...patch } } as AdminProviderTestEvidence;
      const reused = reusableCapabilitySetupEvidence(invalid, value.model, value.connection)!;
      expect(reused.hostedSearch).toBeUndefined();
      expect(reused.capabilitySetup?.checks.hostedSearch).toBe("not_checked");
      expect(initiallyVerifiedModelConfiguration(value.model, invalid).capabilities.nativeSearch).toBe(false);
    }
    expect(decodeHostedSearchVerificationEvidence({ ...result.evidence.hostedSearch, normalizedSourceCount: 21 })).toBeNull();
  });
});
