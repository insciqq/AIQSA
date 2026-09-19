import { describe, expect, it, vi } from "vitest";
import { jevModelConfiguration, JEV_SERVED_MODEL_ID } from "../../domain/decisionModels";
import type { ProviderExecutionSnapshot } from "../providers/runtimeFactory";
import type { KnowledgeRelevanceRoleResolution } from "./relevanceBinding";
import { ProviderAdmissionError } from "../providerRuntime/admission";
import { DecisionAdapterError, type DecisionResult } from "../providers/decisions";
import { createKnowledgeRelevanceService } from "./relevanceRuntime";
import { decodeKnowledgeRelevanceEvidence, knowledgeRelevanceKeptChunks, KNOWLEDGE_RELEVANCE_QUESTION } from "./relevancePolicy";

function fixture(timeoutMs = 4_000) {
  const snapshot: ProviderExecutionSnapshot = { version: 1, connectionId: "connection", credentialId: "credential", credentialVersionId: "key-version",
    connectionDisplayName: "Provider", modelDisplayName: "Decision", providerModelId: "model", providerFamily: "openrouter",
    connection: { apiRoot: "https://provider.example.test/v1", authenticationMode: "bearer", allowPrivateNetwork: false, responseTimeoutMs: 30_000 },
    model: jevModelConfiguration(), decisionVerification: { probeVersion: 1, adapterKind: "openrouter_decisions", upstreamModelId: "typesafe/jev-1.13",
      servedModelId: JEV_SERVED_MODEL_ID, provider: "TypeSafe", noul: true, choice: true } };
  const role = { ok: true, role: { snapshot, authority: { connectionId: "connection", providerModelId: "model",
    credentialId: "credential", credentialVersionId: "key-version" } } } as const;
  const resolveRole = vi.fn(async (): Promise<KnowledgeRelevanceRoleResolution> => role);
  const output: DecisionResult = { model: JEV_SERVED_MODEL_ID, provider: "TypeSafe", requestId: "request",
    usage: { inputTokens: 50, outputTokens: 10, costUsd: 0.00001 }, answers: { useful: { type: "noul", noul: 0.02 } } };
  const decide = vi.fn(async () => output);
  const started = new Set<number>();
  const start = vi.fn(async (input: { ordinal: number }) => {
    if (started.has(input.ordinal)) return null;
    started.add(input.ordinal); return `attempt-${input.ordinal}`;
  });
  const settle = vi.fn(async () => undefined);
  const runtime = vi.fn(async () => ({ adapter: { decide }, configuration: jevModelConfiguration(), executionSnapshot: snapshot,
    provider: "openrouter", providerModelId: "model" }));
  const service = createKnowledgeRelevanceService({ resolveRole, repository: { start, settle }, runtime, timeoutMs });
  const controller = new AbortController();
  const input = { userId: "user", runId: "run", reservationId: "reservation", leaseToken: "lease-token", signal: controller.signal,
    authorize: vi.fn(async () => undefined),
    query: "Вопрос / question", passages: [{ chunkId: "chunk-1", fileName: "Source", includedText: "Independent excerpt" }] };
  return { service, input, controller, snapshot, role, resolveRole, output, decide, start, settle, runtime };
}

