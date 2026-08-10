import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { MemoryJobClaim } from "../../coordinator/types";
import { MemoryExecutionError } from "../../execution";
import {
  MEMORY_EPISODE_EXTRACTION_PIPELINE_VERSION,
  memoryEpisodeExtractionInputHash,
  memoryEpisodeExtractionJobFingerprint,
  memoryEpisodeSourceWindowHash,
  type MemoryEpisodeExtractionInput,
  type MemoryEpisodeSourceIdentity
} from "./contract";
import {
  createMemoryEpisodeExtractionHandler,
  type MemoryEpisodeExtractionHandlerDependencies
} from "./handler";
import { MEMORY_EPISODE_TOOL_NAME } from "./prompt";
import { MemoryEpisodeProviderCallError } from "./runtime";

const source: MemoryEpisodeSourceIdentity = {
  activeLeafMessageId: "message-2",
  branchGeneration: 0,
  chatId: "chat-1",
  sourceHash: "a".repeat(64),
  sourceRevision: 2,
  userId: "user-1"
};

function extractionInput(): MemoryEpisodeExtractionInput {
  const chunks = [{
    contentHash: "b".repeat(64),
    id: "chunk-1",
    languageCode: "en" as const,
    messageIds: ["message-1", "message-2"],
    occurredFrom: "2026-08-10T09:00:00.000Z",
    occurredTo: "2026-08-10T09:01:00.000Z",
    ordinal: 0,
    redactionReasonCodes: [],
    redactionState: "NOT_NEEDED" as const,
    safeProjectedText: "The deployment uses blue-green releases.",
    safetyClass: "NORMAL" as const,
    sourceAssistantId: null,
    sourceFolderId: null,
    sourceProjectionVersion: "memory-history-source-projection-v1"
  }];
  const suppressionIdentitySnapshot = "c".repeat(64);
  const sourceWindowHash = memoryEpisodeSourceWindowHash(
    source,
    chunks,
    suppressionIdentitySnapshot
  );
  const withoutHash = {
    chunks,
    source,
    sourceWindowHash,
    suppressionIdentitySnapshot
  };
  return { ...withoutHash, inputHash: memoryEpisodeExtractionInputHash(withoutHash) };
}

function claim(): MemoryJobClaim {
  return {
    activeLeafMessageId: source.activeLeafMessageId,
    attemptCount: 1,
    branchGeneration: source.branchGeneration,
    chatId: source.chatId,
    claimToken: randomUUID(),
    id: randomUUID(),
    idempotencyFingerprint: memoryEpisodeExtractionJobFingerprint(source),
    kind: "EXTRACT_EPISODE",
    leaseExpiresAt: new Date("2026-08-10T12:05:00.000Z"),
    memoryGenerationSnapshot: 0,
    memoryRevisionSnapshot: 1,
    pipelineVersion: MEMORY_EPISODE_EXTRACTION_PIPELINE_VERSION,
    recoveredLease: false,
    sourceHash: source.sourceHash,
    sourceRevision: source.sourceRevision,
    stage: null,
    userId: source.userId
  };
}

function strictSnapshot() {
  return {
    logicalRole: "MEMORY_EPISODE_EXTRACT",
    providerExecutionSnapshot: {
      connectionId: "connection-1",
      credentialId: "credential-1",
      credentialVersionId: "credential-version-1",
      providerModelId: "model-1"
    },
    requiresStrictStructuredOutput: true
  };
}

function providerOutput() {
  const input = extractionInput();
  return {
    providerResponseId: "response-1",
    toolCalls: [{
      arguments: {
        episodes: [{
          keywords: ["blue-green"],
          language: "en",
          occurred_from: input.chunks[0]!.occurredFrom,
          occurred_to: input.chunks[0]!.occurredTo,
          source_chunk_ids: [input.chunks[0]!.id],
          source_message_ids: [...input.chunks[0]!.messageIds],
          summary: "The deployment uses blue-green releases."
        }]
      },
      id: "call-1",
      name: MEMORY_EPISODE_TOOL_NAME
    }],
    usage: {
      cachedInputTokens: 2,
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 1,
      totalTokens: 15
    }
  };
}

function dependencies(overrides: Partial<MemoryEpisodeExtractionHandlerDependencies> = {}) {
  const input = extractionInput();
  const bind = vi.fn(async () => ({ id: "binding-1" }));
  const start = vi.fn(async () => ({
    bindingId: "binding-1",
    snapshot: strictSnapshot()
  }));
  const settle = vi.fn(async () => ({ state: "SUCCEEDED" }));
  const run = vi.fn(async () => providerOutput());
  const apply = vi.fn(async () => "APPLIED" as const);
  const markDegraded = vi.fn(async () => undefined);
  const base = {
    execution: {
      admission: { bind, start },
      lifecycle: {
        settle,
        withAuthorizedResultCommit: vi.fn(async (
          _userId: string,
          _result: unknown,
          commit: (tx: never, evidence: never) => Promise<unknown>
        ) => commit({} as never, { settings: { userId: source.userId } } as never))
      }
    },
    now: () => new Date("2026-08-10T12:00:00.000Z"),
    probeAuthority: vi.fn(async () => undefined),
    provider: { run },
    repository: {
      alreadyApplied: vi.fn(async () => false),
      apply,
      bindings: vi.fn(async () => []),
      markComplete: vi.fn(async () => undefined),
      markDegraded,
      preflight: vi.fn(async () => ({ status: "READY" as const })),
      prepare: vi.fn(async () => ({ input }))
    }
  } as unknown as MemoryEpisodeExtractionHandlerDependencies;
  return {
    apply,
    base: { ...base, ...overrides } as MemoryEpisodeExtractionHandlerDependencies,
    bind,
    input,
    markDegraded,
    run,
    settle,
    start
  };
}

