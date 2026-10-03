import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StructuredOutputDecodeError } from "../../providers/structuredOutput";
import type { MemoryTransaction } from "../persistence/transaction";
import { memoryExecutionSha256 } from "./canonical";
import { MemoryExecutionError } from "./errors";
import { MemoryOutputViolationError } from "./outputViolation";
import {
  executeGovernedMemoryStructuredOutput,
  MEMORY_STRUCTURED_OUTPUT_INVALID_OUTPUT_BREAKER,
  MemoryStructuredOutputDispatchFenced,
  MemoryStructuredOutputProviderError,
  unavailableMemoryReportedUsage
} from "./structuredClassifier";

const { bind, start, settle, settleDurable, logEvent } = vi.hoisted(() => ({
  bind: vi.fn(), start: vi.fn(), settle: vi.fn(), settleDurable: vi.fn(), logEvent: vi.fn()
}));
vi.mock("./admission", () => ({
  createPrismaMemoryExecutionAdmission: () => ({ bind, start })
}));
vi.mock("./lifecycle", () => ({
  createPrismaMemoryExecutionLifecycle: () => ({
    settle, settleSucceededWithDurableResult: settleDurable
  })
}));
vi.mock("../../observability", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../observability")>(),
  logEvent
}));

const completedAt = new Date("2026-09-14T12:00:00.000Z");
const tx = {} as MemoryTransaction;
const durableEvidence = {
  bindingId: "binding", completedAt,
  recoverableUntil: new Date("2026-09-15T12:00:00.000Z"), replayed: false
};

beforeEach(() => {
  vi.resetAllMocks();
  bind.mockResolvedValue({ id: "binding" });
  start.mockResolvedValue({
    snapshot: {
      logicalRole: "MEMORY_CONSOLIDATE", requiresStrictStructuredOutput: true,
      providerExecutionSnapshot: { providerFamily: "fixture", providerModelId: "configured-model" }
    }
  });
  settle.mockResolvedValue({ completedAt });
  settleDurable.mockImplementation(async (_userId, _bindingId, _result, persist) => {
    await persist(tx, durableEvidence);
    return { completedAt };
  });
});

function input() {
  return {
    authority: {}, client: {} as PrismaClient,
    decode: (value: unknown) => ({ admitted: (value as { ok: boolean }).ok }),
    inputHash: "a".repeat(64), ordinal: 0,
    owner: { memoryJobId: "owned-job", type: "JOB" as const },
    provider: { run: vi.fn().mockResolvedValue({
      output: { ok: true, discarded: "not part of the decoded result" },
      providerResponseId: null, usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 }
    }) },
    request: {
      maxOutputTokens: 128, name: "bounded_decision", schema: { type: "object" },
      systemPrompt: "Classify supplied data.", userPrompt: "Synthetic data"
    },
    role: "MEMORY_CONSOLIDATE" as const,
    signal: new AbortController().signal, userId: "owner",
    versions: { pipelineVersion: "pipeline", policyVersion: "policy",
      promptVersion: "prompt", retrievalConfigFingerprint: "retrieval", schemaVersion: "schema" }
  };
}

