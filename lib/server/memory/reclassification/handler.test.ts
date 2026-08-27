import { describe, expect, it, vi } from "vitest";
import {
  createMemoryReclassificationHandler
} from "./handler";
import {
  MEMORY_RECLASSIFICATION_PIPELINE_VERSION
} from "./classifier";
import { MEMORY_SAFETY_LITE_POLICY_VERSION } from "../safetyLite";
import type { MemoryReclassificationCandidate } from "./repository";

const candidate: MemoryReclassificationCandidate = {
  category: "preferences",
  coreEligible: true,
  coreSalience: "HIGH",
  displayText: "I prefer tea",
  factId: "fact-1",
  id: "version-1",
  modality: "PREFERENCE",
  safetyClassificationState: "PENDING",
  semanticState: "ACTIVE",
  sourceMode: "EXPLICIT",
  structuredValue: { statement: "I prefer tea" },
  systemFrom: new Date("2026-01-01T00:00:00.000Z"),
  userId: "user-1"
};

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
    sourceMessageId: null,
    sourceRevision: null,
    stage: null,
    targetFactVersionId: null,
    userId: "user-1"
  };
}

describe("memory reclassification handler", () => {
  it("returns an idempotent apply closure for classified batches", async () => {
    const apply = vi.fn(async () => undefined);
    const authorizeResults = vi.fn(async () => undefined);
    const classify = vi.fn();
    const handler = createMemoryReclassificationHandler({
      authorizeResults,
      provider: { classify },
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
    expect(setStage).toHaveBeenCalledWith("local_safety_projection");
    const tx = {};
    const acceptedClaim = job();
    await result.apply?.(tx as never, acceptedClaim);
    expect(classify).not.toHaveBeenCalled();
    expect(authorizeResults).not.toHaveBeenCalled();
    expect(apply).toHaveBeenCalledWith(
      tx,
      "user-1",
      [expect.objectContaining({
        result: expect.objectContaining({
          executionId: null,
          policyVersion: MEMORY_SAFETY_LITE_POLICY_VERSION
        })
      })],
      new Date("2026-08-21T00:00:00.000Z")
    );
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

  it("does not depend on a legacy classifier outage", async () => {
    const apply = vi.fn(async () => undefined);
    const classify = vi.fn(async () => {
      throw new Error("classifier unavailable");
    });
    const handler = createMemoryReclassificationHandler({
      authorizeResults: vi.fn(async () => undefined),
      provider: { classify },
      repository: {
        apply,
        preflight: vi.fn(async () => ({ status: "READY" as const })),
        pending: vi.fn(async () => [candidate])
      }
    });

    const result = await handler.execute(job(), {
      now: () => new Date("2026-08-21T00:00:00.000Z"),
      setStage: vi.fn(async () => undefined),
      signal: new AbortController().signal
    });
    await result.apply?.({} as never, job());
    expect(classify).not.toHaveBeenCalled();
    expect(apply).toHaveBeenCalledOnce();
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
          policyVersion: MEMORY_SAFETY_LITE_POLICY_VERSION,
          providerId: "aiqsa-local-policy"
        })
      })],
      new Date("2026-08-21T00:00:00.000Z")
    );
  });
});
