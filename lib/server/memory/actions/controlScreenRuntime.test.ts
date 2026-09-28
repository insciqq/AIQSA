import { describe, expect, it, vi } from "vitest";
import { jevModelConfiguration, JEV_SERVED_MODEL_ID } from "../../../domain/decisionModels";
import type { DecisionModelRoleResolution } from "../../providerRuntime/decisionModelRole";
import type { createAcceptedDecisionRuntime } from "../../providerRuntime/decisionRuntime";
import { DecisionAdapterError, type DecisionResult } from "../../providers/decisions";
import type { ProviderExecutionSnapshot } from "../../providers/runtimeFactory";
import { MemoryExecutionError, type PrismaMemoryExecutionService } from "../execution";
import { createMemoryControlScreenService } from "./controlScreenRuntime";
import { MEMORY_CONTROL_SCREEN_QUESTION } from "./controlScreenPolicy";

function fixture() {
  const snapshot = {
    version: 1, connectionId: "connection", credentialId: "credential",
    credentialVersionId: "credential-version", connectionDisplayName: "Decision provider",
    modelDisplayName: "Decision model", providerModelId: "model",
    providerFamily: "openrouter",
    connection: { apiRoot: "https://provider.example.test/v1", authenticationMode: "bearer",
      allowPrivateNetwork: false, responseTimeoutMs: 30_000 },
    model: jevModelConfiguration(),
    decisionVerification: { probeVersion: 1, adapterKind: "openrouter_decisions",
      upstreamModelId: "typesafe/jev-1.13", servedModelId: JEV_SERVED_MODEL_ID,
      provider: "TypeSafe", noul: true, choice: true }
  } as ProviderExecutionSnapshot;
  const resolution = { ok: true, credentialScope: "installation", policyVersion: 3,
    providerModelId: "model", role: { snapshot } } as Extract<DecisionModelRoleResolution,
    { ok: true }>;
  const resolveRole = vi.fn(async (): Promise<DecisionModelRoleResolution> => resolution);
  const output: DecisionResult = {
    model: JEV_SERVED_MODEL_ID, provider: "TypeSafe", requestId: "request-1",
    usage: { inputTokens: 80, outputTokens: 21, costUsd: 0.00000042 },
    answers: { possible_memory_control: { type: "noul", noul: 0.02 } }
  };
  const decide = vi.fn(async () => output);
  const resolve = vi.fn(async () => ({ adapter: { decide } }));
  const states = new Map<string, string>();
  const bind = vi.fn(async (_userId: string, input: { ordinal: number }) => {
    const id = `binding-${input.ordinal}`;
    if (!states.has(id)) states.set(id, "PENDING");
    return { id, state: states.get(id) };
  });
  const admitted = { logicalRole: "MEMORY_CONTROL_SCREEN",
    providerExecutionSnapshot: snapshot };
  const start = vi.fn(async (_userId: string, id: string) => {
    if (states.get(id) !== "PENDING") {
      throw new MemoryExecutionError("memory_execution_state_conflict");
    }
    states.set(id, "RUNNING");
    return { snapshot: admitted };
  });
  const settle = vi.fn(async (_userId: string, id: string, input: { state: string }) => {
    states.set(id, input.state);
  });
  const recoverOutcome = vi.fn(async (_userId: string, id: string,
    input: { state: string }) => { states.set(id, input.state); });
  const withAuthorizedResultCommit = vi.fn(async () => true);
  let clock = 1_000;
  const service = createMemoryControlScreenService({
    resolveRole,
    runtime: { resolve } as unknown as ReturnType<typeof createAcceptedDecisionRuntime>,
    execution: { admission: { bind, start }, lifecycle: {
      settle, recoverOutcome, withAuthorizedResultCommit
    } } as unknown as PrismaMemoryExecutionService,
    clock: () => clock
  });
  const controller = new AbortController();
  const input = {
    userId: "user", attemptId: "attempt", signal: controller.signal,
    context: { currentUserMessage: "Привет / hello", recentMessages: [] }
  };
  return { service, input, controller, snapshot, resolution, resolveRole, decide,
    output, resolve, bind, start, settle, recoverOutcome,
    withAuthorizedResultCommit, states, admitted,
    advance: (ms: number) => { clock += ms; } };
}