describe("governed structured output durable settlement", () => {
  it.each([false, true])("retains exhaustion accounting without retry, with cancellation taking precedence (%s)", async (cancelled) => {
    const request = input();
    const failure = new MemoryStructuredOutputProviderError("provider-response", {
      inputTokens: 20, outputTokens: 4096, reasoningTokens: 4096, totalTokens: 4116
    }, { cause: Object.assign(new Error("bounded failure"), { code: "structured_output_output_limit_exceeded" }) });
    request.provider.run.mockRejectedValue(failure);
    const controller = new AbortController();
    if (cancelled) controller.abort();
    await expect(executeGovernedMemoryStructuredOutput({ ...request, signal: controller.signal })).rejects.toBe(failure);
    expect(settle).toHaveBeenCalledWith("owner", "binding", expect.objectContaining({
      state: cancelled ? "CANCELLED" : "FAILED",
      errorCode: cancelled ? "memory_classifier_cancelled" : "memory_classifier_output_limit_exceeded",
      usage: expect.objectContaining({ totalTokens: 4116, reasoningTokens: 4096 })
    }));
    expect(request.provider.run).toHaveBeenCalledOnce();
    expect(settleDurable).not.toHaveBeenCalled();
  });
  it("stores only the decoded output in the same successful settlement as provider usage", async () => {
    const request = input();
    const persistResult = vi.fn().mockResolvedValue(undefined);
    const result = await executeGovernedMemoryStructuredOutput({ ...request, persistResult });
    const expectedHash = memoryExecutionSha256({
      inputHash: request.inputHash, output: { admitted: true }, role: request.role, version: 1
    });
    expect(request.provider.run).toHaveBeenCalledOnce();
    expect(settle).not.toHaveBeenCalled();
    expect(settleDurable).toHaveBeenCalledExactlyOnceWith("owner", "binding", {
      acceptedOutputHash: expectedHash, errorCode: null, providerResponseId: null,
      state: "SUCCEEDED", usage: expect.objectContaining({ inputTokens: 20, outputTokens: 5, totalTokens: 25 })
    }, expect.any(Function));
    expect(persistResult).toHaveBeenCalledExactlyOnceWith(tx, {
      ...durableEvidence, acceptedOutputHash: expectedHash,
      inputHash: request.inputHash, ordinal: 0, value: { admitted: true }
    });
    expect(result).toMatchObject({
      acceptedOutputHash: expectedHash, bindingId: "binding", classifiedAt: completedAt,
      inputHash: request.inputHash, modelId: "configured-model", value: { admitted: true }
    });
  });

  it("preserves ordinary settlement for callers without a durable recovery owner", async () => {
    const request = input();
    await executeGovernedMemoryStructuredOutput(request);
    expect(settle).toHaveBeenCalledOnce();
    expect(settleDurable).not.toHaveBeenCalled();
    expect(request.provider.run).toHaveBeenCalledOnce();
  });

  it("never publishes success or falls back to non-atomic settlement when persistence fails", async () => {
    const request = input();
    const persistResult = vi.fn().mockRejectedValue(new Error("durable_owner_unavailable"));
    await expect(executeGovernedMemoryStructuredOutput({ ...request, persistResult }))
      .rejects.toThrow("durable_owner_unavailable");
    expect(settle).not.toHaveBeenCalled();
    expect(settleDurable).toHaveBeenCalledOnce();
    expect(request.provider.run).toHaveBeenCalledOnce();
  });

  it("settles invalid output as failure with reported usage and no durable accepted result", async () => {
    const request = input();
    const persistResult = vi.fn();
    await expect(executeGovernedMemoryStructuredOutput({
      ...request, persistResult, decode: () => { throw new Error("invalid_decision"); }
    })).rejects.toThrow("invalid_decision");
    expect(persistResult).not.toHaveBeenCalled();
    expect(settleDurable).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledWith("owner", "binding", expect.objectContaining({
      state: "FAILED", acceptedOutputHash: null, errorCode: "memory_classifier_output_invalid",
      decodeReason: "role_contract", usage: expect.objectContaining({ inputTokens: 20, outputTokens: 5 })
    }));
    // Retries are opt-in: without them one invalid answer stays one call.
    expect(request.provider.run).toHaveBeenCalledOnce();
    expect(logEvent).not.toHaveBeenCalled();
  });
});

type Run = ReturnType<typeof input>["provider"]["run"];

function retryInput(options: Readonly<{
  allocateOrdinal?: (attempt: number) => number | Promise<number>;
  invalidBindings?: number;
  maxAttempts?: number;
}> = {}) {
  const count = vi.fn().mockResolvedValue(options.invalidBindings ?? 0);
  const allocateOrdinal = vi.fn(options.allocateOrdinal ?? ((attempt: number) => 10 + attempt));
  return {
    ...input(),
    allocateOrdinal,
    client: { memoryExecutionBinding: { count } } as unknown as PrismaClient,
    count,
    validationRetry: { allocateOrdinal, maxAttempts: options.maxAttempts ?? 3 }
  };
}

function answer(ok: boolean, outputTokens = 5) {
  return { output: { ok }, providerResponseId: null,
    usage: { inputTokens: 20, outputTokens, totalTokens: 20 + outputTokens } };
}

