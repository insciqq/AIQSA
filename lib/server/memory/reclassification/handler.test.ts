import { describe, expect, it, vi } from "vitest";
import {
  createMemoryReclassificationHandler
} from "./handler";
import {
  MEMORY_RECLASSIFICATION_PIPELINE_VERSION,
  memoryReclassificationAcceptedOutputHash,
  memoryReclassificationInputHash,
  type MemoryReclassificationResult
} from "./classifier";
import type { MemoryReclassificationCandidate } from "./repository";

const candidate: MemoryReclassificationCandidate = {
  coreEligible: true,
  coreSalience: "HIGH",
  displayText: "I prefer tea",
  factId: "fact-1",
  id: "version-1",
  modality: "PREFERENCE",
  sourceMode: "EXPLICIT",
  systemFrom: new Date("2026-01-01T00:00:00.000Z"),
  userId: "user-1"
};

const providerDecision = {
  category: "about_you" as const,
  reasonCode: "ordinary_personal" as const,
  responsePreference: false,
  sensitivity: "NORMAL" as const,
  subjectScope: "USER" as const,
  storageDecision: "ALLOW" as const
};
const providerInputHash = memoryReclassificationInputHash(
  candidate.displayText,
  candidate.sourceMode
);
const providerOutputHash = memoryReclassificationAcceptedOutputHash(
  providerInputHash,
  providerDecision
);

function job() {
  return {
    activeLeafMessageId: null,
    attemptCount: 1,
    branchGeneration: null,
    chatId: null,
    claimToken: "claim-token",
    id: "job-1",
    idempotencyFingerprint: "a".repeat(64),
    kind: "RECLASSIFY_FACTS" as const,
    memoryGenerationSnapshot: 0,
    memoryRevisionSnapshot: 0,
    pipelineVersion: MEMORY_RECLASSIFICATION_PIPELINE_VERSION,
    leaseExpiresAt: new Date("2026-08-21T00:05:00.000Z"),
    recoveredLease: false,
    sourceHash: null,
    sourceRevision: null,
    stage: null,
    userId: "user-1"
  };
}

describe("memory reclassification handler", () => {
  it("returns an idempotent apply closure for classified batches", async () => {
    const apply = vi.fn(async () => undefined);
    const authorizeResults = vi.fn(async () => undefined);
    const handler = createMemoryReclassificationHandler({
      authorizeResults,
      provider: {
        classify: vi.fn(async (): Promise<MemoryReclassificationResult> => ({
          acceptedOutputHash: providerOutputHash,
          decision: providerDecision,
          executionId: "reclassification-binding-1",
          inputHash: providerInputHash,
          modelId: "model-1",
          policyVersion: "memory-safety-policy-v1:7",
          providerId: "openai"
        }))
      },
      repository: {
        apply,
        preflight: vi.fn(async () => ({ status: "READY" as const })),
        pending: vi.fn(async () => [candidate])
      }
    });
    const setStage = vi.fn(async () => undefined);
    const result = await handler.execute(job(), {
      now: () => new Date("2026-08-21T00:00:00.000Z"),
      setStage,
      signal: new AbortController().signal
    });
    expect(result.stage).toBe("reclassification_applied");
    expect(result.acceptedResultHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(setStage).toHaveBeenCalledWith("provider_call");
    const tx = {
      $queryRaw: vi.fn(async () => [{ ownerStatus: "active", userId: "user-1" }])
    };
    const acceptedClaim = job();
    await result.apply?.(tx as never, acceptedClaim);
    expect(authorizeResults).toHaveBeenCalledWith(
      tx,
      { userId: "user-1" },
      "user-1",
      acceptedClaim.id,
      [{
        acceptedOutputHash: providerOutputHash,
        bindingId: "reclassification-binding-1",
        inputHash: providerInputHash,
        modelId: "model-1",
        policyVersion: "memory-safety-policy-v1:7",
        providerId: "openai"
      }]
    );
    expect(apply).toHaveBeenCalledOnce();
  });

  it("settles an empty job without a provider call", async () => {
    const classify = vi.fn();
    const handler = createMemoryReclassificationHandler({
      provider: { classify },
      repository: {
        apply: vi.fn(async () => undefined),
        preflight: vi.fn(async () => ({ status: "READY" as const })),
        pending: vi.fn(async () => [])
      }
    });
    const result = await handler.execute(job(), {
      now: () => new Date(),
      setStage: vi.fn(async () => undefined),
      signal: new AbortController().signal
    });
    expect(result.stage).toBe("reclassification_empty");
    expect(classify).not.toHaveBeenCalled();
  });

  it("rejects a decision swapped onto another accepted classifier receipt", async () => {
    const apply = vi.fn(async () => undefined);
    const handler = createMemoryReclassificationHandler({
      authorizeResults: vi.fn(async () => undefined),
      provider: {
        classify: vi.fn(async (): Promise<MemoryReclassificationResult> => ({
          acceptedOutputHash: providerOutputHash,
          decision: { ...providerDecision, category: "goals" },
          executionId: "reclassification-binding-1",
          inputHash: providerInputHash,
          modelId: "model-1",
          policyVersion: "memory-safety-policy-v1:7",
          providerId: "openai"
        }))
      },
      repository: {
        apply,
        preflight: vi.fn(async () => ({ status: "READY" as const })),
        pending: vi.fn(async () => [candidate])
      }
    });

    await expect(handler.execute(job(), {
      now: () => new Date("2026-08-21T00:00:00.000Z"),
      setStage: vi.fn(async () => undefined),
      signal: new AbortController().signal
    })).rejects.toMatchObject({
      code: "memory_reclassification_invalid",
      retryable: false
    });
    expect(apply).not.toHaveBeenCalled();
  });

  it("fences recognized legacy secrets locally without provider egress", async () => {
    const classify = vi.fn();
    const apply = vi.fn(async () => undefined);
    const probeAuthority = vi.fn(async () => undefined);
    const secretCandidate: MemoryReclassificationCandidate = {
      ...candidate,
      displayText:
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
        "eyJzdWIiOiIxMjM0NTY3ODkwIn0." +
        "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    };
    const handler = createMemoryReclassificationHandler({
      probeAuthority,
      provider: { classify },
      repository: {
        apply,
        preflight: vi.fn(async () => ({ status: "READY" as const })),
        pending: vi.fn(async () => [secretCandidate])
      }
    });
    await expect(handler.preflight(job())).resolves.toEqual({ status: "READY" });
    const result = await handler.execute(job(), {
      now: () => new Date("2026-08-21T00:00:00.000Z"),
      setStage: vi.fn(async () => undefined),
      signal: new AbortController().signal
    });
    await result.apply?.({} as never, job());
    expect(probeAuthority).not.toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
    expect(apply).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      [expect.objectContaining({
        result: expect.objectContaining({
          executionId: null,
          policyVersion: "memory-local-secret-parser-v1",
          providerId: "aiqsa-local-policy"
        })
      })],
      new Date("2026-08-21T00:00:00.000Z")
    );
  });
});