function context() {
  return {
    now: () => new Date("2026-08-10T12:00:00.000Z"),
    setStage: vi.fn(async () => undefined),
    signal: new AbortController().signal
  };
}

describe("Memory qualified episode extraction handler", () => {
  it("parks missing consent or qualification before binding and provider I/O", async () => {
    for (const code of [
      "memory_execution_egress_consent_required",
      "memory_execution_qualification_required",
      "memory_execution_target_unavailable"
    ] as const) {
      const fixture = dependencies({
        probeAuthority: vi.fn(async () => { throw new MemoryExecutionError(code); })
      });
      const handler = createMemoryEpisodeExtractionHandler(fixture.base);
      await expect(handler.preflight(claim())).resolves.toEqual({
        errorCode: code,
        status: "WAITING_FOR_EGRESS_CONSENT"
      });
      expect(fixture.bind).not.toHaveBeenCalled();
      expect(fixture.run).not.toHaveBeenCalled();
    }
  });

  it("binds and starts before one strict provider call, settles usage, then authorizes apply", async () => {
    const fixture = dependencies();
    const result = await createMemoryEpisodeExtractionHandler(fixture.base)
      .execute(claim(), context());
    expect(result.stage).toBe("episode_ready");
    expect(fixture.bind).toHaveBeenCalledTimes(1);
    expect(fixture.start).toHaveBeenCalledTimes(1);
    expect(fixture.run).toHaveBeenCalledTimes(1);
    expect(fixture.bind.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.start.mock.invocationCallOrder[0]!
    );
    expect(fixture.start.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.run.mock.invocationCallOrder[0]!
    );
    expect(fixture.settle).toHaveBeenCalledWith(
      source.userId,
      "binding-1",
      expect.objectContaining({
        state: "SUCCEEDED",
        usage: expect.objectContaining({ completeness: "COMPLETE", totalTokens: 15 })
      })
    );
    expect(fixture.apply).toHaveBeenCalledTimes(1);
    expect(fixture.markDegraded).not.toHaveBeenCalled();
  });

  it("rejects invented output after accounting usage and commits no episode", async () => {
    const fixture = dependencies({
      provider: {
        run: vi.fn(async () => ({
          ...providerOutput(),
          toolCalls: [{
            ...providerOutput().toolCalls[0]!,
            arguments: {
              episodes: [{
                ...providerOutput().toolCalls[0]!.arguments.episodes[0],
                summary: "The deployment secretly uses canary releases."
              }]
            }
          }]
        }))
      }
    });
    const result = await createMemoryEpisodeExtractionHandler(fixture.base)
      .execute(claim(), context());
    expect(result.stage).toBe("episode_output_rejected");
    expect(fixture.settle).toHaveBeenCalledWith(
      source.userId,
      "binding-1",
      expect.objectContaining({ state: "FAILED" })
    );
    expect(fixture.apply).not.toHaveBeenCalled();
    expect(fixture.markDegraded).toHaveBeenCalledTimes(1);
  });

  it("degrades ambiguous outages and recovered RUNNING calls without replay", async () => {
    const outage = dependencies({
      provider: {
        run: vi.fn(async () => {
          throw new MemoryEpisodeProviderCallError({
            inputTokens: 7,
            outputTokens: 0,
            reasoningTokens: 0
          });
        })
      }
    });
    const outageResult = await createMemoryEpisodeExtractionHandler(outage.base)
      .execute(claim(), context());
    expect(outageResult.stage).toBe("episode_outcome_unknown");
    expect(outage.settle).toHaveBeenCalledWith(
      source.userId,
      "binding-1",
      expect.objectContaining({ state: "OUTCOME_UNKNOWN" })
    );
    expect(outage.apply).not.toHaveBeenCalled();

    const recovered = dependencies();
    const recoveredClaim = claim();
    const recoveredHandler = createMemoryEpisodeExtractionHandler({
      ...recovered.base,
      repository: {
        ...recovered.base.repository,
        bindings: vi.fn(async () => [{
          acceptedOutputHash: null,
          id: "old-binding",
          inputHash: recovered.input.inputHash,
          ordinal: 0,
          secretFreeExecutionSnapshot: {},
          state: "RUNNING" as const
        }])
      }
    });
    const recoveredResult = await recoveredHandler.execute(recoveredClaim, context());
    expect(recoveredResult.stage).toBe("episode_outcome_unknown");
    expect(recovered.settle).toHaveBeenCalledWith(
      source.userId,
      "old-binding",
      expect.objectContaining({ state: "OUTCOME_UNKNOWN" })
    );
    expect(recovered.run).not.toHaveBeenCalled();
  });
});
