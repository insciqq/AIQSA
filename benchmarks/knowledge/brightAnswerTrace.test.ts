import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { brightAnswerHash } from "./brightAnswerHarness";
import { brightJudgeEvidence, captureBrightAnswerTrace } from "./brightAnswerTrace";

vi.mock("../../lib/server/providers/runtimeFactory", () => ({
  normalizeProviderExecutionSnapshot: (value: unknown) => value
}));
vi.mock("./openRagAnswerLive", () => ({
  textFromContent: (value: unknown) => typeof value === "string" ? value.trim() : ""
}));

function fixture() {
  const snapshot = { fixture: "normalized non-secret deployment" };
  const scopePin = { snapshotId: "snapshot", generationId: "generation", profileRevisionId: "profile",
    vectorSpaceFingerprint: "vector", targetDimension: 3 };
  const row = {
    id: "run", modelId: "fixture-model", status: "complete", toolCalls: [], knowledgeRuns: [],
    userMessage: { content: "Synthetic question" }, assistantMessage: { content: "Synthetic answer" },
    providerRunBindings: [{ executionSnapshot: snapshot }],
    normalizedRequest: { prompt: { system: "A fixed baseline", developer: null },
      params: { fixture: "MUST_NOT_EXPORT" }, mcp: { fixture: "MUST_NOT_EXPORT" } },
    errorPayload: { code: "fixture_failure", message: "MUST_NOT_EXPORT" },
    knowledgeRunScope: { selection: { baseIds: ["base"] }, resolvedBaseCount: 1,
      resolvedSourceCount: 107_081, answerRoute: "rag_v1" },
    knowledgeRunBindings: [{ knowledgeBaseId: "base", knowledgeBaseSnapshotId: "snapshot",
      indexGenerationId: "generation", includeWholeBase: true, vectorSpaceFingerprint: "vector", targetDimension: 3 }],
    knowledgeRunProfileBindings: [{ profileRevisionId: "profile" }],
    knowledgeRetrievalSession: { evidenceItems: [] }, knowledgeProviderAttempts: [],
    knowledgeDispatchManifests: []
  };
  const findMany = vi.fn(async () => [row]);
  const input = { prisma: { modelRun: { findMany } } as unknown as PrismaClient,
    chatId: "chat", userId: "owner", baseId: "base", question: "Synthetic question", scopePin,
    expectedPin: { connectionId: "connection", providerModelId: "model", adapterKind: "openai_responses_compatible",
      upstreamModelId: "fixture-model", executionSnapshotHash: brightAnswerHash(snapshot) } };
  return { row, findMany, input };
}

describe("private normalized BRIGHT trace", () => {
  it("selects only the exact owned chat and omits execution/HTTP envelopes", async () => {
    const { input, findMany } = fixture();
    const trace = await captureBrightAnswerTrace(input);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { chatId: "chat", userId: "owner" }, take: 2 }));
    expect(trace).toMatchObject({ answer: "Synthetic answer", error: "fixture_failure",
      admittedPrompt: { system: "A fixed baseline" } });
    expect(JSON.stringify(trace)).not.toContain("MUST_NOT_EXPORT");
    expect(trace).not.toHaveProperty("providerRunBindings");
    expect(trace).not.toHaveProperty("normalizedRequest");
  });

  it("rejects a different question, deployment, or frozen Source snapshot", async () => {
    const { input } = fixture();
    await expect(captureBrightAnswerTrace({ ...input, question: "Another question" })).rejects.toThrow("identity_mismatch");
    await expect(captureBrightAnswerTrace({ ...input, expectedPin: { ...input.expectedPin, executionSnapshotHash: "changed" } })).rejects.toThrow("model_drift");
    await expect(captureBrightAnswerTrace({ ...input, scopePin: { ...input.scopePin, snapshotId: "changed" } })).rejects.toThrow("snapshot_mismatch");
    await expect(captureBrightAnswerTrace({ ...input, baseId: null, scopePin: null })).rejects.toThrow("scope_mismatch");
  });

  it("never treats an ambiguous chat as a successful run", async () => {
    const { input, findMany, row } = fixture();
    findMany.mockResolvedValue([row, row]);
    await expect(captureBrightAnswerTrace(input)).rejects.toThrow("ambiguous");
    findMany.mockResolvedValue([]);
    await expect(captureBrightAnswerTrace(input)).resolves.toBeNull();
  });

  it("uses dispatched evidence only, excluding merely sealed candidates", () => {
    const trace = { knowledgeDispatchManifests: [
      { providerAttempt: { dispatchedAt: null }, items: [{ handle: "K1", renderedBlock: "Not delivered" }] },
      { providerAttempt: { dispatchedAt: new Date() }, items: [{ handle: "K2", renderedBlock: "Delivered" }] }
    ] } as unknown as NonNullable<Awaited<ReturnType<typeof captureBrightAnswerTrace>>>;
    expect(brightJudgeEvidence(trace)).toEqual([{ handle: "K2", text: "Delivered" }]);
  });
});
