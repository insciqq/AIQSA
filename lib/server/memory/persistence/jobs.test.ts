import { describe, expect, it, vi } from "vitest";
import { enqueueMemoryJob, type MemoryJobEnqueueInput } from "./jobs";
import type { LockedMemorySettings, MemoryTransaction } from "./transaction";

const settings = {
  acceptedUtilityEgressAt: null,
  acceptedUtilityEgressFingerprint: null,
  acceptedUtilityPolicyVersion: null,
  activeIndexGenerationId: null,
  decayEnabled: false,
  decayPolicyVersion: null,
  embeddingProviderModelId: null,
  learnAutomatically: true,
  memoryConsentRevision: 0,
  memoryGeneration: 0,
  memoryRevision: 0,
  referenceChatHistory: true,
  sensitiveAutomaticPolicy: "EXPLICIT_ONLY",
  settingsRevision: 0,
  synthesisEnabled: false,
  synthesisEnabledAt: null,
  synthesisPolicyVersion: null,
  lastSynthesisAt: null,
  useMemoryFacts: true,
  userId: "user-1"
} satisfies LockedMemorySettings;

describe("Memory job enqueue boundary", () => {
  const explicitRelation = {
    idempotencyFingerprint: "explicit-version-fingerprint",
    kind: "RESOLVE_FACT_RELATIONS",
    pipelineVersion: "memory-explicit-relation-v1",
    targetFactVersionId: "explicit-version-1"
  } satisfies MemoryJobEnqueueInput;
  const directSource = {
    activeLeafMessageId: "user-message-1",
    branchGeneration: 0,
    chatId: "chat-1",
    sourceHash: "a".repeat(64),
    sourceMessageId: "user-message-1",
    sourceRevision: 1
  };

  it("enqueues an explicit-version comparison without manufacturing a chat source", async () => {
    const memoryJob = {
      create: vi.fn().mockResolvedValue({
        id: "explicit-job", memoryGenerationSnapshot: 0,
        memoryRevisionSnapshot: 0, state: "QUEUED"
      }),
      findUnique: vi.fn().mockResolvedValue(null)
    };
    await expect(enqueueMemoryJob(
      { memoryJob } as unknown as MemoryTransaction, settings, explicitRelation
    )).resolves.toMatchObject({ created: true, id: "explicit-job" });
    const persisted = memoryJob.create.mock.calls[0]![0].data;
    expect(persisted).toMatchObject({
      userId: "user-1", kind: "RESOLVE_FACT_RELATIONS",
      pipelineVersion: "memory-explicit-relation-v1",
      targetFactVersionId: "explicit-version-1"
    });
    for (const field of ["chatId", "sourceMessageId", "activeLeafMessageId",
      "sourceHash", "sourceRevision", "branchGeneration"]) {
      expect(persisted).not.toHaveProperty(field);
    }
  });

  it.each([
    ["explicit comparison with a chat", { ...explicitRelation, source: directSource }],
    ["explicit comparison without a version", { ...explicitRelation, targetFactVersionId: undefined }],
    ["direct comparison without a source", { ...explicitRelation, pipelineVersion: "memory-fact-relation-v2" }],
    ["unrecognized relation protocol", { ...explicitRelation, pipelineVersion: "unrecognized", source: directSource }]
  ] satisfies Array<[string, MemoryJobEnqueueInput]>)("rejects %s before persistence", async (_name, input) => {
    const memoryJob = { create: vi.fn(), findUnique: vi.fn() };
    await expect(enqueueMemoryJob(
      { memoryJob } as unknown as MemoryTransaction, settings, input
    )).rejects.toThrow("memory_input_invalid");
    expect(memoryJob.findUnique).not.toHaveBeenCalled();
    expect(memoryJob.create).not.toHaveBeenCalled();
  });

  it("retains immutable explicit version ownership on replay", async () => {
    const memoryJob = {
      create: vi.fn(),
      findUnique: vi.fn().mockResolvedValue({
        ...explicitRelation, id: "explicit-job", state: "SUCCEEDED",
        memoryGenerationSnapshot: 0, memoryRevisionSnapshot: 0,
        chatId: null, sourceMessageId: null, activeLeafMessageId: null,
        sourceHash: null, sourceRevision: null, branchGeneration: null
      })
    };
    const tx = { memoryJob } as unknown as MemoryTransaction;
    await expect(enqueueMemoryJob(tx, settings, explicitRelation))
      .resolves.toMatchObject({ created: false, id: "explicit-job", state: "SUCCEEDED" });
    await expect(enqueueMemoryJob(tx, settings, {
      ...explicitRelation, targetFactVersionId: "replacement-version"
    })).rejects.toThrow("memory_idempotency_conflict");
    expect(memoryJob.create).not.toHaveBeenCalled();
  });

  it("rejects retired coordinator kinds before touching the database", async () => {
    const memoryJob = {
      create: vi.fn(),
      findUnique: vi.fn()
    };
    const tx = { memoryJob } as unknown as MemoryTransaction;

    await expect(enqueueMemoryJob(tx, settings, {
      idempotencyFingerprint: "job-fingerprint",
      kind: "RECONCILE_BRANCH",
      pipelineVersion: "memory-test-v1"
    })).rejects.toThrow("memory_input_invalid");
    expect(memoryJob.findUnique).not.toHaveBeenCalled();
    expect(memoryJob.create).not.toHaveBeenCalled();
  });

  it("requires an immutable direct-user source for extraction jobs", async () => {
    const memoryJob = {
      create: vi.fn(),
      findUnique: vi.fn()
    };
    const tx = { memoryJob } as unknown as MemoryTransaction;

    await expect(enqueueMemoryJob(tx, settings, {
      idempotencyFingerprint: "extract-fingerprint",
      kind: "EXTRACT_FACTS",
      pipelineVersion: "memory-fact-extraction-vnext-v2",
      source: {
        activeLeafMessageId: "assistant-1",
        branchGeneration: 0,
        chatId: "chat-1",
        sourceHash: "a".repeat(64),
        sourceRevision: 0
      }
    })).rejects.toThrow("memory_input_invalid");
    expect(memoryJob.findUnique).not.toHaveBeenCalled();
    expect(memoryJob.create).not.toHaveBeenCalled();
  });

  it("keeps the current vNext extraction pipeline on that same source fence", async () => {
    const memoryJob = {
      create: vi.fn(),
      findUnique: vi.fn()
    };
    const tx = { memoryJob } as unknown as MemoryTransaction;

    await expect(enqueueMemoryJob(tx, settings, {
      idempotencyFingerprint: "extract-v8-fingerprint",
      kind: "EXTRACT_FACTS",
      pipelineVersion: "memory-fact-extraction-vnext-v8",
      source: {
        activeLeafMessageId: "assistant-1",
        branchGeneration: 0,
        chatId: "chat-1",
        sourceHash: "a".repeat(64),
        sourceRevision: 0
      }
    })).rejects.toThrow("memory_input_invalid");
    expect(memoryJob.findUnique).not.toHaveBeenCalled();
    expect(memoryJob.create).not.toHaveBeenCalled();
  });

  it("does not retroactively require source messages for legacy pipelines", async () => {
    const memoryJob = {
      create: vi.fn().mockResolvedValue({
        id: "legacy-job",
        memoryGenerationSnapshot: 0,
        memoryRevisionSnapshot: 0,
        state: "QUEUED"
      }),
      findUnique: vi.fn().mockResolvedValue(null)
    };
    const tx = { memoryJob } as unknown as MemoryTransaction;

    await expect(enqueueMemoryJob(tx, settings, {
      idempotencyFingerprint: "legacy-extract-fingerprint",
      kind: "EXTRACT_FACTS",
      pipelineVersion: "memory-fact-extraction-v1"
    })).resolves.toMatchObject({ created: true, id: "legacy-job" });
    expect(memoryJob.create).toHaveBeenCalledOnce();
  });

  it("allows a synthesis job to target one existing pattern", async () => {
    const memoryJob = {
      create: vi.fn().mockResolvedValue({
        id: "targeted-synthesis-job",
        memoryGenerationSnapshot: 0,
        memoryRevisionSnapshot: 0,
        state: "QUEUED"
      }),
      findUnique: vi.fn().mockResolvedValue(null)
    };
    const tx = { memoryJob } as unknown as MemoryTransaction;

    await expect(enqueueMemoryJob(tx, settings, {
      idempotencyFingerprint: "targeted-synthesis-fingerprint",
      kind: "SYNTHESIZE_MEMORIES",
      pipelineVersion: "memory-synthesis-v2",
      targetFactVersionId: "pattern-version-1"
    })).resolves.toMatchObject({
      created: true,
      id: "targeted-synthesis-job"
    });
    expect(memoryJob.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        targetFactVersionId: "pattern-version-1"
      })
    }));
  });

  it("rejects a target on job kinds without a target contract", async () => {
    const memoryJob = {
      create: vi.fn(),
      findUnique: vi.fn()
    };
    const tx = { memoryJob } as unknown as MemoryTransaction;

    await expect(enqueueMemoryJob(tx, settings, {
      idempotencyFingerprint: "targeted-rebuild-fingerprint",
      kind: "REBUILD_INDEX",
      pipelineVersion: "memory-index-rebuild-v1",
      targetFactVersionId: "pattern-version-1"
    })).rejects.toThrow("memory_input_invalid");
    expect(memoryJob.findUnique).not.toHaveBeenCalled();
    expect(memoryJob.create).not.toHaveBeenCalled();
  });

  it("treats changed chat audit snapshots as the same per-message extraction job", async () => {
    const memoryJob = {
      create: vi.fn(),
      findUnique: vi.fn().mockResolvedValue({
        activeLeafMessageId: "assistant-original",
        branchGeneration: 0,
        chatId: "chat-1",
        id: "job-1",
        kind: "EXTRACT_FACTS",
        memoryGenerationSnapshot: 0,
        memoryRevisionSnapshot: 0,
        pipelineVersion: "memory-fact-extraction-vnext-v2",
        sourceHash: "a".repeat(64),
        sourceMessageId: "user-message-1",
        sourceRevision: 1,
        state: "QUEUED",
        targetFactVersionId: null
      })
    };
    const tx = { memoryJob } as unknown as MemoryTransaction;

    await expect(enqueueMemoryJob(tx, settings, {
      idempotencyFingerprint: "extract-fingerprint",
      kind: "EXTRACT_FACTS",
      pipelineVersion: "memory-fact-extraction-vnext-v2",
      source: {
        activeLeafMessageId: "assistant-later-audit",
        branchGeneration: 3,
        chatId: "chat-1",
        sourceHash: "b".repeat(64),
        sourceMessageId: "user-message-1",
        sourceRevision: 9
      }
    })).resolves.toEqual({
      created: false,
      id: "job-1",
      memoryGenerationSnapshot: 0,
      memoryRevisionSnapshot: 0,
      state: "QUEUED"
    });
    expect(memoryJob.create).not.toHaveBeenCalled();
  });
});
