import { describe, expect, it, vi } from "vitest";
import { jevModelConfiguration, JEV_SERVED_MODEL_ID } from "../../../domain/decisionModels";
import { ProviderAdmissionError } from "../../providerRuntime/admission";
import type { DecisionModelRoleResolution } from "../../providerRuntime/decisionModelRole";
import type { createAcceptedDecisionRuntime } from "../../providerRuntime/decisionRuntime";
import { DecisionAdapterError, type DecisionResult } from "../../providers/decisions";
import type { ProviderExecutionSnapshot } from "../../providers/runtimeFactory";
import { MemoryExecutionError, type PrismaMemoryExecutionService } from "../execution";
import { createMemoryHistoryRelevanceService } from "./historyRelevanceRuntime";
import { MEMORY_HISTORY_RELEVANCE_QUESTION } from "./historyRelevancePolicy";

function fixture() {
  const snapshot: ProviderExecutionSnapshot = {
    version: 1, connectionId: "connection", credentialId: "credential", credentialVersionId: "credential-version",
    connectionDisplayName: "Decision provider", modelDisplayName: "Decision model", providerModelId: "model", providerFamily: "openrouter",
    connection: { apiRoot: "https://provider.example.test/v1", authenticationMode: "bearer", allowPrivateNetwork: false, responseTimeoutMs: 30_000 },
    model: jevModelConfiguration(),
    decisionVerification: { probeVersion: 1, adapterKind: "openrouter_decisions", upstreamModelId: "typesafe/jev-1.13",
      servedModelId: JEV_SERVED_MODEL_ID, provider: "TypeSafe", noul: true, choice: true }
  };
  const resolution = { ok: true, credentialScope: "installation", policyVersion: 3, providerModelId: "model",
    role: { snapshot } } as Extract<DecisionModelRoleResolution, { ok: true }>;
  const resolveRole = vi.fn(async (): Promise<DecisionModelRoleResolution> => resolution);
  const output: DecisionResult = { model: JEV_SERVED_MODEL_ID, provider: "TypeSafe", requestId: "request-1",
    usage: { inputTokens: 80, outputTokens: 21, costUsd: 0.00000042 }, answers: { useful: { type: "noul", noul: 0.02 } } };
  const decide = vi.fn(async () => output);
  const resolve = vi.fn(async () => ({ adapter: { decide } }));
  const states = new Map<string, string>();
  const bind = vi.fn(async (_userId: string, input: { ordinal: number }) => {
    const id = `binding-${input.ordinal}`;
    if (!states.has(id)) states.set(id, "PENDING");
    return { id, state: states.get(id) };
  });
  const admitted = { logicalRole: "MEMORY_HISTORY_RELEVANCE", providerExecutionSnapshot: snapshot };
  const start = vi.fn(async (_userId: string, id: string) => {
    if (states.get(id) !== "PENDING") throw new MemoryExecutionError("memory_execution_state_conflict");
    states.set(id, "RUNNING");
    return { snapshot: admitted };
  });
  const settle = vi.fn(async (_userId: string, id: string, input: { state: string }) => { states.set(id, input.state); });
  const recoverOutcome = vi.fn(async (_userId: string, id: string, input: { state: string }) => { states.set(id, input.state); });
  const withAuthorizedResultCommit = vi.fn(async () => true);
  let clock = 1_000;
  const service = createMemoryHistoryRelevanceService({
    resolveRole, runtime: { resolve } as unknown as ReturnType<typeof createAcceptedDecisionRuntime>,
    execution: { admission: { bind, start }, lifecycle: { settle, recoverOutcome, withAuthorizedResultCommit } } as unknown as PrismaMemoryExecutionService,
    clock: () => clock
  });
  const controller = new AbortController();
  const input = { userId: "user", attemptId: "attempt", query: "Current question", signal: controller.signal,
    passages: [{ handle: "h1", text: "Synthetic history passage" }] };
  return { service, input, controller, snapshot, resolution, resolveRole, decide, output, resolve, bind, start,
    settle, recoverOutcome, withAuthorizedResultCommit, states, admitted, advance: (ms: number) => { clock += ms; } };
}