/** The decoder reports a typed, content-free contract violation. */
function strictDecode(value: unknown) {
  if ((value as { ok: boolean }).ok !== true) {
    throw new MemoryOutputViolationError("fixture_output_invalid", "digest_contract_summary_length");
  }
  return { admitted: true };
}

function invalidJson(outputTokens = 7) {
  return new MemoryStructuredOutputProviderError("provider-response", {
    inputTokens: 20, outputTokens, totalTokens: 20 + outputTokens
  }, { cause: new StructuredOutputDecodeError("invalid_json") });
}

describe("governed structured output validation retries", () => {
  beforeEach(() => {
    bind.mockImplementation(async (_userId: string, request: { ordinal: number }) =>
      ({ id: `binding-${request.ordinal}` }));
  });

  it("repairs a rejected answer with one more accounted call on a fresh ordinal", async () => {
    const request = retryInput();
    (request.provider.run as Run).mockResolvedValueOnce(answer(false, 900)).mockResolvedValueOnce(answer(true));
    const result = await executeGovernedMemoryStructuredOutput({ ...request, decode: strictDecode });

    expect(result).toMatchObject({ bindingId: "binding-11", value: { admitted: true } });
    expect(request.allocateOrdinal).toHaveBeenCalledExactlyOnceWith(1);
    expect(bind.mock.calls.map(([, call]) => [call.ordinal, call.inputHash])).toEqual([
      [0, request.inputHash], [11, request.inputHash]
    ]);
    expect(start.mock.calls.map(([, bindingId]) => bindingId)).toEqual(["binding-0", "binding-11"]);
    expect(request.provider.run).toHaveBeenCalledTimes(2);
    expect(request.provider.run.mock.calls[1]![1]).toBe(request.request);
    expect(settle.mock.calls).toEqual([
      ["owner", "binding-0", expect.objectContaining({
        state: "FAILED", errorCode: "memory_classifier_output_invalid",
        decodeReason: "digest_contract_summary_length", acceptedOutputHash: null,
        usage: expect.objectContaining({ outputTokens: 900, totalTokens: 920 })
      })],
      ["owner", "binding-11", expect.objectContaining({
        state: "SUCCEEDED", errorCode: null, usage: expect.objectContaining({ outputTokens: 5, totalTokens: 25 })
      })]
    ]);
    expect(request.count).toHaveBeenCalledExactlyOnceWith({ where: expect.objectContaining({
      errorCode: "memory_classifier_output_invalid", logicalRole: request.role,
      memoryJobId: "owned-job", ownerType: "JOB", state: "FAILED", userId: "owner"
    }) });
    expect(logEvent).toHaveBeenCalledExactlyOnceWith("service_operation", {
      action: "retry", attempt: 1, code: "memory_classifier_output_invalid",
      job_id: "owned-job", outcome: "failed", stage: "validate", subsystem: "memory"
    });
  });

  it("hands the accepted retry's own ordinal to its durable result owner", async () => {
    const request = retryInput();
    const persistResult = vi.fn().mockResolvedValue(undefined);
    (request.provider.run as Run).mockResolvedValueOnce(answer(false)).mockResolvedValueOnce(answer(true));
    await executeGovernedMemoryStructuredOutput({ ...request, decode: strictDecode, persistResult });
    expect(settleDurable).toHaveBeenCalledExactlyOnceWith("owner", "binding-11",
      expect.objectContaining({ state: "SUCCEEDED" }), expect.any(Function));
    expect(persistResult).toHaveBeenCalledExactlyOnceWith(tx, expect.objectContaining({
      ordinal: 11, inputHash: request.inputHash, value: { admitted: true }
    }));
  });

  it("records the transport decode reason of a malformed answer before retrying", async () => {
    const request = retryInput({ allocateOrdinal: async () => 1 });
    (request.provider.run as Run).mockRejectedValueOnce(invalidJson()).mockResolvedValueOnce(answer(true));
    await expect(executeGovernedMemoryStructuredOutput({ ...request, decode: strictDecode }))
      .resolves.toMatchObject({ bindingId: "binding-1" });
    expect(settle).toHaveBeenNthCalledWith(1, "owner", "binding-0", expect.objectContaining({
      state: "FAILED", errorCode: "memory_classifier_output_invalid", decodeReason: "invalid_json",
      providerResponseId: "provider-response", usage: expect.objectContaining({ outputTokens: 7 })
    }));
  });

  it("stops after three calls and rethrows the last call's own error", async () => {
    const request = retryInput();
    const failures = [new Error("first"), new Error("second"), new Error("third")];
    let calls = 0;
    (request.provider.run as Run).mockResolvedValue(answer(false));
    await expect(executeGovernedMemoryStructuredOutput({
      ...request, decode: () => { throw failures[calls++]; }
    })).rejects.toBe(failures[2]);
    expect(request.provider.run).toHaveBeenCalledTimes(3);
    expect(request.allocateOrdinal.mock.calls).toEqual([[1], [2]]);
    expect(settle.mock.calls.map(([, bindingId, settlement]) =>
      [bindingId, settlement.state, settlement.errorCode, settlement.decodeReason])).toEqual([
      ["binding-0", "FAILED", "memory_classifier_output_invalid", "role_contract"],
      ["binding-11", "FAILED", "memory_classifier_output_invalid", "role_contract"],
      ["binding-12", "FAILED", "memory_classifier_output_invalid", "role_contract"]
    ]);
    expect(logEvent).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["provider_unavailable", () => new MemoryStructuredOutputProviderError(null, null,
      { cause: new Error("transport_lost") }), "FAILED", "memory_classifier_provider_unavailable"],
    ["output_limit", () => new MemoryStructuredOutputProviderError(null, { outputTokens: 4096 },
      { cause: Object.assign(new Error("bounded"), { code: "structured_output_output_limit_exceeded" }) }),
    "FAILED", "memory_classifier_output_limit_exceeded"]
  ] as const)("never retries %s", async (_name, failure, state, errorCode) => {
    const request = retryInput();
    const error = failure();
    (request.provider.run as Run).mockRejectedValue(error);
    await expect(executeGovernedMemoryStructuredOutput({ ...request, decode: strictDecode })).rejects.toBe(error);
    expect(settle).toHaveBeenCalledExactlyOnceWith("owner", "binding-0", expect.objectContaining({
      state, errorCode, decodeReason: null
    }));
    expect(request.provider.run).toHaveBeenCalledOnce();
    expect(request.allocateOrdinal).not.toHaveBeenCalled();
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("never retries a cancelled call, even when its answer was malformed", async () => {
    const request = retryInput();
    const controller = new AbortController();
    controller.abort();
    const error = invalidJson();
    (request.provider.run as Run).mockRejectedValue(error);
    await expect(executeGovernedMemoryStructuredOutput({
      ...request, decode: strictDecode, signal: controller.signal
    })).rejects.toBe(error);
    expect(settle).toHaveBeenCalledExactlyOnceWith("owner", "binding-0", expect.objectContaining({
      state: "CANCELLED", errorCode: "memory_classifier_cancelled", decodeReason: null
    }));
    expect(request.allocateOrdinal).not.toHaveBeenCalled();
  });

  it("checks cancellation before a retry and keeps the settled rejection", async () => {
    const request = retryInput();
    const controller = new AbortController();
    (request.provider.run as Run).mockImplementation(async () => {
      controller.abort();
      return answer(false);
    });
    await expect(executeGovernedMemoryStructuredOutput({
      ...request, decode: strictDecode, signal: controller.signal
    })).rejects.toBeInstanceOf(MemoryOutputViolationError);
    expect(settle).toHaveBeenCalledExactlyOnceWith("owner", "binding-0", expect.objectContaining({
      state: "FAILED", errorCode: "memory_classifier_output_invalid"
    }));
    expect(request.provider.run).toHaveBeenCalledOnce();
    expect(request.allocateOrdinal).not.toHaveBeenCalled();
  });

  it("never retries an invalid binding or a failed settlement", async () => {
    const binding = retryInput();
    start.mockResolvedValueOnce({ snapshot: { logicalRole: "MEMORY_SYNTHESIZE", requiresStrictStructuredOutput: true,
      providerExecutionSnapshot: { providerFamily: "fixture", providerModelId: "configured-model" } } });
    await expect(executeGovernedMemoryStructuredOutput({ ...binding, decode: strictDecode }))
      .rejects.toThrow("memory_classifier_binding_invalid");
    expect(binding.provider.run).not.toHaveBeenCalled();
    expect(binding.allocateOrdinal).not.toHaveBeenCalled();

    const lost = retryInput();
    (lost.provider.run as Run).mockResolvedValue(answer(false));
    settle.mockRejectedValueOnce(new Error("settlement_lost"));
    await expect(executeGovernedMemoryStructuredOutput({ ...lost, decode: strictDecode }))
      .rejects.toThrow("settlement_lost");
    expect(lost.provider.run).toHaveBeenCalledOnce();
    expect(lost.allocateOrdinal).not.toHaveBeenCalled();
  });

  it("settles a pre-dispatch fence CANCELLED without usage and never retries it", async () => {
    const request = retryInput();
    const fence = new MemoryStructuredOutputDispatchFenced("memory_maintenance_source_stale");
    (request.provider.run as Run).mockRejectedValue(fence);
    await expect(executeGovernedMemoryStructuredOutput({ ...request, decode: strictDecode })).rejects.toBe(fence);
    expect(fence).toMatchObject({ code: "memory_maintenance_source_stale", message: "memory_maintenance_source_stale" });
    expect(settle).toHaveBeenCalledExactlyOnceWith("owner", "binding-0", {
      acceptedOutputHash: null, errorCode: "memory_classifier_dispatch_fenced",
      providerResponseId: null, state: "CANCELLED", usage: unavailableMemoryReportedUsage
    });
    expect(request.allocateOrdinal).not.toHaveBeenCalled();
    expect(new MemoryStructuredOutputDispatchFenced("Private text!").code).toBe("memory_classifier_dispatch_fenced");
  });

  it("opens the per-owner breaker once the role holds enough invalid answers", async () => {
    const open = retryInput({ invalidBindings: MEMORY_STRUCTURED_OUTPUT_INVALID_OUTPUT_BREAKER });
    (open.provider.run as Run).mockResolvedValue(answer(false));
    await expect(executeGovernedMemoryStructuredOutput({ ...open, decode: strictDecode }))
      .rejects.toBeInstanceOf(MemoryOutputViolationError);
    expect(open.provider.run).toHaveBeenCalledOnce();
    expect(open.allocateOrdinal).not.toHaveBeenCalled();

    vi.clearAllMocks();
    const closed = retryInput({ invalidBindings: MEMORY_STRUCTURED_OUTPUT_INVALID_OUTPUT_BREAKER - 1 });
    (closed.provider.run as Run).mockResolvedValueOnce(answer(false)).mockResolvedValueOnce(answer(true));
    await expect(executeGovernedMemoryStructuredOutput({ ...closed, decode: strictDecode }))
      .resolves.toMatchObject({ bindingId: "binding-11" });
    expect(closed.provider.run).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a reused ordinal", { allocateOrdinal: () => 0 }],
    ["a fractional ordinal", { allocateOrdinal: () => 1.5 }]
  ] as const)("rejects %s before any retry dispatch", async (_name, options) => {
    const request = retryInput(options);
    (request.provider.run as Run).mockResolvedValue(answer(false));
    await expect(executeGovernedMemoryStructuredOutput({ ...request, decode: strictDecode }))
      .rejects.toEqual(new MemoryExecutionError("memory_execution_input_invalid"));
    expect(request.provider.run).toHaveBeenCalledOnce();
    expect(bind).toHaveBeenCalledOnce();
  });

  it.each([0, 4, 2.5])("refuses a budget of %s calls before binding", async (maxAttempts) => {
    const request = retryInput({ maxAttempts });
    await expect(executeGovernedMemoryStructuredOutput({ ...request, decode: strictDecode }))
      .rejects.toEqual(new MemoryExecutionError("memory_execution_input_invalid"));
    expect(bind).not.toHaveBeenCalled();
  });
});
