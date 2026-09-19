import { describe, expect, it, vi } from "vitest";
import { jevModelConfiguration, JEV_SERVED_MODEL_ID } from "../../domain/decisionModels";
import type { ProviderExecutionSnapshot } from "../providers/runtimeFactory";
import { DecisionAdapterError, type DecisionResult } from "../providers/decisions";
import { ProviderAdmissionError } from "./admission";
import { createOptionalDecisionService } from "./optionalDecision";
import type { OptionalDecisionRepository } from "./optionalDecisionRepository";

function fixture(timeoutMs = 4_000) {
  const snapshot: ProviderExecutionSnapshot = { version: 1, connectionId: "provider", providerModelId: "deployment",
    credentialId: "credential", credentialVersionId: "version", connectionDisplayName: "Provider", modelDisplayName: "Decision",
    providerFamily: "openrouter", connection: { apiRoot: "https://provider.example.test/v1", authenticationMode: "bearer",
      allowPrivateNetwork: false, responseTimeoutMs: 30_000 }, model: jevModelConfiguration(),
    decisionVerification: { probeVersion: 1, adapterKind: "openrouter_decisions", upstreamModelId: "typesafe/jev-1.13",
      servedModelId: JEV_SERVED_MODEL_ID, provider: "TypeSafe", noul: true, choice: true } };
  const result: DecisionResult = { model: JEV_SERVED_MODEL_ID, provider: "TypeSafe", requestId: "receipt",
    usage: { inputTokens: 20, outputTokens: 3, costUsd: 0.00001 }, answers: { s0: { type: "noul", noul: 0.9 } } };
  const decide = vi.fn(async () => result);
  const start = vi.fn<OptionalDecisionRepository["start"]>(async () => ({ kind: "new", id: "attempt" }));
  const settle = vi.fn<OptionalDecisionRepository["settle"]>(async () => undefined);
  const runtime = vi.fn(async () => ({ adapter: { decide }, configuration: jevModelConfiguration(), executionSnapshot: snapshot,
    provider: "openrouter", providerModelId: "deployment" }));
  const controller = new AbortController();
  const input = { owner: { userId: "user", purpose: "skill_suggestions" as const, operationKey: "operation" },
    evidence: { connectionId: "provider", providerModelId: "deployment", credentialId: "credential", credentialVersionId: "version", executionSnapshot: snapshot },
    policy: "test-v1", request: { state: { draft: "PRIVATE_DRAFT", catalog: [{ name: "PRIVATE_NAME" }] },
      questions: { s0: { type: "noul" as const, instructions: "Assess the procedure." } } },
    authorize: vi.fn(async () => undefined), signal: controller.signal };
  return { service: createOptionalDecisionService({ repository: { start, settle }, runtime, timeoutMs }), input,
    result, decide, start, settle, runtime, snapshot, controller };
}

describe("optional interactive decision dispatch", () => {
  it("claims before I/O and stores only request identity, snapshot and normalized answers", async () => {
    const f = fixture(); expect(await f.service(f.input)).toEqual(f.result.answers);
    expect(f.start.mock.invocationCallOrder[0]).toBeLessThan(f.decide.mock.invocationCallOrder[0]!);
    expect(f.start).toHaveBeenCalledWith(f.input.owner, expect.stringMatching(/^[a-f0-9]{64}$/u), f.snapshot);
    expect(JSON.stringify(f.start.mock.calls)).not.toContain("PRIVATE_DRAFT");
    expect(JSON.stringify(f.settle.mock.calls)).not.toContain("PRIVATE_NAME");
    expect(f.settle).toHaveBeenCalledWith(f.input.owner, "attempt", {
      receipt: f.result, answers: f.result.answers, failureCode: null, dispatched: true
    });
  });
  it("reuses settled answers and never dispatches an ambiguous replay", async () => {
    const f = fixture(); f.start.mockResolvedValueOnce({ kind: "replay", answers: f.result.answers })
      .mockResolvedValueOnce({ kind: "replay", answers: null });
    expect(await f.service(f.input)).toEqual(f.result.answers);
    expect(await f.service(f.input)).toBeNull();
    expect(f.decide).not.toHaveBeenCalled(); expect(f.settle).not.toHaveBeenCalled();
    expect(f.input.authorize).toHaveBeenCalledTimes(4);
  });
  it("keeps revoked credentials local and preserves invalid-response accounting", async () => {
    const f = fixture(); f.decide.mockRejectedValueOnce(new ProviderAdmissionError("credential_revoked"));
    expect(await f.service(f.input)).toBeNull();
    expect(f.settle).toHaveBeenLastCalledWith(f.input.owner, "attempt", expect.objectContaining({ dispatched: false, receipt: null }));
    f.decide.mockRejectedValueOnce(new DecisionAdapterError("decision_response_invalid", { receipt: f.result }));
    expect(await f.service(f.input)).toBeNull();
    expect(f.settle).toHaveBeenLastCalledWith(f.input.owner, "attempt", expect.objectContaining({ dispatched: true, receipt: f.result, answers: null }));
  });
  it("does not hide revoked resource authority or reuse an unqualified model", async () => {
    const f = fixture(); f.input.authorize.mockRejectedValueOnce(new Error("resource_unavailable"));
    await expect(f.service(f.input)).rejects.toThrow("resource_unavailable");
    expect(f.start).not.toHaveBeenCalled();
    f.runtime.mockResolvedValue({ adapter: { decide: f.decide }, configuration: jevModelConfiguration(),
      executionSnapshot: { ...f.snapshot, decisionVerification: { ...f.snapshot.decisionVerification!, servedModelId: "unqualified" } },
      provider: "openrouter", providerModelId: "deployment" });
    expect(await f.service(f.input)).toBeNull(); expect(f.decide).not.toHaveBeenCalled();
  });
  it("returns on timeout and enriches the same charge without applying late recommendations", async () => {
    const f = fixture(5); let finish!: (result: DecisionResult) => void;
    f.decide.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    expect(await f.service(f.input)).toBeNull();
    expect(f.settle).toHaveBeenCalledWith(f.input.owner, "attempt", expect.objectContaining({ receipt: null, answers: null, dispatched: true }));
    finish(f.result); await vi.waitFor(() => expect(f.settle).toHaveBeenCalledTimes(2));
    expect(f.settle).toHaveBeenLastCalledWith(f.input.owner, "attempt", expect.objectContaining({ receipt: f.result, answers: null }));
    expect(f.decide).toHaveBeenCalledOnce();
  });
  it("propagates Stop after retaining incurred usage", async () => {
    const f = fixture(); f.decide.mockImplementation(async () => { f.controller.abort(new Error("stop")); return f.result; });
    await expect(f.service(f.input)).rejects.toThrow("stop");
    await vi.waitFor(() => expect(f.settle.mock.calls.some(call => call[2].receipt === f.result)).toBe(true));
    expect(f.decide).toHaveBeenCalledOnce();
  });
  it("does not hide a required Agent admission failure as an optional provider outage", async () => {
    const f = fixture(); const admit = vi.fn(async () => { throw new Error("agent_budget_exhausted"); });
    await expect(f.service({ ...f.input, admit })).rejects.toThrow("agent_budget_exhausted");
    expect(f.decide).not.toHaveBeenCalled();
    expect(f.settle).toHaveBeenCalledWith(f.input.owner, "attempt", expect.objectContaining({ dispatched: false }));
  });
});
