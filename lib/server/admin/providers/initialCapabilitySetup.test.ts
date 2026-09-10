import { afterEach, describe, expect, it, vi } from "vitest";
import * as runtime from "../../providers/runtimeFactory";
import * as vision from "../../providers/visionInputProbe";
import { fakeProviderToolBridge } from "../../tools/bridges";
import { createAdminProviderDraftTester, type AdminProviderDraftTesterInput } from "./tester";
import { capabilitySetupIncomplete, decodeCapabilitySetupEvidence, initiallyVerifiedModelConfiguration, reusableCapabilitySetupEvidence } from "./initialCapabilitySetup";
import { supportsStructuredOutputAdapter } from "../../providers/structuredOutput";
import { pdfInputVerificationEvidence, supportsPdfInputAdapter } from "../../providers/pdfInputEvidence";
import { createGeminiInteractionsAdapter } from "../../providers/geminiInteractions";
import { createFetchGeminiInteractionsClient } from "../../providers/geminiInteractionsTransport";
import { capabilityAttemptDescription } from "../../../../components/admin/providers/add/AdminProviderSetupResults";
import { fixtureCheck, fixtureConnection, fixtureCredential, fixtureModel } from "../../../../components/admin/providers/providerFixtures";
import { createAdminProviderService } from "./service";
import { adminProviderModelConfiguration } from "./adminConfiguration";
import type { AdminProviderRepository } from "./repositoryContract";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

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
  let jsonWait: Promise<void> | null = null;
  let forcedError: Error | null = null;
  let parallelFetch: typeof fetch | null = null;
  const calls: string[] = [];
  vi.spyOn(vision, "createProviderVisionInputProbe").mockReturnValue({ async probe() { calls.push("vision"); return true; } });
  vi.spyOn(runtime, "createProviderRuntimeBinding").mockImplementation((): runtime.ProviderRuntimeBinding => ({
    adapter: { buildRequestPreview() { return {}; }, async *stream(request, execution) {
      const tool = request.tools?.[0]?.name;
      calls.push(tool ?? (request.forceNonStreaming ? "access" : "streaming"));
      if (tool === "aiqsa_parallel_probe" && parallelFetch) {
        return yield* createGeminiInteractionsAdapter({ client: createFetchGeminiInteractionsClient({
          apiKey: "synthetic-key", fetchFn: parallelFetch
        }) }).stream(request, execution);
      }
      if (tool === "aiqsa_forced_tool_call_probe" && forcedError) throw forcedError;
      const toolCalls = tool === "aiqsa_parallel_probe"
        ? ["Oslo", "Rome"].slice(0, parallelCount).map((city, index) => ({ id: `call-${index}`, name: tool, arguments: { city } }))
        : tool ? [{ id: "call-0", name: tool,
          arguments: { city: "Oslo" } }] : [];
      yield { type: "usage", data: { inputTokens: 2, outputTokens: 1, reasoningTokens: 0, totalTokens: 3 } };
      return { finalText: "OK", finalProviderResponsePreview: {}, providerResponseId: "synthetic-response",
        usage: { inputTokens: 2, outputTokens: 1, reasoningTokens: 0, totalTokens: 3 }, toolCalls };
    } }, toolBridge: fakeProviderToolBridge,
    responseTimeoutMs: input.connection.responseTimeoutMs,
    structuredOutputAdapter: { async execute() {
      calls.push("json");
      if (jsonWait) await jsonWait;
      if (failingJson) throw new Error("structured_output_provider_incomplete");
      return { ready: true, count: 2, label: "OK", tool_ids: ["alpha", "beta"] };
    } }
  }));
  const tester = createAdminProviderDraftTester({ retrySleep: async () => {}, pdfInputProbe: { async probe() {
    calls.push("pdf");
    return pdfInputVerificationEvidence(adapterKind, "synthetic");
  } } });
  return { calls, input, tester, failJson: () => { failingJson = true; }, fixJson: () => { failingJson = false; },
    holdJson: (wait: Promise<void>) => { jsonWait = wait; }, failForced: (error: Error) => { forcedError = error; },
    setParallelFetch: (fetchFn: typeof fetch) => { parallelFetch = fetchFn; },
    singleParallel: () => { parallelCount = 1; } };
}