describe("optional Knowledge usefulness decisions", () => {
  it("does not disclose when no Decisions binding was accepted", async () => {
    const f = fixture(); f.resolveRole.mockResolvedValue({ ok: false, code: "decision_model_absent" });
    expect(await f.service(f.input)).toBeNull();
    expect(f.resolveRole).toHaveBeenCalledWith(f.input);
    expect(f.start).not.toHaveBeenCalled(); expect(f.decide).not.toHaveBeenCalled();
  });
  it("does not transfer calibration to an unqualified served model", async () => {
    const f = fixture(); f.resolveRole.mockResolvedValue({ ...f.role, role: { ...f.role.role, snapshot: {
      ...f.snapshot, decisionVerification: { ...f.snapshot.decisionVerification!, servedModelId: "future-model" }
    } } });
    expect(await f.service(f.input)).toBeNull(); expect(f.start).not.toHaveBeenCalled();
  });
  it("pins the owner and complete excerpt before I/O, with reported usage and no raw text in the receipt", async () => {
    const f = fixture(); const result = (await f.service(f.input))!;
    expect(f.start).toHaveBeenCalledWith(expect.objectContaining({ reservationId: "reservation", runId: "run", userId: "user",
      ordinal: 1, executionSnapshot: f.snapshot, inputHash: expect.stringMatching(/^[a-f0-9]{64}$/u) }));
    expect(f.start.mock.invocationCallOrder[0]).toBeLessThan(f.decide.mock.invocationCallOrder[0]!);
    expect(f.decide).toHaveBeenCalledWith(expect.objectContaining({ questions: { useful: KNOWLEDGE_RELEVANCE_QUESTION } }));
    expect(f.settle).toHaveBeenCalledWith(f.input, "attempt-1", { receipt: f.output, usefulness: 0.02, failureCode: null, dispatched: true });
    expect(decodeKnowledgeRelevanceEvidence(result)).toEqual(result);
    expect([...knowledgeRelevanceKeptChunks(result)!]).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("Independent excerpt");
  });
  it("does not replay a previously claimed operation", async () => {
    const f = fixture(); await f.service(f.input);
    expect(await f.service(f.input)).toMatchObject({ status: "unavailable", failureCode: "knowledge_relevance_already_attempted" });
    expect(f.decide).toHaveBeenCalledOnce(); expect(f.settle).toHaveBeenCalledOnce();
  });
  it("rechecks source authority before disclosing and does not hide a failed fence", async () => {
    const f = fixture(); f.input.authorize.mockRejectedValue(new Error("knowledge_scope_revoked"));
    await expect(f.service(f.input)).rejects.toThrow("knowledge_scope_revoked");
    expect(f.start).not.toHaveBeenCalled(); expect(f.decide).not.toHaveBeenCalled();
  });
  it("discards every score on incomplete coverage but retains both accounting receipts", async () => {
    const f = fixture(); f.decide.mockRejectedValueOnce(new DecisionAdapterError("decision_response_invalid", { receipt: f.output }));
    const result = await f.service({ ...f.input, passages: [...f.input.passages, { ...f.input.passages[0]!, chunkId: "chunk-2" }] });
    expect(result).toMatchObject({ status: "unavailable", scores: [] });
    expect(f.settle).toHaveBeenCalledTimes(2);
  });
  it("treats revoked credentials as no dispatch, without changing the deployment", async () => {
    const f = fixture(); f.decide.mockRejectedValue(new ProviderAdmissionError("credential_revoked"));
    expect(await f.service(f.input)).toMatchObject({ status: "unavailable", failureCode: "credential_revoked" });
    expect(f.settle).toHaveBeenCalledWith(f.input, "attempt-1", expect.objectContaining({ dispatched: false, receipt: null }));
    expect(f.runtime).toHaveBeenCalledOnce();
  });
  it("bounds a hung optional transport and applies late usage only to the original attempt", async () => {
    const f = fixture(10); let finish!: (result: DecisionResult) => void;
    f.decide.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const result = await f.service(f.input);
    expect(result).toMatchObject({ status: "unavailable", scores: [] });
    expect(f.settle).toHaveBeenCalledWith(f.input, "attempt-1", expect.objectContaining({ receipt: null, usefulness: null }));
    finish(f.output);
    await vi.waitFor(() => expect(f.settle).toHaveBeenCalledTimes(2));
    expect(f.settle).toHaveBeenLastCalledWith(f.input, "attempt-1", expect.objectContaining({ receipt: f.output, usefulness: null }));
    expect(f.decide).toHaveBeenCalledOnce();
  });
  it("propagates Stop after settling incurred usage", async () => {
    const f = fixture(); let finish!: (result: DecisionResult) => void;
    f.decide.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.service(f.input); const rejected = expect(pending).rejects.toThrow("stop");
    await vi.waitFor(() => expect(f.decide).toHaveBeenCalledOnce());
    f.controller.abort(new Error("stop")); await rejected;
    finish(f.output); await vi.waitFor(() => expect(f.settle).toHaveBeenCalledTimes(2));
  });
  it("rejects duplicate/missing/non-finite scores and preserves uncertain evidence", async () => {
    const f = fixture(); f.decide.mockResolvedValue({ ...f.output, answers: { useful: { type: "noul", noul: 0.1 } } });
    const result = (await f.service(f.input))!;
    expect([...knowledgeRelevanceKeptChunks(result)!]).toEqual(["chunk-1"]);
    for (const invalid of [{ ...result, scores: [] }, { ...result, scores: [NaN] }, { ...result, attemptIds: [] },
      { ...result, chunkIds: ["chunk-1", "chunk-1"], attemptIds: ["a", "b"], scores: [0, 0] }]) {
      expect(decodeKnowledgeRelevanceEvidence(invalid)).toBeNull();
    }
  });
});
