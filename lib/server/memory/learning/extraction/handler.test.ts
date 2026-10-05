import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { logEvent } from "../../../observability";
import { memorySha256 } from "../../persistence/lexical";
import { MemoryCoordinatorError } from "../../coordinator/errors";
import type { MemoryJobClaim } from "../../coordinator/types";
import { MemoryExecutionError } from "../../execution";
import {
  MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
  MEMORY_FACT_EXTRACTION_RETAINED_VERSIONS,
  MEMORY_FACT_EXTRACTION_VERSIONS,
  MEMORY_FACT_SOURCE_PROJECTION_VERSION,
  memoryFactExtractionInputHash,
  memoryFactExtractionOutputHash,
  memoryFactExtractionJobFingerprint,
  type MemoryFactExtractionPlan,
  type MemoryFactExtractionInput,
  type MemoryFactSourceIdentity
} from "./contract";
import {
  createMemoryFactExtractionHandler,
  MEMORY_FACT_EXTRACTION_MAX_INVALID_OUTPUT_CALLS_PER_INPUT,
  type MemoryFactExtractionHandlerDependencies
} from "./handler";
import { invalidProviderToolArguments } from "../../../tools/types";
import {
  memorySemanticAdjudicationInput,
  MEMORY_SEMANTIC_ADJUDICATION_VERSIONS
} from "./adjudication";
import { decodeMemoryFactExtraction } from "./decoder";
import { MEMORY_FACT_EXTRACTION_TOOL_NAME } from "./prompt";
import { MemoryFactProviderCallError } from "./runtime";

vi.mock("../../../observability", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../observability")>(),
  logEvent: vi.fn()
}));

