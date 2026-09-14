import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryTransaction } from "../persistence/transaction";
import { memoryExecutionSha256 } from "./canonical";
import { executeGovernedMemoryStructuredOutput } from "./structuredClassifier";

const { bind, start, settle, settleDurable } = vi.hoisted(() => ({
  bind: vi.fn(), start: vi.fn(), settle: vi.fn(), settleDurable: vi.fn()
}));
vi.mock("./admission", () => ({
  createPrismaMemoryExecutionAdmission: () => ({ bind, start })
}));
vi.mock("./lifecycle", () => ({
  createPrismaMemoryExecutionLifecycle: () => ({
    settle, settleSucceededWithDurableResult: settleDurable
  })
}));

const completedAt = new Date("2026-09-14T12:00:00.000Z");
const tx = {} as MemoryTransaction;
const durableEvidence = {
  bindingId: "binding", completedAt,
  recoverableUntil: new Date("2026-09-15T12:00:00.000Z"), replayed: false
};

beforeEach(() => {
  vi.resetAllMocks();
  bind.mockResolvedValue({ id: "binding" });
  start.mockResolvedValue({
    snapshot: {
      logicalRole: "MEMORY_CONSOLIDATE", requiresStrictStructuredOutput: true,
      providerExecutionSnapshot: { providerFamily: "fixture", providerModelId: "configured-model" }
    }
  });
  settle.mockResolvedValue({ completedAt });
  settleDurable.mockImplementation(async (_userId, _bindingId, _result, persist) => {
    await persist(tx, durableEvidence);
    return { completedAt };
  });
});

function input() {
  return {
    authority: {}, client: {} as PrismaClient,
    decode: (value: unknown) => ({ admitted: (value as { ok: boolean }).ok }),
    inputHash: "a".repeat(64), ordinal: 0,
    owner: { memoryJobId: "owned-job", type: "JOB" as const },
    provider: { run: vi.fn().mockResolvedValue({
      output: { ok: true, discarded: "not part of the decoded result" },
      providerResponseId: null, usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 }
    }) },
    request: {
      maxOutputTokens: 128, name: "bounded_decision", schema: { type: "object" },
      systemPrompt: "Classify supplied data.", userPrompt: "Synthetic data"
    },
    role: "MEMORY_CONSOLIDATE" as const,
    signal: new AbortController().signal, userId: "owner",
    versions: { pipelineVersion: "pipeline", policyVersion: "policy",
      promptVersion: "prompt", retrievalConfigFingerprint: "retrieval", schemaVersion: "schema" }
  };
}

describe("governed structured output durable settlement", () => {
  it("stores only the decoded output in the same successful settlement as provider usage", async () => {
    const request = input();
    const persistResult = vi.fn().mockResolvedValue(undefined);
    const result = await executeGovernedMemoryStructuredOutput({ ...request, persistResult });
    const expectedHash = memoryExecutionSha256({
      inputHash: request.inputHash, output: { admitted: true }, role: request.role, version: 1
    });
    expect(request.provider.run).toHaveBeenCalledOnce();
    expect(settle).not.toHaveBeenCalled();
    expect(settleDurable).toHaveBeenCalledExactlyOnceWith("owner", "binding", {
      acceptedOutputHash: expectedHash, errorCode: null, providerResponseId: null,
      state: "SUCCEEDED", usage: expect.objectContaining({ inputTokens: 20, outputTokens: 5, totalTokens: 25 })
    }, expect.any(Function));
    expect(persistResult).toHaveBeenCalledExactlyOnceWith(tx, {
      ...durableEvidence, acceptedOutputHash: expectedHash,
      inputHash: request.inputHash, value: { admitted: true }
    });
    expect(result).toMatchObject({
      acceptedOutputHash: expectedHash, bindingId: "binding", classifiedAt: completedAt,
      inputHash: request.inputHash, modelId: "configured-model", value: { admitted: true }
    });
  });

  it("preserves ordinary settlement for callers without a durable recovery owner", async () => {
    const request = input();
    await executeGovernedMemoryStructuredOutput(request);
    expect(settle).toHaveBeenCalledOnce();
    expect(settleDurable).not.toHaveBeenCalled();
    expect(request.provider.run).toHaveBeenCalledOnce();
  });

  it("never publishes success or falls back to non-atomic settlement when persistence fails", async () => {
    const request = input();
    const persistResult = vi.fn().mockRejectedValue(new Error("durable_owner_unavailable"));
    await expect(executeGovernedMemoryStructuredOutput({ ...request, persistResult }))
      .rejects.toThrow("durable_owner_unavailable");
    expect(settle).not.toHaveBeenCalled();
    expect(settleDurable).toHaveBeenCalledOnce();
    expect(request.provider.run).toHaveBeenCalledOnce();
  });

  it("settles invalid output as failure with reported usage and no durable accepted result", async () => {
    const request = input();
    const persistResult = vi.fn();
    await expect(executeGovernedMemoryStructuredOutput({
      ...request, persistResult, decode: () => { throw new Error("invalid_decision"); }
    })).rejects.toThrow("invalid_decision");
    expect(persistResult).not.toHaveBeenCalled();
    expect(settleDurable).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledWith("owner", "binding", expect.objectContaining({
      state: "FAILED", acceptedOutputHash: null, errorCode: "memory_classifier_output_invalid",
      usage: expect.objectContaining({ inputTokens: 20, outputTokens: 5 })
    }));
  });
});