describe("optional Memory history decisions", () => {
  it.each(["decision_model_absent", "decision_feature_disabled", "decision_model_unavailable"] as const)
  ("preserves the baseline without disclosure for %s", async code => {
    const f = fixture(); f.resolveRole.mockResolvedValue({ ok: false, code, selectedProviderModelId: null });
    expect(await f.service(f.input)).toMatchObject({ status: code === "decision_model_unavailable" ? "UNAVAILABLE" : "SKIPPED",
      reason: code, scores: [], diagnostics: { externalCallCount: 0, bindingCount: 0 } });
    expect(f.bind).not.toHaveBeenCalled(); expect(f.decide).not.toHaveBeenCalled();
  });

  it("does not transfer a calibration to another served revision", async () => {
    const f = fixture();
    f.resolveRole.mockResolvedValue({ ...f.resolution, role: { ...f.resolution.role,
      snapshot: { ...f.snapshot, decisionVerification: { ...f.snapshot.decisionVerification!, servedModelId: "typesafe/jev-future" } } } });
    expect(await f.service(f.input)).toMatchObject({ status: "SKIPPED", reason: "memory_history_relevance_unqualified" });
    expect(f.bind).not.toHaveBeenCalled();
  });

  it("uses exact owner bindings and one language-neutral rubric, retaining reported cost", async () => {
    const f = fixture();
    const result = await f.service({ ...f.input, query: "Вопрос / question", passages: [{ handle: "h1", text: "Цитата / excerpt" }] });
    expect(f.bind).toHaveBeenCalledWith("user", expect.objectContaining({
      ordinal: 1, role: "MEMORY_HISTORY_RELEVANCE", owner: { type: "RETRIEVAL_ATTEMPT", retrievalAttemptId: "attempt" }
    }));
    expect(f.decide).toHaveBeenCalledExactlyOnceWith({ state: { query: "Вопрос / question", memory: "Цитата / excerpt" },
      questions: { useful: MEMORY_HISTORY_RELEVANCE_QUESTION }, signal: f.input.signal });
    expect(result).toMatchObject({ status: "READY", scores: [{ handle: "h1", usefulness: 0.02 }],
      diagnostics: { bindingCount: 1, externalCallCount: 1, inputTokens: 80, outputTokens: 21, knownReportedCostUsd: 0.00000042, unknownCostCallCount: 0 } });
    expect(f.settle).toHaveBeenCalledWith("user", "binding-1", expect.objectContaining({ state: "SUCCEEDED",
      usage: expect.objectContaining({ inputTokens: 80, outputTokens: 21, estimatedCostMicros: 0 }) }));
    expect(f.withAuthorizedResultCommit).toHaveBeenCalledOnce();
    expect(JSON.stringify(result.diagnostics)).not.toContain("Цитата");
  });

  it.each(["SUCCEEDED", "RUNNING", "OUTCOME_UNKNOWN"])("does not replay %s work", async state => {
    const f = fixture(); f.states.set("binding-1", state);
    expect(await f.service(f.input)).toMatchObject({ status: "UNAVAILABLE", reason: "memory_history_relevance_already_attempted" });
    expect(f.start).not.toHaveBeenCalled(); expect(f.decide).not.toHaveBeenCalled(); expect(f.settle).not.toHaveBeenCalled();
  });

  it("does not settle a competing start or dispatch with a changed accepted route", async () => {
    const f = fixture(); f.start.mockRejectedValueOnce(new MemoryExecutionError("memory_execution_state_conflict"));
    await f.service(f.input);
    expect(f.settle).not.toHaveBeenCalled(); expect(f.decide).not.toHaveBeenCalled();
    f.admitted.providerExecutionSnapshot = { ...f.snapshot, credentialVersionId: "replacement" };
    expect(await f.service(f.input)).toMatchObject({ status: "UNAVAILABLE", reason: "memory_execution_policy_drift" });
    expect(f.settle).toHaveBeenCalledWith("user", "binding-1", expect.objectContaining({ state: "FAILED" }));
    expect(f.decide).not.toHaveBeenCalled();
  });

  it("retains receipt accounting after unusable coverage and discards every partial score", async () => {
    const f = fixture();
    f.decide.mockResolvedValueOnce(f.output).mockRejectedValueOnce(new DecisionAdapterError("decision_response_invalid", { receipt: f.output }));
    const result = await f.service({ ...f.input, passages: [...f.input.passages, { handle: "h2", text: "Another excerpt" }] });
    expect(result).toMatchObject({ status: "UNAVAILABLE", scores: [], diagnostics: {
      externalCallCount: 2, completedCallCount: 2, inputTokens: 160, knownReportedCostUsd: 0.00000084
    } });
    expect(f.settle.mock.calls.map(call => call[2].state).sort()).toEqual(["FAILED", "SUCCEEDED"]);
  });

  it("records key revocation without substituting a provider or claiming a paid call", async () => {
    const f = fixture(); f.decide.mockRejectedValue(new ProviderAdmissionError("credential_revoked"));
    expect(await f.service(f.input)).toMatchObject({ status: "UNAVAILABLE", reason: "credential_revoked",
      diagnostics: { externalCallCount: 0, bindingCount: 1 } });
    expect(f.resolve).toHaveBeenCalledOnce();
  });

  it("does not overwrite a settled receipt after authority is lost", async () => {
    const f = fixture(); f.withAuthorizedResultCommit.mockRejectedValue(new MemoryExecutionError("memory_execution_policy_drift"));
    expect(await f.service(f.input)).toMatchObject({ status: "UNAVAILABLE", scores: [], diagnostics: { externalCallCount: 1 } });
    expect(f.settle).toHaveBeenCalledOnce(); expect(f.states.get("binding-1")).toBe("SUCCEEDED");
  });

  it("honors an outage cooldown and Retry-After without hidden paid retries", async () => {
    const f = fixture(); f.decide.mockRejectedValue(new DecisionAdapterError("decision_provider_http_error", { httpStatus: 429, retryAfterMs: 60_000 }));
    await f.service(f.input); f.advance(35_000);
    expect(await f.service(f.input)).toMatchObject({ reason: "memory_history_relevance_cooldown", diagnostics: { externalCallCount: 0, bindingCount: 0 } });
    expect(f.decide).toHaveBeenCalledOnce(); f.advance(30_000); f.states.clear(); f.decide.mockResolvedValue(f.output);
    expect(await f.service({ ...f.input, attemptId: "next-attempt" })).toMatchObject({ status: "READY" });
    expect(f.decide).toHaveBeenCalledTimes(2);
  });

  it("settles cancellation before baseline return and recovers late usage without applying or replaying it", async () => {
    const f = fixture(); let complete!: (value: DecisionResult) => void;
    f.decide.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const pending = f.service(f.input);
    await vi.waitFor(() => expect(f.decide).toHaveBeenCalledOnce());
    f.controller.abort({ code: "memory_history_relevance_timeout" });
    expect(await pending).toMatchObject({ status: "UNAVAILABLE", scores: [], diagnostics: { externalCallCount: 1, unknownCostCallCount: 1 } });
    expect(f.states.get("binding-1")).toBe("OUTCOME_UNKNOWN");
    expect(f.withAuthorizedResultCommit).not.toHaveBeenCalled();
    complete(f.output);
    await vi.waitFor(() => expect(f.recoverOutcome).toHaveBeenCalledWith("user", "binding-1", expect.objectContaining({
      state: "CANCELLED", acceptedOutputHash: null, usage: expect.objectContaining({ inputTokens: 80 })
    })));
    expect(f.decide).toHaveBeenCalledOnce();
  });
});
