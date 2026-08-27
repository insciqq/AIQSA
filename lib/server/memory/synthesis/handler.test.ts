import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { MemoryJobClaim } from "../coordinator/types";
import { createMemorySynthesisHandler } from "./handler";
import {
  buildMemorySynthesisPlan,
  memorySynthesisSourceEligibilityHash,
  MEMORY_SYNTHESIS_PIPELINE_VERSION,
  type MemorySynthesisPlan,
  type MemorySynthesisSource
} from "./policy";
import {
  memorySynthesisAcceptedOutputHash,
  memorySynthesisInputHash
} from "./provider";
import type { MemorySynthesisRepository } from "./repository";

const NOW = new Date("2026-08-24T09:00:00.000Z");

function synthesisPlan(): MemorySynthesisPlan {
  const boundary = new Date("2026-08-01T00:00:00.000Z");
  const sources = Array.from({ length: 20 }, (_, index) => {
    const base = {
      canonicalKey: `habit:${index}`,
      category: "habits",
      directness: "DIRECT" as const,
      displayText: `I repeatedly use workflow ${index}.`,
      entityIds: ["entity-workflow"],
      factId: `fact-${index}`,
      ingestionFingerprint: index.toString(16).padStart(64, "0"),
      memoryGeneration: 1,
      modality: "HABIT" as const,
      observedAt: new Date(boundary.getTime() + index * 60_000),
      pipelineVersion: "memory-fact-extraction-vnext-v2",
      predicateKey: "workflow",
      sourceChatIds: [`chat-${index % 2}`],
      sourceMessageIds: [`message-${index}`],
      sourceMode: "AUTOMATIC" as const,
      structuredValue: { index },
      subjectKey: "user",
      versionId: `version-${index}`
    };
    return {
      ...base,
      eligibilityHash: memorySynthesisSourceEligibilityHash(base)
    } satisfies MemorySynthesisSource;
  });
  return buildMemorySynthesisPlan({ boundary, generation: 1, sources })!;
}

function claim(overrides: Partial<MemoryJobClaim> = {}): MemoryJobClaim {
  return {
    activeLeafMessageId: null,
    attemptCount: 1,
    branchGeneration: null,
    chatId: null,
    claimToken: "claim-token",
    id: "synthesis-job-1",
    idempotencyFingerprint: "a".repeat(64),
    kind: "SYNTHESIZE_MEMORIES",
    leaseExpiresAt: new Date("2026-08-24T09:05:00.000Z"),
    memoryGenerationSnapshot: 1,
    memoryRevisionSnapshot: 4,
    pipelineVersion: MEMORY_SYNTHESIS_PIPELINE_VERSION,
    recoveredLease: false,
    sourceHash: null,
    sourceMessageId: null,
    sourceRevision: null,
    stage: null,
    targetFactVersionId: null,
    userId: "user-1",
    ...overrides
  };
}

function result(plan: MemorySynthesisPlan) {
  const output = {
    patterns: [{
      confidenceBand: "HIGH" as const,
      entityRefs: ["entity-workflow"],
      reasonCode: "repeated_workflow_pattern" as const,
      sourceRefs: plan.clusters[0]!.sources.slice(0, 3).map(({ ref }) => ref),
      statement: "I tend to use a repeatable workflow."
    }]
  };
  const inputHash = memorySynthesisInputHash(plan);
  return {
    acceptedOutputHash: memorySynthesisAcceptedOutputHash(inputHash, output),
    executionId: "execution-1",
    inputHash,
    modelId: "system-model",
    output,
    policyVersion: "memory-synthesis-policy-v3",
    providerId: "openai_compatible"
  };
}

function repository(
  plan: MemorySynthesisPlan,
  staged: ReturnType<typeof result> | null = null
) {
  return {
    apply: vi.fn(async () => 1),
    preflight: vi.fn(async () => ({ status: "READY" as const })),
    snapshot: vi.fn(async () => ({
      plan,
      settings: {
        memoryGeneration: 1,
        memoryRevision: 4,
        synthesisEnabled: true,
        synthesisEnabledAt: new Date("2026-08-01T00:00:00.000Z"),
        synthesisPolicyVersion: "memory-synthesis-policy-v3",
        useMemoryFacts: true
      }
    })),
    stage: vi.fn(async () => undefined),
    staged: vi.fn(async () => staged)
  } as unknown as MemorySynthesisRepository;
}

describe("Dream synthesis handler", () => {
  it("[E06] performs one governed synthesis call, stages, reauthorizes, and applies", async () => {
    const plan = synthesisPlan();
    const providerResult = result(plan);
    const repo = repository(plan);
    const authorizeResult = vi.fn(async () => undefined);
    const provider = { synthesize: vi.fn(async () => providerResult) };
    const handler = createMemorySynthesisHandler({
      authorizeResult,
      provider,
      repository: repo
    });
    const job = claim();
    const execution = await handler.execute(job, {
      now: () => NOW,
      setStage: vi.fn(async () => undefined),
      signal: new AbortController().signal
    });

    expect(provider.synthesize).toHaveBeenCalledOnce();
    expect(repo.stage).toHaveBeenCalledOnce();
    await execution.apply?.({} as Prisma.TransactionClient, job);
    expect(authorizeResult).toHaveBeenCalledOnce();
    expect(repo.apply).toHaveBeenCalledOnce();
    expect(execution.acceptedResultHash).toBe(providerResult.acceptedOutputHash);
  });

  it("[E06] recovers staged synthesis with zero additional provider calls", async () => {
    const plan = synthesisPlan();
    const staged = result(plan);
    const repo = repository(plan, staged);
    const provider = { synthesize: vi.fn() };
    const handler = createMemorySynthesisHandler({
      authorizeResult: vi.fn(async () => undefined),
      provider,
      repository: repo
    });
    const job = claim({ recoveredLease: true });
    const execution = await handler.execute(job, {
      now: () => NOW,
      setStage: vi.fn(async () => undefined),
      signal: new AbortController().signal
    });

    expect(provider.synthesize).not.toHaveBeenCalled();
    expect(repo.stage).not.toHaveBeenCalled();
    await execution.apply?.({} as Prisma.TransactionClient, job);
    expect(repo.apply).toHaveBeenCalledOnce();
  });

  it("fails safe on ambiguous recovered I/O and never replays the call", async () => {
    const plan = synthesisPlan();
    const repo = repository(plan);
    const provider = { synthesize: vi.fn() };
    const handler = createMemorySynthesisHandler({ provider, repository: repo });
    const execution = await handler.execute(claim({ recoveredLease: true }), {
      now: () => NOW,
      setStage: vi.fn(async () => undefined),
      signal: new AbortController().signal
    });

    expect(provider.synthesize).not.toHaveBeenCalled();
    expect(execution.apply).toBeUndefined();
    expect(execution.stage).toBe("synthesis_outcome_unknown");
  });

  it("leaves repository state untouched when the provider fails", async () => {
    const plan = synthesisPlan();
    const repo = repository(plan);
    const handler = createMemorySynthesisHandler({
      provider: { synthesize: vi.fn(async () => { throw new Error("offline"); }) },
      repository: repo
    });

    await expect(handler.execute(claim(), {
      now: () => NOW,
      setStage: vi.fn(async () => undefined),
      signal: new AbortController().signal
    })).rejects.toMatchObject({
      code: "memory_synthesis_provider_unavailable",
      retryable: false
    });
    expect(repo.stage).not.toHaveBeenCalled();
    expect(repo.apply).not.toHaveBeenCalled();
  });
});