describe("optional Memory control screen", () => {
  it.each(["decision_model_absent", "decision_feature_disabled",
    "decision_model_unavailable"] as const)("retains strict classification for %s", async (code) => {
    const f = fixture();
    f.resolveRole.mockResolvedValue({ ok: false, code, selectedProviderModelId: null });
    expect(await f.service(f.input)).toMatchObject({ possibleCommand: true,
      reason: code, diagnostics: { bindingCount: 0, externalCallCount: 0 } });
    expect(f.bind).not.toHaveBeenCalled();
  });

  it("requires exact served revision before binding", async () => {
    const f = fixture();
    f.resolveRole.mockResolvedValue({ ...f.resolution, role: { ...f.resolution.role,
      snapshot: { ...f.snapshot, decisionVerification: {
        ...f.snapshot.decisionVerification!, servedModelId: "future"
      } } } });
    expect(await f.service(f.input)).toMatchObject({ status: "SKIPPED",
      possibleCommand: true, reason: "memory_control_screen_unqualified" });
    expect(f.bind).not.toHaveBeenCalled();
  });

  it("bounds a slow role read before creating any binding", async () => {
    const f = fixture();
    f.resolveRole.mockImplementationOnce(() => new Promise(() => undefined));
    const pending = f.service(f.input);
    f.controller.abort({ code: "memory_control_screen_timeout" });
    expect(await pending).toMatchObject({ status: "UNAVAILABLE",
      possibleCommand: true, diagnostics: { bindingCount: 0,
        externalCallCount: 0 } });
    expect(f.bind).not.toHaveBeenCalled();
  });

  it("terminalizes a newly bound pending decision when start fails", async () => {
    const f = fixture();
    f.start.mockRejectedValueOnce(new MemoryExecutionError("memory_execution_policy_drift"));
    expect(await f.service(f.input)).toMatchObject({ status: "UNAVAILABLE",
      possibleCommand: true, diagnostics: { bindingCount: 1,
        externalCallCount: 0 } });
    expect(f.settle).toHaveBeenCalledWith("user", "binding-0",
      expect.objectContaining({ state: "FAILED", providerResponseId: null,
        usage: expect.objectContaining({ completeness: "UNAVAILABLE" }) }));
    expect(f.decide).not.toHaveBeenCalled();
  });

  it("stops waiting for a non-cooperative runtime lookup", async () => {
    const f = fixture();
    f.resolve.mockImplementationOnce(() => new Promise(() => undefined));
    const pending = f.service(f.input);
    await vi.waitFor(() => expect(f.resolve).toHaveBeenCalledOnce());
    f.controller.abort({ code: "memory_control_screen_timeout" });
    expect(await pending).toMatchObject({ status: "UNAVAILABLE", possibleCommand: true,
      diagnostics: { bindingCount: 1, externalCallCount: 0 } });
    expect(f.settle).toHaveBeenCalledWith("user", "binding-0",
      expect.objectContaining({ state: "CANCELLED" }));
    expect(f.decide).not.toHaveBeenCalled();
  });

  it("binds one costed decision and screens only a clear negative", async () => {
    const f = fixture();
    const result = await f.service({ ...f.input, context: {
      currentUserMessage: "Привет / hello", recentMessages: [{ role: "assistant", text: "Earlier context" }]
    } });
    expect(f.bind).toHaveBeenCalledWith("user", expect.objectContaining({
      ordinal: 0, role: "MEMORY_CONTROL_SCREEN",
      owner: { type: "RETRIEVAL_ATTEMPT", retrievalAttemptId: "attempt" }
    }));
    expect(f.decide).toHaveBeenCalledExactlyOnceWith({ state: {
      current_user_message: "Привет / hello",
      recent_messages: [{ role: "assistant", text: "Earlier context" }]
    }, questions: { possible_memory_control: MEMORY_CONTROL_SCREEN_QUESTION },
    signal: f.input.signal });
    expect(result).toMatchObject({ status: "READY", possibleCommand: false,
      diagnostics: { bindingCount: 1, externalCallCount: 1, completedCallCount: 1,
        knownReportedCostUsd: 0.00000042 } });
    expect(f.settle).toHaveBeenCalledWith("user", "binding-0", expect.objectContaining({
      state: "SUCCEEDED", usage: expect.objectContaining({ inputTokens: 80,
        outputTokens: 21, estimatedCostMicros: 0 })
    }));
    expect(f.withAuthorizedResultCommit).toHaveBeenCalledOnce();
  });

  it("passes the frozen threshold and malformed responses to the strict classifier", async () => {
    const f = fixture();
    f.decide.mockResolvedValueOnce({ ...f.output, answers: {
      possible_memory_control: { type: "noul", noul: 0.05 }
    } });
    expect(await f.service(f.input)).toMatchObject({ status: "READY", possibleCommand: true });
    const next = fixture();
    next.decide.mockResolvedValueOnce({ ...next.output, answers: {} });
    expect(await next.service(next.input)).toMatchObject({ status: "UNAVAILABLE",
      possibleCommand: true });
  });

  it("cools down a failed route without making a second provider call", async () => {
    const f = fixture();
    f.decide.mockRejectedValueOnce(new DecisionAdapterError("decision_provider_http_error",
      { httpStatus: 503 }));
    expect(await f.service(f.input)).toMatchObject({ status: "UNAVAILABLE",
      possibleCommand: true, diagnostics: { externalCallCount: 1 } });
    expect(await f.service(f.input)).toMatchObject({ reason: "memory_control_screen_cooldown",
      possibleCommand: true });
    expect(f.decide).toHaveBeenCalledTimes(1);
    f.advance(30_001);
    expect(await f.service(f.input)).toMatchObject({ possibleCommand: true });
  });

  it("does not apply a late answer after cancellation and recovers its accounting", async () => {
    const f = fixture();
    let resolveLate!: (value: DecisionResult) => void;
    f.decide.mockImplementationOnce(() => new Promise<DecisionResult>((resolve) => {
      resolveLate = resolve;
    }));
    const pending = f.service(f.input);
    await vi.waitFor(() => expect(f.decide).toHaveBeenCalledOnce());
    f.controller.abort({ code: "memory_control_screen_timeout" });
    expect(await pending).toMatchObject({ status: "UNAVAILABLE", possibleCommand: true,
      diagnostics: { bindingCount: 1, externalCallCount: 1 } });
    expect(f.settle).toHaveBeenCalledWith("user", "binding-0",
      expect.objectContaining({ state: "OUTCOME_UNKNOWN" }));
    resolveLate(f.output);
    await vi.waitFor(() => expect(f.recoverOutcome).toHaveBeenCalledWith("user",
      "binding-0", expect.objectContaining({ state: "CANCELLED",
        usage: expect.objectContaining({ inputTokens: 80 }) })));
  });
});