beforeEach(() => {
  vi.mocked(logEvent).mockClear();
});

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
    identityProfile: "UNICODE_V2",
    messages: [{
      contentHash: memorySha256(text),
      createdAt: "2026-08-11T09:00:00.000Z",
      evidenceEligible: true,
      id: "message-1",
      languageCode: "en",
      redactionSpans: [],
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
          usefulness: "DURABLE",
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

function adjudicationOutput(candidateRefs: readonly string[]) {
  return {
    providerResponseId: "adjudication-response",
    toolCalls: [{
      arguments: {
        decisions: candidateRefs.map((candidateRef) => ({
          assertion_status: "ASSERTED",
          candidate_ref: candidateRef,
          confidence_band: "HIGH",
          entailment: "ENTAILED",
          subject_identity: "UNRESOLVED", entity_ref: null,
          operation: "NO_RELATION",
          reason_code: "direct_preference",
          subject_scope: "CURRENT_USER",
          target_ref: null,
          temporal_perspective: "CURRENT"
        }))
      },
      id: "adjudication-call",
      name: "submit_memory_semantic_adjudications_v3"
    }],
    usage: {
      cachedInputTokens: 0,
      inputTokens: 20,
      outputTokens: 8,
      reasoningTokens: 2,
      totalTokens: 28
    }
  };
}

describe("Memory fact extraction handler", () => {
  it("parks missing consent or runtime capability before provider I/O", async () => {
    for (const code of [
      "memory_execution_capability_unavailable",
      "memory_execution_target_unavailable"
    ] as const) {
      const fixture = dependencies({
        probeAuthority: vi.fn(async () => { throw new MemoryExecutionError(code); })
      });
      await expect(createMemoryFactExtractionHandler(fixture.base).preflight(claim()))
        .resolves.toEqual({ errorCode: code, status: "WAITING_FOR_CONFIGURATION" });
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
              subject_identity: "UNRESOLVED", entity_ref: null,
              operation: "NO_RELATION",
              reason_code: "explicit_preference",
              subject_scope: "CURRENT_USER",
              target_ref: null,
              temporal_perspective: "CURRENT"
            }))
          },
          id: "call-adjudication",
          name: "submit_memory_semantic_adjudications_v3"
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

  it.each(["transient", "invalid output"] as const)(
    "retains staged extraction when adjudication fails with %s",
    async (failure) => {
      const fixture = dependencies();
      fixture.bind
        .mockResolvedValueOnce({ id: "extraction-binding" })
        .mockResolvedValueOnce({ id: "adjudication-binding" });
      const errorCode = failure === "transient"
        ? "memory_fact_provider_transient"
        : "memory_semantic_adjudication_output_invalid_call_count";
      const adjudicator = {
        run: vi.fn(async () => {
          if (failure === "transient") throw providerFailure("REPLAY_SAFE_TRANSIENT");
          return { ...adjudicationOutput(["C1"]), toolCalls: [] };
        })
      };
      const completeAdjudication = vi.fn(async () => undefined);
      const continueCoverage = vi.fn(async () => undefined);
      const handler = createMemoryFactExtractionHandler({
        ...fixture.base,
        adjudicator,
        repository: {
          ...fixture.base.repository,
          auxiliary: vi.fn(async () => null),
          completeAdjudication,
          continueCoverage,
          reserveAdjudication: vi.fn(async () => "ACQUIRED" as const)
        }
      });

      await expect(handler.execute(claim(), context())).rejects.toMatchObject({
        code: errorCode,
        retryable: true
      });
      expect(fixture.run).toHaveBeenCalledOnce();
      expect(fixture.stage).toHaveBeenCalledOnce();
      expect(adjudicator.run).toHaveBeenCalledOnce();
      expect(fixture.settle).toHaveBeenCalledWith(
        source.userId,
        "adjudication-binding",
        expect.objectContaining({
          errorCode,
          providerResponseId: failure === "transient" ? null : "adjudication-response",
          state: "FAILED",
          usage: expect.objectContaining(failure === "transient"
            ? { completeness: "UNAVAILABLE" }
            : { completeness: "COMPLETE", inputTokens: 20, outputTokens: 8, totalTokens: 28 })
        })
      );
      expect(fixture.settle).toHaveBeenCalledOnce();
      expect(fixture.settleSucceededWithDurableResult).toHaveBeenCalledOnce();
      expect(completeAdjudication).not.toHaveBeenCalled();
      expect(continueCoverage).not.toHaveBeenCalled();
      expect(fixture.apply).not.toHaveBeenCalled();
      expect(fixture.base.repository.discardStale).not.toHaveBeenCalled();
      expect(logEvent).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["transient", "dispatch", "memory_fact_provider_transient"],
    ["invalid output", "validate", "memory_semantic_adjudication_output_invalid_call_count"],
    ["invalid decision", "validate", "memory_semantic_adjudication_output_invalid_operation_target"]
  ] as const)(
    "applies without adjudication when %s exhausts the final job attempt",
    async (failure, stage, errorCode) => {
      const fixture = dependencies();
      fixture.bind
        .mockResolvedValueOnce({ id: "extraction-binding" })
        .mockResolvedValueOnce({ id: "adjudication-binding" });
      const adjudicator = {
        run: vi.fn(async () => {
          if (failure === "transient") throw providerFailure("REPLAY_SAFE_TRANSIENT");
          const output = adjudicationOutput(["C1"]);
          if (failure === "invalid output") return { ...output, toolCalls: [] };
          const [call] = output.toolCalls;
          return { ...output, toolCalls: [{ ...call!, arguments: { decisions: [{
            ...call!.arguments.decisions[0]!, operation: "REINFORCE"
          }] } }] };
        })
      };
      const completeAdjudication = vi.fn(async () => undefined);
      const continueCoverage = vi.fn(async () => undefined);
      const handler = createMemoryFactExtractionHandler({
        ...fixture.base,
        adjudicator,
        repository: {
          ...fixture.base.repository,
          auxiliary: vi.fn(async () => null),
          completeAdjudication,
          continueCoverage,
          reserveAdjudication: vi.fn(async () => "ACQUIRED" as const)
        }
      });

      const job = { ...claim(), attemptCount: 2 };
      const result = await handler.execute(job, context());
      expect(result).toMatchObject({ stage: "fact_observations_committed" });
      // The ordinary apply owns continuation; the handler adds no second one.
      expect(result.apply).toBeUndefined();
      expect(adjudicator.run).toHaveBeenCalledOnce();
      expect(fixture.settle).toHaveBeenCalledOnce();
      expect(fixture.settle).toHaveBeenCalledWith(source.userId, "adjudication-binding",
        expect.objectContaining({ errorCode, state: "FAILED" }));
      expect(completeAdjudication).not.toHaveBeenCalled();
      expect(continueCoverage).not.toHaveBeenCalled();
      expect(fixture.apply).toHaveBeenCalledOnce();
      expect(fixture.apply).toHaveBeenCalledWith(
        expect.anything(), expect.anything(), expect.anything(), expect.anything(),
        "extraction-binding", expect.any(Date), null, "extraction-binding"
      );
      expect(logEvent).toHaveBeenCalledOnce();
      expect(logEvent).toHaveBeenCalledWith("service_operation", {
        action: "degrade", code: errorCode, job_id: job.id, outcome: "degraded",
        stage, subsystem: "memory"
      });
    }
  );

  it.each([
    ["memory_semantic_adjudication_output_invalid_enum", 2],
    ["memory_fact_provider_transient", 2],
    // A re-claim after an expired lease cannot buy a third call.
    ["memory_semantic_adjudication_output_invalid", 3]
  ] as const)(
    "spends at most two provider calls on one adjudication input (%s, attempt %i)",
    async (priorCode, attemptCount) => {
      const fixture = dependencies();
      const plan = decodeMemoryFactExtraction(providerOutput().toolCalls, fixture.input);
      const semanticInput = memorySemanticAdjudicationInput(plan)!;
      const failed = (ordinal: number, errorCode: string) => ({
        acceptedOutputHash: null, errorCode, id: `failed-adjudication-${ordinal}`,
        inputHash: semanticInput.inputHash, ordinal,
        ...storedVersions(MEMORY_SEMANTIC_ADJUDICATION_VERSIONS),
        secretFreeExecutionSnapshot: {}, state: "FAILED" as const
      });
      const accepted = {
        acceptedOutputHash: plan.outputHash, errorCode: null, id: "accepted-extraction",
        inputHash: fixture.input.inputHash, ordinal: 0,
        ...storedVersions(MEMORY_FACT_EXTRACTION_VERSIONS),
        secretFreeExecutionSnapshot: {}, state: "SUCCEEDED" as const
      };
      const adjudicator = {
        run: vi.fn(async () => ({ ...adjudicationOutput(semanticInput.candidateRefs), toolCalls: [] }))
      };
      const handler = (bindings: readonly unknown[]) => createMemoryFactExtractionHandler({
        ...fixture.base,
        adjudicator,
        repository: {
          ...fixture.base.repository,
          auxiliary: vi.fn(async () => null),
          bindings: vi.fn(async () => bindings),
          completeAdjudication: vi.fn(async () => undefined),
          reserveAdjudication: vi.fn(async () => "ACQUIRED" as const),
          staged: vi.fn(async () => plan)
        }
      } as unknown as MemoryFactExtractionHandlerDependencies);

      // A second failed call of the same input degrades even before the
      // job's final attempt.
      fixture.bind.mockResolvedValue({ id: "second-adjudication" });
      await expect(handler([accepted, failed(1, priorCode)])
        .execute({ ...claim(), attemptCount: 1 }, context()))
        .resolves.toMatchObject({ stage: "fact_observations_committed" });
      expect(adjudicator.run).toHaveBeenCalledOnce();
      expect(fixture.settle).toHaveBeenCalledWith(source.userId, "second-adjudication",
        expect.objectContaining({
          errorCode: "memory_semantic_adjudication_output_invalid_call_count", state: "FAILED"
        }));
      expect(logEvent).toHaveBeenCalledOnce();
      expect(logEvent).toHaveBeenLastCalledWith("service_operation", expect.objectContaining({
        code: "memory_semantic_adjudication_output_invalid_call_count", stage: "validate"
      }));

      // Two settled failures leave no budget: no bind, no call, one event.
      adjudicator.run.mockClear();
      fixture.bind.mockClear();
      fixture.apply.mockClear();
      vi.mocked(logEvent).mockClear();
      const job = { ...claim(), attemptCount };
      await expect(handler([accepted, failed(2, "memory_semantic_adjudication_output_invalid_enum"),
        failed(1, priorCode)]).execute(job, context()))
        .resolves.toMatchObject({ stage: "fact_observations_committed" });
      expect(fixture.bind).not.toHaveBeenCalled();
      expect(adjudicator.run).not.toHaveBeenCalled();
      expect(fixture.apply).toHaveBeenCalledWith(
        expect.anything(), expect.anything(), expect.anything(), plan,
        "accepted-extraction", expect.any(Date), null, "accepted-extraction"
      );
      expect(logEvent).toHaveBeenCalledOnce();
      expect(logEvent).toHaveBeenCalledWith("service_operation", {
        action: "degrade", code: "memory_semantic_adjudication_output_invalid_enum",
        job_id: job.id, outcome: "degraded", stage: "validate", subsystem: "memory"
      });
    }
  );

  it.each([
    ["FAILED", "memory_fact_provider_transient", true, true],
    ["FAILED", "memory_fact_provider_transient", false, false],
    ["FAILED", "memory_fact_provider_unavailable", true, false],
    ["FAILED", "memory_semantic_adjudication_output_invalid", true, true],
    ["FAILED", "memory_semantic_adjudication_output_invalid", false, false],
    ["FAILED", "memory_semantic_adjudication_output_invalid_reason_code", true, true],
    ["FAILED", "memory_semantic_adjudication_output_invalid_candidate_set", false, false],
    ["FAILED", "memory_semantic_adjudication_result_invalid", true, false],
    ["OUTCOME_UNKNOWN", "memory_fact_provider_outcome_unknown", true, false],
    ["RUNNING", null, true, false],
    ["SUCCEEDED", null, true, false],
    ["CANCELLED", "memory_execution_revoked", true, false]
  ] as const)(
    "recovers staged extraction with adjudication %s/%s (matching input: %s)",
    async (state, errorCode, sameInput, retries) => {
      const fixture = dependencies();
      const plan = decodeMemoryFactExtraction(providerOutput().toolCalls, fixture.input);
      const semanticInput = memorySemanticAdjudicationInput(plan)!;
      const bindings = [{
        acceptedOutputHash: plan.outputHash,
        errorCode: null,
        id: "accepted-extraction",
        inputHash: fixture.input.inputHash,
        ordinal: 0,
        ...storedVersions(MEMORY_FACT_EXTRACTION_VERSIONS),
        secretFreeExecutionSnapshot: {},
        state: "SUCCEEDED" as const
      }, {
        acceptedOutputHash: state === "SUCCEEDED" ? "e".repeat(64) : null,
        errorCode,
        id: "prior-adjudication",
        inputHash: sameInput ? semanticInput.inputHash : "d".repeat(64),
        ordinal: 1,
        ...storedVersions(MEMORY_SEMANTIC_ADJUDICATION_VERSIONS),
        secretFreeExecutionSnapshot: {},
        state
      }];
      fixture.bind.mockResolvedValue({ id: "retry-adjudication" });
      const adjudicator = {
        run: vi.fn(async () => adjudicationOutput(semanticInput.candidateRefs))
      };
      const completeAdjudication = vi.fn(async () => undefined);
      const handler = createMemoryFactExtractionHandler({
        ...fixture.base,
        adjudicator,
        repository: {
          ...fixture.base.repository,
          auxiliary: vi.fn(async () => null),
          bindings: vi.fn(async () => bindings),
          completeAdjudication,
          reserveAdjudication: vi.fn(async () => "ACQUIRED" as const),
          staged: vi.fn(async () => plan)
        }
      });

      await handler.execute({ ...claim(), attemptCount: 2 }, context());
      expect(fixture.run).not.toHaveBeenCalled();
      expect(fixture.stage).not.toHaveBeenCalled();
      // Recovery never accounts the successful extraction or prior failed
      // adjudication again; only a fresh successful adjudication is settled.
      expect(fixture.settleSucceededWithDurableResult).toHaveBeenCalledTimes(retries ? 1 : 0);
      if (state !== "RUNNING") expect(fixture.settle).not.toHaveBeenCalled();
      expect(adjudicator.run).toHaveBeenCalledTimes(retries ? 1 : 0);
      expect(completeAdjudication).toHaveBeenCalledTimes(retries ? 1 : 0);
      expect(fixture.apply).toHaveBeenCalledOnce();
      if (retries) {
        expect(fixture.bind).toHaveBeenCalledWith(source.userId,
          expect.objectContaining({ inputHash: semanticInput.inputHash, ordinal: 2 }));
        expect(fixture.apply).toHaveBeenCalledWith(
          expect.anything(), expect.anything(), expect.anything(), plan,
          "accepted-extraction", expect.any(Date),
          expect.objectContaining({ decisions: [expect.objectContaining({
            candidateRef: "C1", operation: "NO_RELATION"
          })] }), "retry-adjudication"
        );
      } else {
        expect(fixture.bind).not.toHaveBeenCalled();
        expect(fixture.apply).toHaveBeenCalledWith(
          expect.anything(), expect.anything(), expect.anything(), plan,
          "accepted-extraction", expect.any(Date), null, "accepted-extraction"
        );
      }
    }
  );

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
    // The in-attempt budget stops repeated invalid packets even when the
    // durable read does not yet show them.
    expect(fixture.base.provider.run)
      .toHaveBeenCalledTimes(MEMORY_FACT_EXTRACTION_MAX_INVALID_OUTPUT_CALLS_PER_INPUT);
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
          errorCode: null,
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
          errorCode: null,
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
          errorCode: null,
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

  it.each([
    ["retained v52", {
      policyVersion: "memory-fact-extraction-policy-v38",
      promptVersion: "memory-fact-extraction-prompt-v52",
      schemaVersion: "memory-fact-extraction-schema-v7"
    }, true],
    ["retired v51", {
      policyVersion: "memory-fact-extraction-policy-v38",
      promptVersion: "memory-fact-extraction-prompt-v51",
      schemaVersion: "memory-fact-extraction-schema-v7"
    }, false]
  ] as const)("recovers a %s staged output only by its recorded semantics", async (_label, versions, retained) => {
    const fixture = dependencies();
    const { inputHash: _inputHash, ...sourceInput } = fixture.input;
    const recordedHash = memoryFactExtractionInputHash(sourceInput, versions);
    const recordedInput = { ...fixture.input, inputHash: recordedHash };
    const current = decodeMemoryFactExtraction(providerOutput().toolCalls, fixture.input);
    // The recorded plan keeps its own classes; recovery never re-decodes it.
    const candidates = current.candidates.map((candidate) => ({
      ...candidate, usefulness: "ONGOING" as const
    }));
    const plan: MemoryFactExtractionPlan = {
      ...current, candidates, input: recordedInput,
      outputHash: memoryFactExtractionOutputHash(
        recordedInput, candidates, current.candidateOrdinals, current.rejections
      )
    };
    const discardStale = vi.fn(async () => 0);
    const handler = createMemoryFactExtractionHandler({
      ...fixture.base,
      repository: {
        ...fixture.base.repository,
        bindings: vi.fn(async () => [{
          acceptedOutputHash: plan.outputHash, errorCode: null, id: "recorded-binding",
          inputHash: recordedHash, ordinal: 0,
          ...storedVersions({ pipelineVersion: MEMORY_FACT_EXTRACTION_PIPELINE_VERSION, ...versions }),
          secretFreeExecutionSnapshot: {}, state: "SUCCEEDED" as const
        }]),
        discardStale,
        staged: vi.fn(async () => plan)
      }
    });
    if (retained) {
      await expect(handler.execute(claim(), context())).resolves.toMatchObject({
        acceptedResultHash: plan.outputHash,
        stage: "fact_observations_committed"
      });
      expect(discardStale).not.toHaveBeenCalled();
      expect(fixture.apply.mock.calls[0]?.[3]).toBe(plan);
    } else {
      await expect(handler.execute(claim(), context()))
        .rejects.toMatchObject({ code: "memory_fact_binding_stale" });
      expect(discardStale).toHaveBeenCalledWith(expect.anything(), "source_stale");
      expect(fixture.apply).not.toHaveBeenCalled();
    }
    expect(fixture.run).not.toHaveBeenCalled();
    expect(fixture.bind).not.toHaveBeenCalled();
  });

  it.each([false, true])("retires fresh legacy decoding but preserves accepted recovery (%s)", async (accepted) => {
    const fixture = dependencies();
    const { inputHash: _inputHash, ...sourceInput } = fixture.input;
    const historical = { ...sourceInput, identityProfile: "LEGACY_V1" as const };
    const input = { ...historical, inputHash: memoryFactExtractionInputHash(historical) };
    const current = decodeMemoryFactExtraction(providerOutput().toolCalls, fixture.input);
    const candidates = current.candidates.map((candidate) => ({
      ...candidate, canonicalKey: "slot:v2:self:preference:topic:tea",
      dimensionKey: "topic:tea", identityProfile: "LEGACY_V1" as const,
      identityVersion: "slot-v2" as const,
      legacyCanonicalKey: "slot:v2:self:preference:topic:tea",
      legacyProposedValue: candidate.proposedValue
    }));
    const plan = { ...current, candidates, input,
      outputHash: memoryFactExtractionOutputHash(input, candidates, current.candidateOrdinals, current.rejections) };
    const handler = createMemoryFactExtractionHandler({
      ...fixture.base,
      repository: {
        ...fixture.base.repository,
        prepare: vi.fn(async () => ({ input })),
        bindings: vi.fn(async () => accepted ? [{
          acceptedOutputHash: plan.outputHash, id: "recorded-binding", inputHash: input.inputHash,
          errorCode: null,
          ordinal: 0, ...storedVersions(MEMORY_FACT_EXTRACTION_VERSIONS),
          secretFreeExecutionSnapshot: {}, state: "SUCCEEDED" as const
        }] : []),
        staged: vi.fn(async () => accepted ? plan : null)
      }
    });
    const legacyClaim = { ...claim(), idempotencyFingerprint: memoryFactExtractionJobFingerprint(source, "LEGACY_V1") };
    const result = await handler.execute(legacyClaim, context());
    expect(result.stage).toBe(accepted ? "fact_observations_committed" : "fact_identity_profile_retired");
    expect(fixture.run).not.toHaveBeenCalled();
    expect(fixture.bind).not.toHaveBeenCalled();
    if (accepted) {
      expect(result.acceptedResultHash).toBe(plan.outputHash);
      expect(fixture.apply.mock.calls[0]?.[3]).toBe(plan);
    } else expect(fixture.apply).not.toHaveBeenCalled();
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
          errorCode: null,
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
    let preparedInput = fixture.input;
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
        bindings: vi.fn(async () => bindings),
        prepare: vi.fn(async () => ({ input: preparedInput }))
      }
    } as unknown as MemoryFactExtractionHandlerDependencies);
    const firstClaim = claim();

    await expect(handler.execute(firstClaim, context())).rejects.toMatchObject({
      code: "memory_fact_provider_transient",
      retryable: true
    } satisfies Partial<MemoryCoordinatorError>);
    expect(bindings).toMatchObject([{ id: "binding-1", ordinal: 0, state: "FAILED" }]);

    const { inputHash: _inputHash, ...changedInput } = fixture.input;
    const changedProjection = {
      ...changedInput,
      sourceProjectionHash: "d".repeat(64)
    };
    preparedInput = {
      ...changedProjection,
      inputHash: memoryFactExtractionInputHash(changedProjection)
    };
    expect(preparedInput.inputHash).not.toBe(bindings[0]!.inputHash);

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

  it.each([
    "memory_fact_source_oversized",
    "memory_fact_source_partially_processed",
    "memory_fact_source_coverage_exhausted"
  ])("fails an incomplete source visibly as %s instead of staling it", async (code) => {
    const fixture = dependencies();
    const handler = createMemoryFactExtractionHandler({
      ...fixture.base,
      repository: {
        ...fixture.base.repository,
        prepare: vi.fn(async () => ({
          decision: { errorCode: code, status: "CANCELLED" as const }
        }))
      }
    });
    const failure = await handler.execute(claim(), context()).catch((error) => error);
    expect(failure).toBeInstanceOf(MemoryCoordinatorError);
    expect(failure).toMatchObject({ code, retryable: false });
    expect(fixture.bind).not.toHaveBeenCalled();
    expect(fixture.run).not.toHaveBeenCalled();

    const staleHandler = createMemoryFactExtractionHandler({
      ...fixture.base,
      repository: {
        ...fixture.base.repository,
        prepare: vi.fn(async () => ({
          decision: { errorCode: "memory_fact_source_stale", status: "STALE" as const }
        }))
      }
    });
    await expect(staleHandler.execute(claim(), context())).resolves.toMatchObject({
      stage: "memory_fact_source_stale"
    });
  });

  it("hands coverage to the next page after a page that applied nothing", async () => {
    const continueCoverage = vi.fn(async () => undefined);
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
    const handler = createMemoryFactExtractionHandler({
      ...fixture.base,
      repository: { ...fixture.base.repository, continueCoverage }
    });
    const jobClaim = claim();
    const rejected = await handler.execute(jobClaim, context());
    expect(rejected.stage).toBe("fact_output_rejected");
    expect(fixture.apply).not.toHaveBeenCalled();
    expect(continueCoverage).not.toHaveBeenCalled();
    await rejected.apply?.({} as never, jobClaim);
    expect(continueCoverage).toHaveBeenCalledWith({}, jobClaim, fixture.input, undefined);

    // An applied page enqueued its continuation inside its own apply.
    const applied = await createMemoryFactExtractionHandler({
      ...dependencies().base,
      repository: { ...dependencies().base.repository, continueCoverage }
    }).execute(claim(), context());
    expect(applied.stage).toBe("fact_observations_committed");
    expect(applied.apply).toBeUndefined();
  });

  it("keeps covering later pages when this page's apply turned stale", async () => {
    const continueCoverage = vi.fn(async () => undefined);
    const fixture = dependencies();
    fixture.apply.mockResolvedValueOnce("STALE" as never);
    const jobClaim = claim();
    const result = await createMemoryFactExtractionHandler({
      ...fixture.base,
      repository: { ...fixture.base.repository, continueCoverage }
    }).execute(jobClaim, context());
    expect(result.stage).toBe("fact_apply_stale");
    await result.apply?.({} as never, jobClaim);
    expect(continueCoverage).toHaveBeenCalledWith({}, jobClaim, fixture.input, undefined);
  });

  it("fences a secret in a page's preceding text before provider egress", async () => {
    const fixture = dependencies();
    const pageInput: MemoryFactExtractionInput = {
      ...fixture.input,
      targetPage: {
        coreEnd: 40_000,
        coreStart: 20_000,
        ordinal: 1,
        precedingText: "My API key is sk-abcdefghijklmnopqrstuvwxyz123456.",
        sourceLength: 60_000,
        sourceUnprocessed: false
      }
    };
    const continueCoverage = vi.fn(async () => undefined);
    const handler = createMemoryFactExtractionHandler({
      ...fixture.base,
      repository: {
        ...fixture.base.repository,
        continueCoverage,
        prepare: vi.fn(async () => ({ input: pageInput }))
      }
    });
    const result = await handler.execute(claim(), context());
    expect(result.stage).toBe("fact_secret_source_fenced");
    expect(fixture.bind).not.toHaveBeenCalled();
    expect(fixture.run).not.toHaveBeenCalled();
    await result.apply?.({} as never, claim());
    expect(continueCoverage)
      .toHaveBeenCalledWith({}, expect.anything(), pageInput, undefined);
  });
});

