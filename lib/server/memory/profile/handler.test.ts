import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { MemoryJobClaim } from "../coordinator/types";
import { MemoryExecutionError } from "../execution";
import {
  MEMORY_PROFILE_PIPELINE_VERSION,
  memoryProfileInputHash,
  memoryProfileJobFingerprint,
  type MemoryProfileInput
} from "./contract";
import {
  createMemoryWorkingSetProfileHandler,
  type MemoryWorkingSetProfileHandlerDependencies
} from "./handler";
import { MEMORY_PROFILE_TOOL_NAME } from "./prompt";
import type { MemoryProfileExecutionBinding } from "./repository";

const now = new Date("2026-08-11T12:34:56.000Z");

function profileInput(): MemoryProfileInput {
  const withoutHash: Omit<MemoryProfileInput, "inputHash"> = {
    asOf: "2026-08-11T12:00:00.000Z",
    candidates: [{
      factId: "fact-1",
      factVersionContentHash: "a".repeat(64),
      factVersionId: "version-1",
      safetyIdentitySnapshot: "b".repeat(64),
      sourceIdentitySnapshot: "c".repeat(64),
      suppressionIdentitySnapshot: "d".repeat(64),
      temperatureClass: "HOT",
      temperatureScore: 0.94,
      text: "Отвечай по-русски."
    }],
    languageCode: "ru",
    memoryGeneration: 2,
    memoryRevision: 7,
    redactionState: "NOT_NEEDED",
    safetyIdentitySnapshot: "e".repeat(64),
    scopeId: "scope-global",
    sourceIdentitySnapshot: "f".repeat(64),
    suppressionIdentitySnapshot: "0".repeat(64)
  };
  return { ...withoutHash, inputHash: memoryProfileInputHash(withoutHash) };
}

function claim(input: MemoryProfileInput, kind: "PROFILE" | "SWEEP"): MemoryJobClaim {
  const jobId = randomUUID();
  return {
    activeLeafMessageId: null,
    attemptCount: 1,
    branchGeneration: null,
    chatId: null,
    claimToken: randomUUID(),
    id: jobId,
    idempotencyFingerprint: kind === "PROFILE"
      ? memoryProfileJobFingerprint(input.inputHash, jobId)
      : `working-set-mutation:${"1".repeat(64)}`,
    kind: "RECALCULATE_WORKING_SET",
    leaseExpiresAt: new Date("2026-08-11T12:40:00.000Z"),
    memoryGenerationSnapshot: input.memoryGeneration,
    memoryRevisionSnapshot: input.memoryRevision,
    pipelineVersion: MEMORY_PROFILE_PIPELINE_VERSION,
    recoveredLease: false,
    sourceHash: null,
    sourceRevision: null,
    stage: null,
    userId: randomUUID()
  };
}

function context() {
  return {
    now: () => new Date(now),
    setStage: vi.fn(async () => undefined),
    signal: new AbortController().signal
  };
}

