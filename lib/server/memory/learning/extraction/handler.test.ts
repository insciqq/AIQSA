import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { memorySha256 } from "../../persistence/lexical";
import { MemoryCoordinatorError } from "../../coordinator/errors";
import type { MemoryJobClaim } from "../../coordinator/types";
import { MemoryExecutionError } from "../../execution";
import {
  MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
  MEMORY_FACT_EXTRACTION_VERSIONS,
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
import {
  memorySemanticAdjudicationInput,
  MEMORY_SEMANTIC_ADJUDICATION_VERSIONS
} from "./adjudication";
import { decodeMemoryFactExtraction } from "./decoder";
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

function storedVersions(versions: Readonly<{
  pipelineVersion: string;
  policyVersion: string;
  promptVersion: string;
  schemaVersion: string;
}>) {
  return {
    pipelineVersion: versions.pipelineVersion,
    policyVersion: versions.policyVersion,
    promptVersion: versions.promptVersion,
    schemaVersion: versions.schemaVersion
  };
}

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
          candidate_ref: "C1",
          confidence_band: "HIGH",
          dependency_refs: [],
          entities: [],
          evidence: { occurrence_index: 0, text: quote },
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
          reason_code: "durable_preference",
          semantic_frame: {
            assertion_status: "ASSERTED",
            change_intent: "NONE",
            memory_directive: "NONE",
            polarity: "AFFIRMED",
            speech_act: "ASSERTION",
            subject_scope: "CURRENT_USER",
            temporal_perspective: "CURRENT"
          },
          sensitivity: "NORMAL",
          statement: displayText,
          temporal: {
            expiration_intent: "NONE",
            normalization: { kind: "NONE" },
            perspective: "CURRENT",
            raw_expression: null,
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
  const stage = vi.fn(async () => undefined);
  const settleSucceededWithDurableResult = vi.fn(async (
    _userId: string,
    _bindingId: string,
    _result: unknown,
    persist: (tx: never, evidence: never) => Promise<void>
  ) => {
    await persist({} as never, {
      recoverableUntil: new Date("2026-08-12T12:00:00.000Z")
    } as never);
    return { state: "SUCCEEDED" };
  });
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
        settleSucceededWithDurableResult,
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
      discardStale: vi.fn(async () => 0),
      preflight: vi.fn(async () => ({ status: "READY" as const })),
      prepare: vi.fn(async () => ({ input })),
      stage,
      staged: vi.fn(async () => null)
    }
  } as unknown as MemoryFactExtractionHandlerDependencies;
  return {
    apply,
    base: { ...base, ...overrides } as MemoryFactExtractionHandlerDependencies,
    bind,
    input,
    run,
    settle,
    settleSucceededWithDurableResult,
    stage,
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
    expect(fixture.settleSucceededWithDurableResult).toHaveBeenCalledWith(
      source.userId,
      "binding-1",
      expect.objectContaining({
        state: "SUCCEEDED",
        usage: expect.objectContaining({ completeness: "COMPLETE", totalTokens: 15 })
      }),
      expect.any(Function)
    );
    expect(fixture.stage).toHaveBeenCalledOnce();
    expect(fixture.apply).toHaveBeenCalledTimes(1);
  });

  it("[E02] uses one extraction and one batched high-risk adjudication", async () => {
    const fixture = dependencies();
    const bind = vi.fn()
      .mockResolvedValueOnce({ id: "binding-extraction" })
      .mockResolvedValueOnce({ id: "binding-adjudication" });
    const start = vi.fn(async (_userId: string, bindingId: string) => ({
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
    }));
    const completeAdjudication = vi.fn(async () => undefined);
    const adjudicator = {
      run: vi.fn(async (_evidence, semanticInput) => ({
        providerResponseId: "response-adjudication",
        toolCalls: [{
          arguments: {
            decisions: semanticInput.candidateRefs.map((candidateRef: string) => ({
              assertion_status: "ASSERTED",
              candidate_ref: candidateRef,
              confidence_band: "HIGH",
              entailment: "ENTAILED",
              entity_ref: null,
              operation: "NO_RELATION",
              reason_code: "explicit_preference",
              subject_scope: "CURRENT_USER",
              target_ref: null,
              temporal_perspective: "CURRENT"
            }))
          },
          id: "call-adjudication",
          name: "submit_memory_semantic_adjudications_v1"
        }],
        usage: {
          cachedInputTokens: 0,
          inputTokens: 20,
          outputTokens: 8,
          reasoningTokens: 2,
          totalTokens: 28
        }
      }))
    } satisfies NonNullable<MemoryFactExtractionHandlerDependencies["adjudicator"]>;
    const handler = createMemoryFactExtractionHandler({
      ...fixture.base,
      adjudicator,
      execution: {
        ...fixture.base.execution,
        admission: { bind, start }
      },
      repository: {
        ...fixture.base.repository,
        auxiliary: vi.fn(async () => null),
        completeAdjudication,
        reserveAdjudication: vi.fn(async () => "ACQUIRED" as const)
      }
    } as unknown as MemoryFactExtractionHandlerDependencies);

    await expect(handler.execute(claim(), context())).resolves.toMatchObject({
      stage: "fact_observations_committed"
    });
    expect(fixture.run).toHaveBeenCalledOnce();
    expect(adjudicator.run).toHaveBeenCalledOnce();
    expect(bind).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledTimes(2);
    expect(fixture.settleSucceededWithDurableResult).toHaveBeenCalledTimes(2);
    expect(completeAdjudication).toHaveBeenCalledOnce();
    expect(fixture.apply).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      "binding-extraction",
      expect.any(Date),
      expect.objectContaining({ decisions: [expect.objectContaining({
        candidateRef: "C1",
        operation: "NO_RELATION"
      })] }),
      "binding-adjudication"
    );
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
    expect(fixture.settleSucceededWithDurableResult).toHaveBeenCalledWith(
      source.userId,
      "binding-1",
      expect.objectContaining({ state: "SUCCEEDED" }),
      expect.any(Function)
    );
    expect(fixture.apply).toHaveBeenCalledOnce();
  });

  it("reports an accepted proposal as empty when conservative apply writes nothing", async () => {
    const fixture = dependencies();
    fixture.apply.mockResolvedValueOnce("EMPTY");
    const result = await createMemoryFactExtractionHandler(fixture.base)
      .execute(claim(), context());
    expect(result.stage).toBe("fact_observations_empty");
    expect(fixture.settleSucceededWithDurableResult).toHaveBeenCalledWith(
      source.userId,
      "binding-1",
      expect.objectContaining({ state: "SUCCEEDED" }),
      expect.any(Function)
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
          ...storedVersions(MEMORY_FACT_EXTRACTION_VERSIONS),
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
          ...storedVersions(MEMORY_FACT_EXTRACTION_VERSIONS),
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

  it("[E04] recovers staged accepted output with zero provider calls", async () => {
    const fixture = dependencies();
    const plan = decodeMemoryFactExtraction(
      providerOutput().toolCalls,
      fixture.input
    );
    const handler = createMemoryFactExtractionHandler({
      ...fixture.base,
      repository: {
        ...fixture.base.repository,
        bindings: vi.fn(async () => [{
          acceptedOutputHash: plan.outputHash,
          id: "old-binding",
          inputHash: fixture.input.inputHash,
          ordinal: 0,
          ...storedVersions(MEMORY_FACT_EXTRACTION_VERSIONS),
          secretFreeExecutionSnapshot: {},
          state: "SUCCEEDED" as const
        }]),
        staged: vi.fn(async () => plan)
      }
    });

    await expect(handler.execute(claim(), context())).resolves.toMatchObject({
      acceptedResultHash: plan.outputHash,
      stage: "fact_observations_committed"
    });
    expect(fixture.run).not.toHaveBeenCalled();
    expect(fixture.bind).not.toHaveBeenCalled();
    expect(fixture.apply).toHaveBeenCalledOnce();
  });

  it("recovers extraction separately from an uncertain adjudication binding", async () => {
    const fixture = dependencies();
    const plan = decodeMemoryFactExtraction(
      providerOutput().toolCalls,
      fixture.input
    );
    const adjudicationInput = memorySemanticAdjudicationInput(plan);
    expect(adjudicationInput).not.toBeNull();
    const bindings = [{
      acceptedOutputHash: plan.outputHash,
      id: "old-extraction-binding",
      inputHash: fixture.input.inputHash,
      ordinal: 0,
      ...storedVersions(MEMORY_FACT_EXTRACTION_VERSIONS),
      secretFreeExecutionSnapshot: {},
      state: "SUCCEEDED" as const
    }, {
      acceptedOutputHash: null,
      id: "old-adjudication-binding",
      inputHash: adjudicationInput!.inputHash,
      ordinal: 1,
      ...storedVersions(MEMORY_SEMANTIC_ADJUDICATION_VERSIONS),
      secretFreeExecutionSnapshot: {},
      state: "RUNNING" as const
    }];
    const adjudicator = {
      run: vi.fn(async () => { throw new Error("must_not_replay"); })
    };
    const discardStale = vi.fn(async () => 0);
    const job = claim();
    const handler = createMemoryFactExtractionHandler({
      ...fixture.base,
      adjudicator,
      repository: {
        ...fixture.base.repository,
        auxiliary: vi.fn(async () => ({
          acceptedOutputHash: null,
          completedAt: null,
          executionId: null,
          inputHash: null,
          ownerJobId: job.id,
          purpose: "FACT_EXTRACTION_ADJUDICATION",
          result: null
        })),
        bindings: vi.fn(async () => bindings),
        discardStale,
        reserveAdjudication: vi.fn(async () => "ACQUIRED" as const),
        staged: vi.fn(async () => plan)
      }
    } as unknown as MemoryFactExtractionHandlerDependencies);

    await expect(handler.execute(job, context())).resolves.toMatchObject({
      acceptedResultHash: plan.outputHash,
      stage: "fact_observations_committed"
    });
    expect(discardStale).not.toHaveBeenCalled();
    expect(fixture.run).not.toHaveBeenCalled();
    expect(adjudicator.run).not.toHaveBeenCalled();
    expect(fixture.settle).toHaveBeenCalledWith(
      source.userId,
      "old-adjudication-binding",
      expect.objectContaining({
        errorCode: "memory_semantic_adjudication_outcome_unknown",
        state: "OUTCOME_UNKNOWN"
      })
    );
    expect(fixture.apply).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      plan,
      "old-extraction-binding",
      expect.any(Date),
      null,
      "old-extraction-binding"
    );
  });

  it("retries a succeeded binding whose staged result is missing", async () => {
    const fixture = dependencies();
    const handler = createMemoryFactExtractionHandler({
      ...fixture.base,
      repository: {
        ...fixture.base.repository,
        bindings: vi.fn(async () => [{
          acceptedOutputHash: "d".repeat(64),
          id: "old-binding",
          inputHash: fixture.input.inputHash,
          ordinal: 0,
          ...storedVersions(MEMORY_FACT_EXTRACTION_VERSIONS),
          secretFreeExecutionSnapshot: {},
          state: "SUCCEEDED" as const
        }])
      }
    });

    await expect(handler.execute(claim(), context())).rejects.toMatchObject({
      code: "memory_fact_staged_result_missing",
      retryable: true
    } satisfies Partial<MemoryCoordinatorError>);
    expect(fixture.run).not.toHaveBeenCalled();
  });

  it("keeps apply infrastructure failures retryable after durable staging", async () => {
    const fixture = dependencies();
    const handler = createMemoryFactExtractionHandler({
      ...fixture.base,
      execution: {
        ...fixture.base.execution,
        lifecycle: {
          ...fixture.base.execution.lifecycle,
          withAuthorizedResultCommit: vi.fn(async () => {
            throw new Error("database_transport_failed");
          })
        }
      }
    } as MemoryFactExtractionHandlerDependencies);

    await expect(handler.execute(claim(), context())).rejects.toMatchObject({
      code: "memory_fact_apply_retryable",
      retryable: true
    } satisfies Partial<MemoryCoordinatorError>);
    expect(fixture.settleSucceededWithDurableResult).toHaveBeenCalledOnce();
    expect(fixture.run).toHaveBeenCalledOnce();
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
      pipelineVersion: string;
      policyVersion: string;
      promptVersion: string;
      schemaVersion: string;
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
        ...storedVersions(MEMORY_FACT_EXTRACTION_VERSIONS),
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
    const settleSucceededWithDurableResult = vi.fn(async (
      _userId: string,
      bindingId: string,
      result: { acceptedOutputHash: string; state: "SUCCEEDED" },
      persist: (tx: never, evidence: never) => Promise<void>
    ) => {
      await persist({} as never, {
        recoverableUntil: new Date("2026-08-12T12:00:00.000Z")
      } as never);
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
        lifecycle: {
          ...fixture.base.execution.lifecycle,
          settle,
          settleSucceededWithDurableResult
        }
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