type StoredFactBinding = {
  acceptedOutputHash: string | null;
  errorCode: string | null;
  id: string;
  inputHash: string;
  ordinal: number;
  pipelineVersion: string;
  policyVersion: string;
  promptVersion: string;
  schemaVersion: string;
  secretFreeExecutionSnapshot: Record<string, never>;
  state: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "OUTCOME_UNKNOWN";
};

function storedFactBinding(
  ordinal: number,
  state: StoredFactBinding["state"],
  errorCode: string | null,
  inputHash: string
): StoredFactBinding {
  return {
    acceptedOutputHash: null,
    errorCode,
    id: `seeded-${ordinal}`,
    inputHash,
    ordinal,
    ...storedVersions(MEMORY_FACT_EXTRACTION_VERSIONS),
    secretFreeExecutionSnapshot: {},
    state
  };
}

function invalidPacket(index: number, argumentsValue: Record<string, unknown> = {
  observations: "invalid"
}) {
  return {
    providerResponseId: `invalid-response-${index}`,
    toolCalls: [{
      arguments: argumentsValue,
      id: `invalid-call-${index}`,
      name: MEMORY_FACT_EXTRACTION_TOOL_NAME
    }],
    usage: {
      cachedInputTokens: 0,
      inputTokens: 100 + index,
      outputTokens: 10 + index,
      reasoningTokens: 0,
      totalTokens: 110 + 2 * index
    }
  };
}