function fixture(input = profileInput()) {
  const applyProfile = vi.fn(async () => undefined);
  const applySweep = vi.fn(async () => undefined);
  const bindings = vi.fn(async (): Promise<readonly MemoryProfileExecutionBinding[]> => []);
  const bind = vi.fn(async () => ({ id: "profile-binding" }));
  const start = vi.fn(async () => ({
    bindingId: "profile-binding",
    snapshot: {
      logicalRole: "MEMORY_PROFILE",
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
  const run = vi.fn(async () => ({
    providerResponseId: "profile-response",
    toolCalls: [{
      arguments: {
        segments: [{
          fact_version_id: input.candidates[0]!.factVersionId,
          text: input.candidates[0]!.text
        }]
      },
      id: "profile-call",
      name: MEMORY_PROFILE_TOOL_NAME
    }],
    usage: {
      cachedInputTokens: 2,
      inputTokens: 10,
      outputTokens: 4,
      reasoningTokens: 0,
      totalTokens: 14
    }
  }));
  const probeAuthority = vi.fn(async () => undefined);
  const repository = {
    applyProfile,
    applySweep,
    bindings,
    preflightProfile: vi.fn(async () => ({ status: "READY" as const })),
    preflightSweep: vi.fn(async () => ({ status: "READY" as const })),
    prepareProfile: vi.fn(async () => ({ input }))
  };
  const deps = {
    execution: {
      admission: { bind, start },
      lifecycle: { settle }
    },
    now: () => new Date(now),
    probeAuthority,
    provider: { run },
    repository
  } as unknown as MemoryWorkingSetProfileHandlerDependencies;
  return {
    applyProfile,
    applySweep,
    bindings,
    deps,
    probeAuthority,
    repository,
    run,
    settle
  };
}

describe("working-set profile handler", () => {
  it("applies a deterministic sweep without execution authority or provider calls", async () => {
    const input = profileInput();
    const test = fixture(input);
    const job = claim(input, "SWEEP");
    const result = await createMemoryWorkingSetProfileHandler({
      ...test.deps,
      profileEnabled: false
    })
      .execute(job, context());
    expect(test.probeAuthority).not.toHaveBeenCalled();
    expect(test.run).not.toHaveBeenCalled();
    await result.apply?.({} as never, job);
    expect(test.applySweep).toHaveBeenCalledWith(
      expect.anything(),
      job,
      new Date("2026-08-11T12:00:00.000Z"),
      now
    );
  });

  it("keeps profile provider work dark when the production capability is off", async () => {
    const input = profileInput();
    const test = fixture(input);
    const job = claim(input, "PROFILE");
    const handler = createMemoryWorkingSetProfileHandler({
      ...test.deps,
      profileEnabled: false
    });

    await expect(handler.preflight(job)).resolves.toEqual({
      errorCode: "memory_profile_capability_disabled",
      status: "CANCELLED"
    });
    expect(test.repository.preflightProfile).not.toHaveBeenCalled();
    expect(test.probeAuthority).not.toHaveBeenCalled();

    const result = await handler.execute(job, context());
    expect(result).toMatchObject({ stage: "profile_capability_disabled" });
    expect(result.apply).toBeUndefined();
    expect(test.repository.prepareProfile).not.toHaveBeenCalled();
    expect(test.run).not.toHaveBeenCalled();
  });

  it("waits before a profile call when qualification is unavailable", async () => {
    const input = profileInput();
    const test = fixture(input);
    const job = claim(input, "PROFILE");
    test.probeAuthority.mockRejectedValueOnce(
      new MemoryExecutionError("memory_execution_qualification_required")
    );
    await expect(createMemoryWorkingSetProfileHandler(test.deps).preflight(job))
      .resolves.toEqual({
        errorCode: "memory_execution_qualification_required",
        status: "WAITING_FOR_EGRESS_CONSENT"
      });
    expect(test.run).not.toHaveBeenCalled();
  });

  it("settles and applies one exact usage-backed profile result", async () => {
    const input = profileInput();
    const test = fixture(input);
    const job = claim(input, "PROFILE");
    const result = await createMemoryWorkingSetProfileHandler(test.deps)
      .execute(job, context());
    expect(test.run).toHaveBeenCalledTimes(1);
    expect(test.settle).toHaveBeenCalledWith(
      job.userId,
      "profile-binding",
      expect.objectContaining({
        acceptedOutputHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        state: "SUCCEEDED",
        usage: expect.objectContaining({ completeness: "COMPLETE", totalTokens: 14 })
      })
    );
    await result.apply?.({} as never, job);
    expect(test.applyProfile).toHaveBeenCalledWith(
      expect.anything(),
      job,
      input,
      expect.objectContaining({
        segments: [{ factVersionId: "version-1", text: "Отвечай по-русски." }]
      }),
      "profile-binding",
      now
    );
  });

  it("omits unsupported model text and records a failed execution", async () => {
    const input = profileInput();
    const test = fixture(input);
    const job = claim(input, "PROFILE");
    test.run.mockResolvedValueOnce({
      providerResponseId: "profile-response-invalid",
      toolCalls: [{
        arguments: {
          segments: [{ fact_version_id: "version-1", text: "Перефразированный текст" }]
        },
        id: "profile-call-invalid",
        name: MEMORY_PROFILE_TOOL_NAME
      }],
      usage: {
        cachedInputTokens: 0,
        inputTokens: 10,
        outputTokens: 4,
        reasoningTokens: 0,
        totalTokens: 14
      }
    });
    const result = await createMemoryWorkingSetProfileHandler(test.deps)
      .execute(job, context());
    expect(result.stage).toBe("profile_omitted");
    expect(result.apply).toBeUndefined();
    expect(test.settle).toHaveBeenCalledWith(
      job.userId,
      "profile-binding",
      expect.objectContaining({
        acceptedOutputHash: null,
        errorCode: "memory_profile_output_unsupported",
        state: "FAILED"
      })
    );
    expect(test.applyProfile).not.toHaveBeenCalled();
  });

  it("never replays a provider call after a succeeded result was already bound", async () => {
    const input = profileInput();
    const test = fixture(input);
    const job = claim(input, "PROFILE");
    test.bindings.mockResolvedValueOnce([{
      acceptedOutputHash: "9".repeat(64),
      id: "prior-profile-binding",
      inputHash: input.inputHash,
      ordinal: 0,
      state: "SUCCEEDED"
    }]);
    const result = await createMemoryWorkingSetProfileHandler(test.deps)
      .execute(job, context());
    expect(result.stage).toBe("profile_omitted");
    expect(result.apply).toBeUndefined();
    expect(test.run).not.toHaveBeenCalled();
    expect(test.applyProfile).not.toHaveBeenCalled();
  });
});
