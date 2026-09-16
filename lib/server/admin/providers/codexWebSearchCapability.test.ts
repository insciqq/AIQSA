import { describe, expect, it, vi } from "vitest";
import type { AdminProviderTestEvidence } from "../../../contracts/adminProviders";
import { createAdminProviderDraftTester, type AdminProviderDraftTesterInput } from "./tester";
import { initiallyVerifiedModelConfiguration, reusableCapabilitySetupEvidence } from "./initialCapabilitySetup";
import { hasVerifiedCodexWebSearch } from "../../providers/codexWebSearch";

function input(): AdminProviderDraftTesterInput {
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
    connection: { apiRoot: "https://gateway.example.test/backend-api/codex", allowPrivateNetwork: false,
      authenticationMode: "bearer", responseTimeoutMs: 300000 }, connectionDisplayName: "Synthetic gateway",
    connectionId: "connection", credentialId: "credential", credentialVersionIdentity: "key-version", providerModelId: "model",
    providerFamily: "openai_compatible", initialSetup: true, reuseSetupEvidence: evidence, mode: "tiny_generation",
    modelDisplayName: "Synthetic model", secret: "synthetic-secret",
    model: { adapterKind: "openai_responses_compatible", modelClass: "answer", answerSelectable: true,
      capabilities: { nativeSearch: false, nativePdfInput: false, pdf: false, reasoning: false, vision: false },
      upstreamModelId: "synthetic-model", defaultParams: {} }
  };
}
const response = () => Response.json({ encrypted_output: "opaque", output: "OpenAI home page",
  results: [{ url: "https://openai.com/", ref_id: "source1" }] });

describe("Codex standalone search qualification", () => {
  it("probes the exact declared root and publishes Codex capability independently of AIQSA Search", async () => {
    const value = input(), fetchFn = vi.fn<typeof fetch>(async () => response());
    const tester = createAdminProviderDraftTester({ createFetch: () => fetchFn });
    const outcome = await tester.test(value);
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn.mock.calls[0]![0]).toBe(`${value.connection.apiRoot}/alpha/search`);
    expect(new Headers(fetchFn.mock.calls[0]![1]?.headers).get("authorization")).toBe("Bearer synthetic-secret");
    expect(outcome.evidence.capabilitySetup?.checks.codexWebSearch).toBe("verified");
    expect(initiallyVerifiedModelConfiguration(value.model, outcome.evidence).capabilities).toMatchObject({ codexStandaloneWebSearch: true, nativeSearch: false });
    expect(hasVerifiedCodexWebSearch(outcome.evidence, value.model)).toBe(true);
    expect(hasVerifiedCodexWebSearch(outcome.evidence, { ...value.model, upstreamModelId: "other" })).toBe(false);
    const refreshed = await tester.test({ ...value, initialSetup: false, reuseSetupEvidence: outcome.evidence });
    expect(initiallyVerifiedModelConfiguration(value.model, refreshed.evidence).capabilities.codexStandaloneWebSearch).toBeUndefined();
    expect(fetchFn).toHaveBeenCalledOnce();
  });
  it("does not guess another root, and a missing route disables only this capability", async () => {
    const value = input(), fetchFn = vi.fn<typeof fetch>(async () => Response.json({ error: "private diagnostic" }, { status: 404 }));
    const outcome = await createAdminProviderDraftTester({ createFetch: () => fetchFn }).test(value);
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(outcome.status).toBe("available");
    expect(outcome.evidence.capabilitySetup?.checks.codexWebSearch).toBe("unsupported");
    expect(JSON.stringify(outcome.evidence)).not.toContain("private diagnostic");
    expect(initiallyVerifiedModelConfiguration(value.model, outcome.evidence).capabilities.codexStandaloneWebSearch).toBe(false);
  });
  it("discarded or mismatched proof cannot be reused as verified", async () => {
    const value = input();
    const outcome = await createAdminProviderDraftTester({ createFetch: () => async () => response() }).test(value);
    const evidence = { ...outcome.evidence, codexWebSearch: { ...outcome.evidence.codexWebSearch!, upstreamModelId: "another-model" } };
    const reused = reusableCapabilitySetupEvidence(evidence, value.model, value.connection);
    expect(reused?.codexWebSearch).toBeUndefined();
    expect(reused?.capabilitySetup?.checks.codexWebSearch).toBe("not_checked");
  });
});