describe("universal initial capability setup", () => {
  it.each(["malformed_tool_call", "malformed_function_call"] as const)("retries Gemini %s through the native transport and keeps the other seven proofs", async (code) => {
    const f = fixture("gemini_interactions_native");
    let fail = true;
    const fetchFn = vi.fn<typeof fetch>(async () => fail
      ? Response.json({ error: { code, message: "synthetic private error text" } }, { status: 400 })
      : Response.json({ id: "parallel-response", status: "completed", steps: ["Oslo", "Rome"].map((city, index) => ({
        type: "function_call", id: `parallel-${index}`, name: "aiqsa_parallel_probe", arguments: { city }
      })) }));
    f.setParallelFetch(fetchFn);
    const prior = await f.tester.test(f.input);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(prior.evidence.capabilitySetup?.attempts?.parallelToolCalls).toEqual({
      attempts: 2, status: "incomplete", reason: "malformed_tool_output", httpStatus: 400
    });
    expect(capabilityAttemptDescription(prior.evidence.capabilitySetup?.attempts?.parallelToolCalls))
      .toBe("the model returned an invalid tool call · HTTP 400 · 2 attempts");
    expect(Object.values(prior.evidence.capabilitySetup!.checks).filter((status) => status === "verified")).toHaveLength(7);
    expect(JSON.stringify(prior)).not.toContain("synthetic private error text");
    expect(prior.evidence.parallelToolCalls).toBeUndefined();

    f.calls.length = 0;
    fetchFn.mockClear();
    fetchFn.mockImplementationOnce(async () => Response.json({ error: { code, message: "synthetic private error text" } }, { status: 400 }));
    fail = false;
    const result = await f.tester.test({ ...f.input, reuseSetupEvidence: prior.evidence });
    expect(f.calls).toEqual(["aiqsa_parallel_probe", "aiqsa_parallel_probe"]);
    expect(result.evidence.capabilitySetup?.attempts?.parallelToolCalls).toEqual({ attempts: 2, status: "verified", reason: "verified" });
    expect(capabilitySetupIncomplete(result.evidence)).toBe(false);
    expect(initiallyVerifiedModelConfiguration(f.input.model, result.evidence).capabilities.parallelToolCalls).toBe(true);
    for (const key of ["structuredOutput", "forcedToolCall", "visionInput", "pdfInput"] as const) {
      expect(result.evidence[key]).toEqual(prior.evidence[key]);
    }
  });

  it.each(["invalid_request", "parameter_unknown", "private-unknown"])("does not retry Gemini input rejection %s as malformed generation", async (code) => {
    const f = fixture("gemini_interactions_native");
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json({ error: { code } }, { status: 400 }));
    f.setParallelFetch(fetchFn);
    const result = await f.tester.test(f.input);
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(result.evidence.capabilitySetup?.attempts?.parallelToolCalls).toEqual({ attempts: 1,
      status: "incomplete", reason: "invalid_input", httpStatus: 400 });
  });

  it.each([true, false])("continues only unresolved Gemini parallel calls through retryUnresolved (success=%s)", async (success) => {
    const f = fixture("gemini_interactions_native");
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json({ error: {
      code: "malformed_tool_call", message: "synthetic private error text"
    } }, { status: 400 }));
    f.setParallelFetch(fetchFn);
    const prior = await f.tester.test(f.input);
    const configuration = initiallyVerifiedModelConfiguration(f.input.model, prior.evidence);
    const publicConfiguration = adminProviderModelConfiguration(configuration);
    const credential = fixtureCredential({ id: "credential", label: "Synthetic" });
    const connection = fixtureConnection({ id: "connection", displayName: "Synthetic", family: "gemini",
      credentials: [credential], defaultCredentialId: credential.id,
      models: [fixtureModel({ id: "model", connectionId: "connection", displayName: "Synthetic",
        activeConfig: publicConfiguration, draftConfig: publicConfiguration })],
      activeChecks: [fixtureCheck({ credentialId: credential.id, providerModelId: "model", evidence: prior.evidence })]
    });
    const store = vi.fn<AdminProviderRepository["storeActiveRefreshCas"]>(async () => "stored");
    const repository = {
      listConnections: async () => [connection],
      loadActiveRefreshCandidate: async () => ({
        connection: { id: connection.id, family: "gemini", displayName: "Synthetic", version: 1, configuration: f.input.connection },
        credential: { id: credential.id, versionId: credential.activeVersion!.id, envelope: "unused-synthetic-envelope" },
        model: { id: "model", displayName: "Synthetic", version: 1, draftVersion: 1, configuration }
      }),
      storeActiveRefreshCas: store,
      recordActiveRefreshFailureCas: vi.fn(async () => "stored")
    } as unknown as AdminProviderRepository;
    const credentialTest = vi.fn(async () => { throw new Error("unexpected_credential_test"); });
    const service = createAdminProviderService({ repository, tester: f.tester,
      credentialTester: { test: credentialTest }, encryptionKey: () => Buffer.alloc(32, 7) });
    f.calls.length = 0;
    if (success) fetchFn.mockImplementation(async () => Response.json({ id: "parallel-response", status: "completed",
      steps: ["Oslo", "Rome"].map((city, index) => ({ type: "function_call", id: `parallel-${index}`,
        name: "aiqsa_parallel_probe", arguments: { city } })) }));
    const run = await service.startCheckRun({ connectionId: connection.id, credentialId: credential.id,
      modelIds: ["model"], reason: "requested", retryUnresolved: true });
    await vi.waitFor(() => expect(service.checkRun({ connectionId: connection.id, runId: run.id }).state).toBe("completed"));
    expect(f.calls).toEqual(Array(success ? 1 : 2).fill("aiqsa_parallel_probe"));
    expect(store).toHaveBeenCalledOnce();
    const evidence = store.mock.calls[0]![0].evidence;
    expect(capabilitySetupIncomplete(evidence)).toBe(!success);
    for (const key of ["structuredOutput", "forcedToolCall", "visionInput", "pdfInput"] as const) {
      expect(evidence[key]).toEqual(prior.evidence[key]);
    }
    expect(Object.values(evidence.capabilitySetup!.checks).filter((status) => status === "verified")).toHaveLength(success ? 8 : 7);
    expect(repository.recordActiveRefreshFailureCas).not.toHaveBeenCalled();
    expect(credentialTest).not.toHaveBeenCalled();
  });

  it("fences Gemini retry and checkpoint writes when cancelled during the malformed response", async () => {
    const f = fixture("gemini_interactions_native");
    const controller = new AbortController();
    const checkpoint = vi.fn();
    const fetchFn = vi.fn<typeof fetch>(async () => {
      controller.abort();
      return Response.json({ error: { code: "malformed_tool_call" } }, { status: 400 });
    });
    f.setParallelFetch(fetchFn);
    await expect(f.tester.test({ ...f.input, signal: controller.signal, onSetupCheckpoint: checkpoint }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(checkpoint).toHaveBeenCalledTimes(4);
    await Promise.resolve();
    expect(checkpoint).toHaveBeenCalledTimes(4);
    expect(f.calls).not.toContain("vision");
  });

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
    expect(f.calls.filter((name) => name === "json")).toHaveLength(2);
    expect(partial.evidence.capabilitySetup?.attempts?.structuredOutput).toMatchObject({ attempts: 2, status: "incomplete", reason: "semantic_inconclusive" });
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
    expect(result.evidence.capabilitySetup?.checks.parallelToolCalls).toBe("incomplete");
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

  it("drops one invalid proof without discarding independent exact-model evidence", async () => {
    const f = fixture();
    const result = await f.tester.test(f.input);
    result.evidence.forcedToolCall = { ...result.evidence.forcedToolCall!, upstreamModelId: "other-model" };
    const reusable = reusableCapabilitySetupEvidence(result.evidence, f.input.model);
    expect(reusable?.capabilitySetup?.checks).toMatchObject({ forcedToolCall: "not_checked", vision: "verified", streaming: "verified" });
    expect(reusable?.forcedToolCall).toBeUndefined();
    expect(reusable?.visionInput).toEqual(result.evidence.visionInput);
  });

  it("never treats refresh evidence as permission to enable administrator-disabled capabilities", async () => {
    const f = fixture();
    const result = await f.tester.test(f.input);
    result.evidence.capabilitySetup!.activation = "preserve";
    expect(initiallyVerifiedModelConfiguration(f.input.model, result.evidence)).toEqual(f.input.model);
  });

  it("accepts bounded attempt receipts and rejects raw diagnostics or unbounded counts", () => {
    const setup = { policyVersion: 2, activation: "preserve", checks: { vision: "incomplete" },
      attempts: { vision: { attempts: 2, status: "incomplete", reason: "invalid_input", httpStatus: 400 } } };
    expect(decodeCapabilitySetupEvidence(setup)).toEqual(setup);
    for (const attempt of [{ ...setup.attempts.vision, body: "private" }, { ...setup.attempts.vision, attempts: 4 },
      { ...setup.attempts.vision, reason: "raw-error-text" }, { ...setup.attempts.vision, httpStatus: 999 }]) {
      expect(decodeCapabilitySetupEvidence({ ...setup, attempts: { vision: attempt } })).toBeNull();
    }
  });

  it.each([true, false])("gives later capabilities a fresh deadline and ignores a late JSON result (initial=%s)", async (initialSetup) => {
    vi.useFakeTimers();
    const f = fixture();
    let resolveJson!: () => void;
    f.holdJson(new Promise<void>((resolve) => { resolveJson = resolve; }));
    const checkpoints: unknown[] = [];
    const pending = f.tester.test({ ...f.input, initialSetup, connection: { ...f.input.connection, responseTimeoutMs: 10 },
      onSetupCheckpoint: async (value) => { checkpoints.push(value); } });
    await vi.advanceTimersByTimeAsync(11);
    const outcome = await pending;
    expect(outcome.evidence.capabilitySetup?.attempts?.structuredOutput).toMatchObject({ reason: "timeout", attempts: 1 });
    expect(outcome.evidence.capabilitySetup?.checks).toMatchObject({ modelAccess: "verified", structuredOutput: "incomplete", vision: "verified", streaming: "verified" });
    expect(checkpoints).toHaveLength(8);
    const saved = JSON.stringify(checkpoints);
    resolveJson();
    await vi.advanceTimersByTimeAsync(1);
    expect(JSON.stringify(checkpoints)).toBe(saved);
    expect(outcome.evidence.structuredOutput).toBeUndefined();
  });

  it("keeps an exact-current positive proof alongside its inconclusive refresh without re-enabling a disabled feature", async () => {
    const f = fixture();
    const prior = await f.tester.test(f.input);
    f.failJson();
    const refreshed = await f.tester.test({ ...f.input, initialSetup: false, priorEvidence: prior.evidence });
    expect(refreshed.evidence.structuredOutput).toEqual(prior.evidence.structuredOutput);
    expect(refreshed.evidence.capabilitySetup?.checks.structuredOutput).toBe("verified");
    expect(refreshed.evidence.capabilitySetup?.attempts?.structuredOutput?.status).toBe("incomplete");
    expect(initiallyVerifiedModelConfiguration(f.input.model, refreshed.evidence)).toEqual(f.input.model);
  });

  it("settles a capability-only OpenRouter 404 and retries no proved or unsupported capabilities", async () => {
    const f = fixture("openrouter_chat_completions");
    f.failForced(new Error("OpenRouter request failed with status 404"));
    const prior = await f.tester.test(f.input);
    expect(prior.evidence.capabilitySetup?.attempts?.forcedToolCall).toEqual({ attempts: 1, status: "unsupported", reason: "route_unsupported", httpStatus: 404 });
    expect(prior.evidence.capabilitySetup?.checks).toMatchObject({ modelAccess: "verified", toolCalling: "verified", forcedToolCall: "unsupported", streaming: "verified" });
    expect(capabilitySetupIncomplete(prior.evidence)).toBe(false);
    f.calls.length = 0;
    await f.tester.test({ ...f.input, initialSetup: false, reuseSetupEvidence: prior.evidence });
    expect(f.calls).toEqual([]);
  });
});
