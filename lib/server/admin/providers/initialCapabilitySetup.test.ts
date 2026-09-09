import { afterEach, describe, expect, it, vi } from "vitest";
import * as runtime from "../../providers/runtimeFactory";
import * as vision from "../../providers/visionInputProbe";
import { fakeProviderToolBridge } from "../../tools/bridges";
import { createAdminProviderDraftTester, type AdminProviderDraftTesterInput } from "./tester";
import { capabilitySetupIncomplete, initiallyVerifiedModelConfiguration, reusableCapabilitySetupEvidence } from "./initialCapabilitySetup";
import { supportsStructuredOutputAdapter } from "../../providers/structuredOutput";
import { pdfInputVerificationEvidence, supportsPdfInputAdapter } from "../../providers/pdfInputEvidence";

afterEach(() => vi.restoreAllMocks());

function fixture(adapterKind: AdminProviderDraftTesterInput["model"]["adapterKind"] = "openai_responses_compatible") {
  const input: AdminProviderDraftTesterInput = {
    connection: { allowPrivateNetwork: false, apiRoot: "https://provider.example.test/v1", authenticationMode: "bearer", responseTimeoutMs: 300_000 },
    connectionDisplayName: "Synthetic", connectionId: "connection", credentialId: "credential", credentialVersionIdentity: "key-version",
    initialSetup: true, mode: "tiny_generation", modelDisplayName: "Synthetic", providerFamily: "openai_compatible",
    providerModelId: "model", secret: "synthetic-secret", model: {
      adapterKind, answerSelectable: true, modelClass: "answer", upstreamModelId: "synthetic",
      capabilities: { nativePdfInput: false, nativeSearch: false, parallelToolCalls: false,
        pdf: true, reasoning: false, streaming: false, toolCalling: false, vision: false }, defaultParams: {}
    }
  };
  let failingJson = false;
  let parallelCount = 2;
  const calls: string[] = [];
  vi.spyOn(vision, "createProviderVisionInputProbe").mockReturnValue({ async probe() { calls.push("vision"); return true; } });
  vi.spyOn(runtime, "createProviderRuntimeBinding").mockImplementation((): runtime.ProviderRuntimeBinding => ({
    adapter: { buildRequestPreview() { return {}; }, async *stream(request) {
      const tool = request.tools?.[0]?.name;
      calls.push(tool ?? (request.forceNonStreaming ? "access" : "streaming"));
      const toolCalls = tool === "aiqsa_parallel_probe"
        ? ["Oslo", "Rome"].slice(0, parallelCount).map((city, index) => ({ id: `call-${index}`, name: tool, arguments: { city } }))
        : tool ? [{ id: "call-0", name: tool,
          arguments: tool === "aiqsa_forced_tool_call_probe" ? { nonce: "aiqsa-control-ready" } : { city: "Oslo" } }] : [];
      yield { type: "usage", data: { inputTokens: 2, outputTokens: 1, reasoningTokens: 0, totalTokens: 3 } };
      return { finalText: "OK", finalProviderResponsePreview: {}, providerResponseId: "synthetic-response",
        usage: { inputTokens: 2, outputTokens: 1, reasoningTokens: 0, totalTokens: 3 }, toolCalls };
    } }, toolBridge: fakeProviderToolBridge,
    responseTimeoutMs: input.connection.responseTimeoutMs,
    structuredOutputAdapter: { async execute() {
      calls.push("json");
      if (failingJson) throw new Error("structured_output_provider_incomplete");
      return { ready: true, count: 2, label: "OK", tool_ids: ["alpha", "beta"] };
    } }
  }));
  const tester = createAdminProviderDraftTester({ retrySleep: async () => {}, pdfInputProbe: { async probe() {
    calls.push("pdf");
    return pdfInputVerificationEvidence(adapterKind, "synthetic");
  } } });
  return { calls, input, tester, failJson: () => { failingJson = true; }, fixJson: () => { failingJson = false; },
    singleParallel: () => { parallelCount = 1; } };
}

describe("universal initial capability setup", () => {
  it.each(["anthropic_messages", "deepseek_responses_native", "gemini_interactions_native",
    "openai_chat_completions_compatible", "openai_responses_compatible", "openai_responses_native", "openrouter_chat_completions"] as const)(
    "checks all implemented %s capabilities from disabled defaults and enables only proofs", async (adapter) => {
      const f = fixture(adapter);
      const result = await f.tester.test(f.input);
      expect(result.status).toBe("available");
      expect(result.evidence.capabilitySetup?.checks).toMatchObject({ modelAccess: "verified", toolCalling: "verified",
        forcedToolCall: "verified", parallelToolCalls: "verified", vision: "verified", streaming: "verified",
        structuredOutput: supportsStructuredOutputAdapter(adapter) ? "verified" : "unsupported",
        directPdf: supportsPdfInputAdapter(adapter) ? "verified" : "unsupported" });
      expect(initiallyVerifiedModelConfiguration(f.input.model, result.evidence).capabilities).toMatchObject({
        toolCalling: true, parallelToolCalls: true, vision: true, streaming: true,
        nativePdfInput: supportsPdfInputAdapter(adapter)
      });
      expect(f.input.model.capabilities.vision).toBe(false);
      expect(capabilitySetupIncomplete(result.evidence)).toBe(false);
    });

  it("keeps paid successes on partial failure and retries only unresolved JSON with current evidence", async () => {
    const f = fixture();
    f.failJson();
    const partial = await f.tester.test(f.input);
    expect(partial.status).toBe("available");
    expect(partial.evidence.capabilitySetup?.checks.structuredOutput).toBe("incomplete");
    expect(partial.evidence.forcedToolCall?.verified).toBe(true);
    expect(f.calls.filter((name) => name === "json")).toHaveLength(3);
    expect(capabilitySetupIncomplete(partial.evidence)).toBe(true);
    f.fixJson();
    f.calls.length = 0;
    const final = await f.tester.test({ ...f.input, reuseSetupEvidence: partial.evidence });
    expect(f.calls).toEqual(["json"]);
    expect(capabilitySetupIncomplete(final.evidence)).toBe(false);
    expect(reusableCapabilitySetupEvidence(final.evidence, { ...f.input.model, upstreamModelId: "changed" })).toBeUndefined();
  });

  it("requires two independently addressed calls in one response for parallel proof", async () => {
    const f = fixture();
    f.singleParallel();
    const result = await f.tester.test(f.input);
    expect(result.evidence.capabilitySetup?.checks.parallelToolCalls).toBe("rejected");
    expect(result.evidence.parallelToolCalls).toBeUndefined();
    expect(initiallyVerifiedModelConfiguration(f.input.model, result.evidence).capabilities.parallelToolCalls).toBe(false);
    expect(result.evidence.forcedToolCall?.verified).toBe(true);
  });

  it("stops dispatch after cancellation even if the last provider result arrives late", async () => {
    const f = fixture();
    const controller = new AbortController();
    await expect(f.tester.test({ ...f.input, signal: controller.signal,
      onCapabilityProgress: (progress) => { if (progress.capability === "structuredOutput" && progress.completed === 2) controller.abort(); }
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(f.calls).toEqual(["access", "json"]);
  });
});
