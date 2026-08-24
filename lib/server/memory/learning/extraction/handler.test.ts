import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { memorySha256 } from "../../persistence/lexical";
import { MemoryCoordinatorError } from "../../coordinator/errors";
import type { MemoryJobClaim } from "../../coordinator/types";
import { MemoryExecutionError } from "../../execution";
import {
  MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
  MEMORY_FACT_SOURCE_PROJECTION_VERSION,
  memoryFactExtractionInputHash,
  memoryFactExtractionJobFingerprint,
  type MemoryFactExtractionPlan,
  type MemoryFactExtractionInput,
  type MemoryFactSourceIdentity
} from "./contract";
import {
  createMemoryFactExtractionHandler,
  type MemoryFactExtractionHandlerDependencies
} from "./handler";
import { MEMORY_FACT_EXTRACTION_TOOL_NAME } from "./prompt";
import { MemoryFactProviderCallError } from "./runtime";

const source: MemoryFactSourceIdentity = {
  activeLeafMessageId: "assistant-1",
  branchGeneration: 1,
  chatId: "chat-1",
  memoryGenerationSnapshot: 0,
  sourceHash: "a".repeat(64),
  sourceMessageId: "message-1",
  sourceRevision: 3,
  userId: "user-1"
};

function extractionInput(text = "I prefer tea."): MemoryFactExtractionInput {
  const withoutHash: Omit<MemoryFactExtractionInput, "inputHash"> = {
    contextRefs: [],
    folderId: null,
    messages: [{
      contentHash: memorySha256(text),
      createdAt: "2026-08-11T09:00:00.000Z",
      evidenceEligible: true,
      id: "message-1",
      languageCode: "en",
      role: "user",
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
    sourceMessageId: source.sourceMessageId,
    sourceRevision: source.sourceRevision,
    stage: null,
    targetFactVersionId: null,
    userId: source.userId
  };
}

function providerOutput(
  displayText = "The user prefers tea.",
  quote = "I prefer tea."
) {
  return {
    providerResponseId: "response-1",
    toolCalls: [{
      arguments: {
        observations: [{
          confidence_band: "HIGH",
          correction: false,
          dependency_refs: [],
          entities: [],
          future_useful: true,
          identity: {
            dimension_key: "topic:tea",
            mode: "SLOT",
            predicate_key: "preference",
            subject: {
              canonical_label: null,
              entity_type: "PERSON_SELF",
              qualifiers: { brand: null, model: null }
            }
          },
          memory_type: "PREFERENCE",
          quote,
          reason_code: "durable_preference",
          sensitivity: "NORMAL",
          statement: displayText,
          temporal: {
            expected_at: null,
            expires_at: null,
            occurred_at: null,
            raw_expression: null,
            valid_from: null,
            valid_to: null
          },
          temporary: false,
          value: {
            frequency: null,
            kind: null,
            limit: null,
            place: null,
            role: null,
            schedule: null,
            state: null,
            strength: "normal",
            value: "tea"
          }
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
  const apply = vi.fn(async (
    _tx: unknown,
    _settings: unknown,
    _claim: unknown,
    plan: MemoryFactExtractionPlan
  ) => plan.candidates.length > 0 ? "APPLIED" as const : "EMPTY" as const);
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
      applied: vi.fn(async () => null),
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

function providerFailure(
  classification: "UNKNOWN" | "REPLAY_SAFE_TRANSIENT" | "PERMANENT"
): MemoryFactProviderCallError {
  return new MemoryFactProviderCallError({
    cause: new Error("provider_fixture_failure"),
    classification,
    usage: null
  });
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
    expect(result.stage).toBe("fact_observations_committed");
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

  it("isolates invalid evidence after accounting usage and writes no observation", async () => {
    const fixture = dependencies({
      provider: {
        run: vi.fn(async () => providerOutput(
          "A grounded paraphrase.",
          "This quote is not present."
        ))
      }
    });
    const result = await createMemoryFactExtractionHandler(fixture.base)
      .execute(claim(), context());
    expect(result.stage).toBe("fact_observations_empty");
    expect(fixture.settle).toHaveBeenCalledWith(
      source.userId,
      "binding-1",
      expect.objectContaining({ state: "SUCCEEDED" })
    );
    expect(fixture.apply).toHaveBeenCalledOnce();
  });

  it("reports an accepted proposal as empty when conservative apply writes nothing", async () => {
    const fixture = dependencies();
    fixture.apply.mockResolvedValueOnce("EMPTY");
    const result = await createMemoryFactExtractionHandler(fixture.base)
      .execute(claim(), context());
    expect(result.stage).toBe("fact_observations_empty");
    expect(fixture.settle).toHaveBeenCalledWith(
      source.userId,
      "binding-1",
      expect.objectContaining({ state: "SUCCEEDED" })
    );
  });

  it("terminalizes a structurally invalid provider packet without applying content", async () => {
    const valid = providerOutput();
    const fixture = dependencies({
      provider: {
        run: vi.fn(async () => ({
          ...valid,
          toolCalls: [{
            arguments: { observations: "invalid" },
            id: "invalid-call",
            name: MEMORY_FACT_EXTRACTION_TOOL_NAME
          }]
        }))
      }
    });

    await expect(createMemoryFactExtractionHandler(fixture.base)
      .execute(claim(), context())).resolves.toMatchObject({
      stage: "fact_output_rejected"
    });
    expect(fixture.settle).toHaveBeenCalledWith(
      source.userId,
      "binding-1",
      expect.objectContaining({
        errorCode: "memory_fact_output_invalid",
        state: "FAILED"
      })
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

  it("recovers an authorized zero-write apply as an empty extraction", async () => {
    const fixture = dependencies();
    const handler = createMemoryFactExtractionHandler({
      ...fixture.base,
      repository: {
        ...fixture.base.repository,
        applied: vi.fn(async () => "EMPTY" as const),
        bindings: vi.fn(async () => [{
          acceptedOutputHash: "d".repeat(64),
          id: "old-binding",
          inputHash: fixture.input.inputHash,
          ordinal: 0,
          secretFreeExecutionSnapshot: {},
          state: "SUCCEEDED" as const
        }])
      }
    });
    await expect(handler.execute(claim(), context())).resolves.toMatchObject({
      stage: "fact_observations_empty"
    });
    expect(fixture.run).not.toHaveBeenCalled();
  });

  it("fences a recognizable secret before binding or provider egress", async () => {
    const fixture = dependencies();
    const secretInput = extractionInput(
      "My API key is sk-abcdefghijklmnopqrstuvwxyz123456."
    );
    const handler = createMemoryFactExtractionHandler({
      ...fixture.base,
      repository: {
        ...fixture.base.repository,
        prepare: vi.fn(async () => ({ input: secretInput }))
      }
    });

    await expect(handler.execute(claim(), context())).resolves.toMatchObject({
      stage: "fact_secret_source_fenced"
    });
    expect(fixture.bind).not.toHaveBeenCalled();
    expect(fixture.run).not.toHaveBeenCalled();
  });

  it("settles a replay-safe transient attempt before a new binding succeeds", async () => {
    const fixture = dependencies();
    const bindings: Array<{
      acceptedOutputHash: string | null;
      id: string;
      inputHash: string;
      ordinal: number;
      secretFreeExecutionSnapshot: Record<string, never>;
      state: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "OUTCOME_UNKNOWN";
    }> = [];
    const bind = vi.fn(async (_userId: string, request: {
      inputHash: string;
      ordinal: number;
    }) => {
      const id = `binding-${request.ordinal + 1}`;
      bindings.push({
        acceptedOutputHash: null,
        id,
        inputHash: request.inputHash,
        ordinal: request.ordinal,
        secretFreeExecutionSnapshot: {},
        state: "PENDING"
      });
      return { id };
    });
    const start = vi.fn(async (_userId: string, bindingId: string) => {
      const binding = bindings.find((candidate) => candidate.id === bindingId)!;
      binding.state = "RUNNING";
      return {
        bindingId,
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
      };
    });
    const settle = vi.fn(async (_userId: string, bindingId: string, result: {
      acceptedOutputHash: string | null;
      state: "SUCCEEDED" | "FAILED" | "OUTCOME_UNKNOWN";
    }) => {
      const binding = bindings.find((candidate) => candidate.id === bindingId)!;
      binding.acceptedOutputHash = result.acceptedOutputHash;
      binding.state = result.state;
      return { state: result.state };
    });
    const run = vi.fn()
      .mockRejectedValueOnce(providerFailure("REPLAY_SAFE_TRANSIENT"))
      .mockResolvedValueOnce(providerOutput());
    const handler = createMemoryFactExtractionHandler({
      ...fixture.base,
      execution: {
        ...fixture.base.execution,
        admission: { ...fixture.base.execution.admission, bind, start },
        lifecycle: { ...fixture.base.execution.lifecycle, settle }
      },
      provider: { run },
      repository: {
        ...fixture.base.repository,
        bindings: vi.fn(async () => bindings)
      }
    } as unknown as MemoryFactExtractionHandlerDependencies);
    const firstClaim = claim();

    await expect(handler.execute(firstClaim, context())).rejects.toMatchObject({
      code: "memory_fact_provider_transient",
      retryable: true
    } satisfies Partial<MemoryCoordinatorError>);
    expect(bindings).toMatchObject([{ id: "binding-1", ordinal: 0, state: "FAILED" }]);

    const result = await handler.execute({ ...firstClaim, attemptCount: 2 }, context());
    expect(result.stage).toBe("fact_observations_committed");
    expect(bindings).toMatchObject([
      { id: "binding-1", ordinal: 0, state: "FAILED" },
      { id: "binding-2", ordinal: 1, state: "SUCCEEDED" }
    ]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["UNKNOWN", "OUTCOME_UNKNOWN", "fact_outcome_unknown"],
    ["PERMANENT", "FAILED", "fact_provider_unavailable"]
  ] as const)(
    "terminalizes a %s provider failure without requesting a retry",
    async (classification, state, stage) => {
      const fixture = dependencies({
        provider: { run: vi.fn(async () => { throw providerFailure(classification); }) }
      });

      await expect(createMemoryFactExtractionHandler(fixture.base)
        .execute(claim(), context())).resolves.toMatchObject({ stage });
      expect(fixture.settle).toHaveBeenCalledWith(
        source.userId,
        "binding-1",
        expect.objectContaining({ state })
      );
    }
  );
});