type RecordedSettlement = {
  acceptedOutputHash: string | null;
  errorCode: string | null;
  state: StoredFactBinding["state"];
  usage: unknown;
};

/** Mirrors the durable binding rules the handler relies on: a unique
 * (job, role, ordinal), start only from PENDING, one settlement per call. */
function durableExtraction(seeded: readonly StoredFactBinding[] = []) {
  const fixture = dependencies();
  const bindings: StoredFactBinding[] = seeded.map((binding) => ({ ...binding }));
  const settlements: Array<RecordedSettlement & { bindingId: string }> = [];
  const bind = vi.fn(async (_userId: string, request: {
    inputHash: string;
    ordinal: number;
  }) => {
    if (bindings.some(({ ordinal }) => ordinal === request.ordinal)) {
      throw new MemoryExecutionError("memory_execution_binding_conflict");
    }
    const id = `binding-${request.ordinal}`;
    bindings.push({
      ...storedFactBinding(request.ordinal, "PENDING", null, request.inputHash),
      id
    });
    return { id };
  });
  const start = vi.fn(async (_userId: string, bindingId: string) => {
    const binding = bindings.find(({ id }) => id === bindingId)!;
    if (binding.state !== "PENDING") {
      throw new MemoryExecutionError("memory_execution_state_conflict");
    }
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
  const record = (bindingId: string, result: RecordedSettlement) => {
    const binding = bindings.find(({ id }) => id === bindingId)!;
    if (binding.state !== "RUNNING" && binding.state !== "PENDING") {
      throw new MemoryExecutionError("memory_execution_state_conflict");
    }
    binding.acceptedOutputHash = result.acceptedOutputHash;
    binding.errorCode = result.errorCode;
    binding.state = result.state;
    settlements.push({ ...result, bindingId });
    return { state: result.state };
  };
  const settle = vi.fn(async (
    _userId: string,
    bindingId: string,
    result: RecordedSettlement
  ) => record(bindingId, result));
  const settleSucceededWithDurableResult = vi.fn(async (
    _userId: string,
    bindingId: string,
    result: RecordedSettlement,
    persist: (tx: never, evidence: never) => Promise<void>
  ) => {
    await persist({} as never, {
      recoverableUntil: new Date("2026-08-12T12:00:00.000Z")
    } as never);
    return record(bindingId, result);
  });
  const handler = (run: MemoryFactExtractionHandlerDependencies["provider"]["run"]) =>
    createMemoryFactExtractionHandler({
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
        bindings: vi.fn(async () => bindings.map((binding) => ({ ...binding })))
      }
    } as unknown as MemoryFactExtractionHandlerDependencies);
  return { bind, bindings, fixture, handler, settlements };
}

function retryLogs() {
  return vi.mocked(logEvent).mock.calls.filter(([event, fields]) =>
    event === "service_operation" && (fields as { action?: string }).action === "retry");
}

describe("Memory fact extraction invalid-output budget", () => {
  it("retries an invalid packet at the next ordinal and accounts both calls", async () => {
    const durable = durableExtraction();
    const run = vi.fn()
      .mockResolvedValueOnce(invalidPacket(1))
      .mockResolvedValueOnce(providerOutput());
    const result = await durable.handler(run).execute(claim(), context());

    expect(result.stage).toBe("fact_observations_committed");
    expect(run).toHaveBeenCalledTimes(2);
    expect(durable.bindings).toMatchObject([
      { errorCode: "memory_fact_output_invalid", id: "binding-0", ordinal: 0, state: "FAILED" },
      { errorCode: null, id: "binding-1", ordinal: 1, state: "SUCCEEDED" }
    ]);
    expect(durable.settlements).toEqual([
      expect.objectContaining({
        bindingId: "binding-0",
        usage: expect.objectContaining({ inputTokens: 101, outputTokens: 11 })
      }),
      expect.objectContaining({
        bindingId: "binding-1",
        usage: expect.objectContaining({ inputTokens: 10, outputTokens: 5 })
      })
    ]);
    expect(durable.fixture.stage).toHaveBeenCalledOnce();
    expect(durable.fixture.stage).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), "binding-1", expect.any(Date)
    );
    expect(durable.fixture.apply).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), expect.anything(),
      "binding-1", expect.any(Date), null, "binding-1"
    );
    expect(retryLogs()).toEqual([["service_operation", {
      action: "retry",
      attempt: 2,
      code: "memory_fact_output_invalid",
      job_id: expect.any(String),
      outcome: "failed",
      stage: "validate",
      subsystem: "memory"
    }]]);
  });

  it("retries truncated tool arguments as an invalid whole packet", async () => {
    const durable = durableExtraction();
    const run = vi.fn()
      .mockResolvedValueOnce(invalidPacket(1, invalidProviderToolArguments()))
      .mockResolvedValueOnce(providerOutput());
    await expect(durable.handler(run).execute(claim(), context()))
      .resolves.toMatchObject({ stage: "fact_observations_committed" });
    expect(durable.bindings.map(({ errorCode }) => errorCode))
      .toEqual(["memory_fact_output_invalid", null]);
  });

  it("stops repeated invalid packets at the budget with the original code", async () => {
    const durable = durableExtraction();
    let calls = 0;
    const run = vi.fn(async () => invalidPacket(++calls));
    const result = await durable.handler(run).execute(claim(), context());

    expect(result.stage).toBe("fact_output_rejected");
    expect(run).toHaveBeenCalledTimes(MEMORY_FACT_EXTRACTION_MAX_INVALID_OUTPUT_CALLS_PER_INPUT);
    expect(durable.bindings).toMatchObject([0, 1, 2].map((ordinal) => ({
      errorCode: "memory_fact_output_invalid",
      ordinal,
      state: "FAILED"
    })));
    expect(durable.settlements.map(({ usage }) =>
      (usage as { outputTokens: number }).outputTokens)).toEqual([11, 12, 13]);
    expect(retryLogs().map(([, fields]) => (fields as { attempt: number }).attempt))
      .toEqual([2, 3]);
    expect(durable.fixture.stage).not.toHaveBeenCalled();
    expect(durable.fixture.apply).not.toHaveBeenCalled();
  });

  it("keeps a replay-safe transient outside the budget and holds it across a retry", async () => {
    const durable = durableExtraction();
    let invalid = 0;
    const run = vi.fn()
      .mockResolvedValueOnce(invalidPacket(++invalid))
      .mockRejectedValueOnce(providerFailure("REPLAY_SAFE_TRANSIENT"))
      .mockImplementation(async () => invalidPacket(++invalid));
    const handler = durable.handler(run);
    const firstClaim = claim();

    await expect(handler.execute(firstClaim, context())).rejects.toMatchObject({
      code: "memory_fact_provider_transient",
      retryable: true
    } satisfies Partial<MemoryCoordinatorError>);
    expect(durable.bindings.map(({ errorCode }) => errorCode)).toEqual([
      "memory_fact_output_invalid",
      "memory_fact_provider_transient"
    ]);

    // The coordinator retry spends only what the budget has left.
    await expect(handler.execute({ ...firstClaim, attemptCount: 2 }, context()))
      .resolves.toMatchObject({ stage: "fact_output_rejected" });
    expect(run).toHaveBeenCalledTimes(4);
    expect(durable.bindings.map(({ errorCode, ordinal }) => [ordinal, errorCode])).toEqual([
      [0, "memory_fact_output_invalid"],
      [1, "memory_fact_provider_transient"],
      [2, "memory_fact_output_invalid"],
      [3, "memory_fact_output_invalid"]
    ]);
  });

  it.each([
    ["UNKNOWN", "OUTCOME_UNKNOWN", "fact_outcome_unknown"],
    ["PERMANENT", "FAILED", "fact_provider_unavailable"]
  ] as const)(
    "ends a validation retry on a %s provider failure without another call",
    async (classification, state, stage) => {
      const durable = durableExtraction();
      const run = vi.fn()
        .mockResolvedValueOnce(invalidPacket(1))
        .mockRejectedValueOnce(providerFailure(classification))
        .mockResolvedValue(providerOutput());
      await expect(durable.handler(run).execute(claim(), context()))
        .resolves.toMatchObject({ stage });
      expect(run).toHaveBeenCalledTimes(2);
      expect(durable.bindings).toMatchObject([
        { ordinal: 0, state: "FAILED" },
        { ordinal: 1, state }
      ]);
    }
  );

  it.each(["UNKNOWN", "PERMANENT"] as const)(
    "never spends the budget on a first %s provider failure",
    async (classification) => {
      const durable = durableExtraction();
      const run = vi.fn()
        .mockRejectedValueOnce(providerFailure(classification))
        .mockResolvedValue(providerOutput());
      await durable.handler(run).execute(claim(), context());
      expect(run).toHaveBeenCalledOnce();
      expect(retryLogs()).toEqual([]);
    }
  );

  it("never dispatches on a re-claim after a crash left a RUNNING retry", async () => {
    const input = extractionInput();
    const durable = durableExtraction([
      storedFactBinding(0, "FAILED", "memory_fact_output_invalid", input.inputHash),
      storedFactBinding(1, "RUNNING", null, input.inputHash)
    ]);
    const run = vi.fn(async () => providerOutput());
    await expect(durable.handler(run).execute(claim(), context()))
      .resolves.toMatchObject({ stage: "fact_outcome_unknown" });
    expect(run).not.toHaveBeenCalled();
    expect(durable.bind).not.toHaveBeenCalled();
    expect(durable.bindings[1]).toMatchObject({
      errorCode: "memory_fact_recovered_uncertain",
      state: "OUTCOME_UNKNOWN"
    });
  });

  it("never dispatches past an ambiguous sibling that appears between calls", async () => {
    const durable = durableExtraction();
    const run = vi.fn(async () => {
      durable.bindings.push({
        ...storedFactBinding(7, "OUTCOME_UNKNOWN", "memory_fact_provider_outcome_unknown",
          extractionInput().inputHash),
        id: "sibling"
      });
      return invalidPacket(1);
    });
    await expect(durable.handler(run).execute(claim(), context()))
      .resolves.toMatchObject({ stage: "fact_outcome_unknown" });
    expect(run).toHaveBeenCalledOnce();
    expect(retryLogs()).toEqual([]);
  });

  it("does not retry after the job attempt was cancelled", async () => {
    const durable = durableExtraction();
    const abort = new AbortController();
    const run = vi.fn(async () => {
      abort.abort();
      return invalidPacket(1);
    });
    await expect(durable.handler(run).execute(claim(), {
      ...context(),
      signal: abort.signal
    })).resolves.toMatchObject({ stage: "fact_output_rejected" });
    expect(run).toHaveBeenCalledOnce();
  });

  it("holds the durable budget on a re-claim and spends only the remainder", async () => {
    const input = extractionInput();
    const exhausted = durableExtraction([0, 1, 2].map((ordinal) =>
      storedFactBinding(ordinal, "FAILED", "memory_fact_output_invalid", input.inputHash)));
    const neverRun = vi.fn(async () => providerOutput());
    await expect(exhausted.handler(neverRun).execute(claim(), context()))
      .resolves.toMatchObject({ stage: "fact_output_rejected" });
    expect(neverRun).not.toHaveBeenCalled();
    expect(exhausted.bind).not.toHaveBeenCalled();

    const partial = durableExtraction([0, 1].map((ordinal) =>
      storedFactBinding(ordinal, "FAILED", "memory_fact_output_invalid", input.inputHash)));
    const run = vi.fn(async () => invalidPacket(3));
    await expect(partial.handler(run).execute(claim(), context()))
      .resolves.toMatchObject({ stage: "fact_output_rejected" });
    expect(run).toHaveBeenCalledOnce();
    expect(partial.bind).toHaveBeenCalledExactlyOnceWith(source.userId,
      expect.objectContaining({ ordinal: 2 }));
  });

  it("counts only invalid packets of the same input and versions", async () => {
    const input = extractionInput();
    const durable = durableExtraction([
      storedFactBinding(0, "FAILED", "memory_fact_output_invalid", "e".repeat(64)),
      storedFactBinding(1, "FAILED", "memory_fact_output_invalid", "f".repeat(64)),
      { ...storedFactBinding(2, "FAILED", "memory_fact_output_invalid", input.inputHash),
        promptVersion: MEMORY_FACT_EXTRACTION_RETAINED_VERSIONS.promptVersion },
      storedFactBinding(3, "FAILED", "memory_fact_provider_transient", input.inputHash),
      storedFactBinding(4, "FAILED", "memory_fact_execution_abandoned", input.inputHash)
    ]);
    const run = vi.fn(async () => providerOutput());
    await expect(durable.handler(run).execute(claim(), context()))
      .resolves.toMatchObject({ stage: "fact_observations_committed" });
    expect(run).toHaveBeenCalledOnce();
    expect(durable.bind).toHaveBeenCalledExactlyOnceWith(source.userId,
      expect.objectContaining({ ordinal: 5 }));
  });
});
