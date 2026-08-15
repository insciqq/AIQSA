import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { memorySha256 } from "../../persistence/lexical";
import type { MemoryJobClaim } from "../../coordinator/types";
import { MemoryExecutionError } from "../../execution";
import {
  MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
  MEMORY_FACT_SOURCE_PROJECTION_VERSION,
  memoryFactExtractionInputHash,
  memoryFactExtractionJobFingerprint,
  type MemoryFactExtractionInput,
  type MemoryFactSourceIdentity
} from "./contract";
import {
  createMemoryFactExtractionHandler,
  type MemoryFactExtractionHandlerDependencies
} from "./handler";
import { MEMORY_FACT_EXTRACTION_TOOL_NAME } from "./prompt";

const source: MemoryFactSourceIdentity = {
  activeLeafMessageId: "assistant-1",
  branchGeneration: 1,
  chatId: "chat-1",
  sourceHash: "a".repeat(64),
  sourceRevision: 3,
  userId: "user-1"
};

function extractionInput(): MemoryFactExtractionInput {
  const text = "I prefer tea.";
  const withoutHash: Omit<MemoryFactExtractionInput, "inputHash"> = {
    folderId: null,
    messages: [{
      contentHash: memorySha256(text),
      createdAt: "2026-08-11T09:00:00.000Z",
      id: "message-1",
      languageCode: "en",
      text,
      updatedAt: "2026-08-11T09:00:00.000Z"
    }],
    source,
    sourceProjectionHash: "b".repeat(64),
    sourceProjectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION,
    suppressionIdentitySnapshot: "c".repeat(64),
    timeZone: "UTC"
  };
  return { ...withoutHash, inputHash: memoryFactExtractionInputHash(withoutHash) };
}

function claim(): MemoryJobClaim {
  return {
    activeLeafMessageId: source.activeLeafMessageId,
    attemptCount: 1,
    branchGeneration: source.branchGeneration,
    chatId: source.chatId,
    claimToken: randomUUID(),
    id: randomUUID(),
    idempotencyFingerprint: memoryFactExtractionJobFingerprint(source),
    kind: "EXTRACT_FACTS",
    leaseExpiresAt: new Date("2026-08-11T12:05:00.000Z"),
    memoryGenerationSnapshot: 0,
    memoryRevisionSnapshot: 1,
    pipelineVersion: MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
    recoveredLease: false,
    sourceHash: source.sourceHash,
    sourceRevision: source.sourceRevision,
    stage: null,
    userId: source.userId
  };
}

function providerOutput(
  displayText = "The user prefers tea.",
  evidenceEnd = "I prefer tea.".length
) {
  return {
    providerResponseId: "response-1",
    toolCalls: [{
      arguments: {
        decision: "STORE",
        candidates: [{
          core_eligible: true,
          core_salience: "MEDIUM",
          directness: "DIRECT",
          display_text: displayText,
          evidence: [{
            end_offset: evidenceEnd,
            message_id: "message-1",
            start_offset: 0
          }],
          language: "en",
          modality: "PREFERENCE",
          raw_temporal_expression: null,
          scope: { target_id: null, type: "GLOBAL_USER" },
          sensitivity: "NORMAL",
          structured_value: JSON.stringify({ drink: "tea" }),
          valid_from: null,
          valid_to: null
        }]
      },
      id: "call-1",
      name: MEMORY_FACT_EXTRACTION_TOOL_NAME
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

function dependencies(
  overrides: Partial<MemoryFactExtractionHandlerDependencies> = {}
) {
  const input = extractionInput();
  const bind = vi.fn(async () => ({ id: "binding-1" }));
  const start = vi.fn(async () => ({
    bindingId: "binding-1",
    snapshot: {
      logicalRole: "MEMORY_FACT_EXTRACT",
      providerExecutionSnapshot: {
        connectionId: "connection-1",
        credentialId: "credential-1",
        credentialVersionId: "credential-version-1",
        providerModelId: "model-1"
      },
      requiresStrictStructuredOutput: true
    }
  }));
  const settle = vi.fn(async () => ({ state: "SUCCEEDED" }));
  const run = vi.fn(async () => providerOutput());
  const apply = vi.fn(async () => "APPLIED" as const);
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
    now: () => new Date("2026-08-11T12:00:00.000Z"),
    probeAuthority: vi.fn(async () => undefined),
    provider: { run },
    repository: {
      applied: vi.fn(async () => false),
      apply,
      bindings: vi.fn(async () => []),
      preflight: vi.fn(async () => ({ status: "READY" as const })),
      prepare: vi.fn(async () => ({ input }))
    }
  } as unknown as MemoryFactExtractionHandlerDependencies;
  return {
    apply,
    base: { ...base, ...overrides } as MemoryFactExtractionHandlerDependencies,
    bind,
    input,
    run,
    settle,
    start
  };
}

function context() {
  return {
    now: () => new Date("2026-08-11T12:00:00.000Z"),
    setStage: vi.fn(async () => undefined),
    signal: new AbortController().signal
  };
}

describe("Memory fact extraction handler", () => {
  it("parks missing consent or runtime capability before provider I/O", async () => {
    for (const code of [
      "memory_execution_egress_consent_required",
      "memory_execution_capability_unavailable",
      "memory_execution_target_unavailable"
    ] as const) {
      const fixture = dependencies({
        probeAuthority: vi.fn(async () => { throw new MemoryExecutionError(code); })
      });
      await expect(createMemoryFactExtractionHandler(fixture.base).preflight(claim()))
        .resolves.toEqual({ errorCode: code, status: "WAITING_FOR_EGRESS_CONSENT" });
      expect(fixture.bind).not.toHaveBeenCalled();
      expect(fixture.run).not.toHaveBeenCalled();
    }
  });

  it("binds before one strict call, accounts usage, and applies atomically", async () => {
    const fixture = dependencies();
    const result = await createMemoryFactExtractionHandler(fixture.base)
      .execute(claim(), context());
    expect(result.stage).toBe("fact_candidates_ready");
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
  });

  it("rejects invalid evidence bounds after accounting usage and writes no candidate", async () => {
    const fixture = dependencies({
      provider: { run: vi.fn(async () => providerOutput("A grounded paraphrase.", 500)) }
    });
    const result = await createMemoryFactExtractionHandler(fixture.base)
      .execute(claim(), context());
    expect(result.stage).toBe("fact_output_rejected");
    expect(fixture.settle).toHaveBeenCalledWith(
      source.userId,
      "binding-1",
      expect.objectContaining({ state: "FAILED" })
    );
    expect(fixture.apply).not.toHaveBeenCalled();
  });

  it("never replays a recovered RUNNING provider call", async () => {
    const fixture = dependencies();
    const handler = createMemoryFactExtractionHandler({
      ...fixture.base,
      repository: {
        ...fixture.base.repository,
        bindings: vi.fn(async () => [{
          acceptedOutputHash: null,
          id: "old-binding",
          inputHash: fixture.input.inputHash,
          ordinal: 0,
          secretFreeExecutionSnapshot: {},
          state: "RUNNING" as const
        }])
      }
    });
    await expect(handler.execute(claim(), context())).resolves.toMatchObject({
      stage: "fact_outcome_unknown"
    });
    expect(fixture.settle).toHaveBeenCalledWith(
      source.userId,
      "old-binding",
      expect.objectContaining({ state: "OUTCOME_UNKNOWN" })
    );
    expect(fixture.run).not.toHaveBeenCalled();
  });
});
