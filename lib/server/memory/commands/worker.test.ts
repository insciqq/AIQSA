import { serializeEvent } from "../../observability/runtime.cjs";
import { Prisma } from "@prisma/client";
import { MemoryPersistenceError, rememberMemoryPersistenceFailure } from "../persistence/errors";
import { ExplicitMemoryServiceError } from "../explicit/service";
import { MemoryLifecycleServiceError } from "../lifecycle/service";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeMemoryActionControlDecision, type MemoryActionIntent } from "../../../contracts/memoryActionIntent";
import type { MemoryJobClaim } from "../coordinator/types";
import { createPrismaMemoryCommandHandler, decodeMemoryCommandIntent } from "./worker";

const mocks = vi.hoisted(() => ({ source: vi.fn(), execute: vi.fn(), attempt: vi.fn(), log: vi.fn() }));
vi.mock("../coordinator/observability", () => ({ memoryAttempt: mocks.attempt }));
vi.mock("./sourceAuthority", () => ({ requireMemoryCommandSource: mocks.source }));
vi.mock("../persistence/transaction", () => ({ withLockedMemoryTransaction: (
  client: unknown, _userId: string, callback: (tx: unknown, settings: unknown) => Promise<unknown>
) => callback(client, { useMemoryFacts: true, learnAutomatically: true, referenceChatHistory: true }) }));
vi.mock("../actions/intentExecutor", () => ({ createMemoryIntentActionExecutor: () => ({ execute: mocks.execute }) }));
vi.mock("./services", () => ({ createMemoryCommandServices: () => ({ explicitService: {}, lifecycleService: {} }) }));
vi.mock("../../observability", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../observability")>(), logEvent: mocks.log
}));

const intent: MemoryActionIntent = { action: "NONE", aggregationRequested: false,
  applyResponsePreferences: false, category: null, categoryHint: null, confidenceBand: "HIGH",
  entityMentions: [], memoryUseful: false, pastChatsUseful: false,
  profileRequested: false, queryDecompositions: [], queryText: null, reasonCode: "none",
  recencyRequested: false, retrievalMode: "TARGETED_CURRENT", referencedMemoryRef: null,
  replacementStatement: null, responsePreference: false, sensitiveDomainHint: null,
  sensitivity: "NORMAL", statement: null, targetQuery: null, temporalAsOf: null,
  temporalFrom: null, temporalIntent: "CURRENT", temporalTo: null, thisChatOnly: false };
const job = { id: "command-1", kind: "MEMORY_COMMAND", userId: "owner", claimToken: "lease",
  chatId: "chat", sourceMessageId: "message", pipelineVersion: "memory-command-v1"
} as MemoryJobClaim;

function fixture(commandStatus = "PENDING", commandIntent: unknown = null) {
  const client = { memoryJob: {
    findFirst: vi.fn().mockResolvedValue({ commandStatus, commandIntent }),
    update: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({ count: 1 })
  }, memoryExecutionBinding: { findFirst: vi.fn().mockResolvedValue(null) } };
  const control = { decide: vi.fn().mockResolvedValue({ bindingId: "binding", intent, status: "READY" }) };
  const handler = createPrismaMemoryCommandHandler(client as never, { control });
  const context = { now: () => new Date(), setStage: vi.fn(), signal: new AbortController().signal };
  return { client, control, handler, context };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.source.mockResolvedValue({ job: { chatId: "chat" }, modelRunId: "run", safeText: "hello" });
});

describe("durable Memory command worker", () => {
  it("publishes a committed mutation receipt after a crash without reading source or dispatching again", async () => {
    const f = fixture("COMMITTED");
    expect(await f.handler.execute(job, f.context)).toMatchObject({ stage: "command_committed" });
    expect(mocks.source).not.toHaveBeenCalled();
    expect(f.control.decide).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("does not replay a classifier dispatched before a crash without a checkpoint", async () => {
    const f = fixture();
    f.client.memoryExecutionBinding.findFirst.mockResolvedValue({ state: "SUCCEEDED", startedAt: new Date() } as never);
    expect(await f.handler.execute(job, f.context)).toMatchObject({ stage: "command_unknown" });
    expect(f.control.decide).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("resumes a durable decoded SAVE checkpoint without paying for classification again", async () => {
    const saved = { ...intent, action: "SAVE" as const, statement: "I prefer green", reasonCode: "save_request" as const };
    const f = fixture("RUNNING", { bindingId: "binding", intent: saved });
    mocks.execute.mockResolvedValueOnce({ operation: "SAVE", status: "COMMITTED" });
    expect(await f.handler.execute(job, f.context)).toMatchObject({ stage: "command_committed" });
    expect(f.control.decide).not.toHaveBeenCalled();
    expect(mocks.execute).toHaveBeenCalledWith(expect.objectContaining({
      intent: saved, owner: { type: "JOB", memoryJobId: job.id }
    }));
  });

  it("retries only a known replay-safe transient classifier once with a new durable slot", async () => {
    const f = fixture();
    f.control.decide.mockResolvedValueOnce({ reason: "memory_action_intent_transient", status: "UNAVAILABLE" } as never);
    expect(await f.handler.execute(job, f.context)).toMatchObject({ stage: "command_rejected" });
    expect(f.control.decide).toHaveBeenCalledTimes(2);
    expect(f.control.decide).toHaveBeenNthCalledWith(1, expect.objectContaining({ ordinal: 0 }));
    expect(f.control.decide).toHaveBeenNthCalledWith(2, expect.objectContaining({ ordinal: 2 }));
  });

  it("retries a settled invalid classifier answer once in the reserved slot and logs it content-free", async () => {
    const f = fixture();
    f.control.decide.mockResolvedValueOnce({ bindingId: "binding-0", reason: "memory_action_intent_invalid", status: "UNAVAILABLE" } as never);
    expect(await f.handler.execute(job, f.context)).toMatchObject({ stage: "command_rejected" });
    expect(f.control.decide.mock.calls.map(([request]) => (request as { ordinal: number }).ordinal)).toEqual([0, 2]);
    expect(mocks.log).toHaveBeenCalledExactlyOnceWith("service_operation", {
      action: "retry", attempt: 2, code: "memory_action_intent_invalid", job_id: job.id,
      outcome: "failed", stage: "validate", subsystem: "memory"
    });
    expect(JSON.parse(serializeEvent("service_operation", mocks.log.mock.calls[0]![1])!))
      .toMatchObject({ code: "memory_action_intent_invalid", attempt: 2, action: "retry" });
  });

  it("stops after the reserved slot when transient and invalid failures repeat", async () => {
    for (const [first, second] of [
      ["memory_action_intent_invalid", "memory_action_intent_invalid"],
      ["memory_action_intent_transient", "memory_action_intent_invalid"],
      ["memory_action_intent_invalid", "memory_action_intent_transient"]
    ]) {
      const f = fixture();
      f.control.decide.mockResolvedValueOnce({ reason: first, status: "UNAVAILABLE" } as never)
        .mockResolvedValueOnce({ reason: second, status: "UNAVAILABLE" } as never);
      expect(await f.handler.execute(job, f.context)).toMatchObject({ stage: "command_failed" });
      expect(f.control.decide.mock.calls.map(([request]) => (request as { ordinal: number }).ordinal)).toEqual([0, 2]);
    }
  });

  it.each([
    ["memory_action_intent_statement_too_long", "command_failed"],
    ["memory_action_intent_unavailable", "command_failed"],
    ["memory_action_intent_input_too_long", "command_failed"],
    ["memory_action_intent_outcome_unknown", "command_unknown"]
  ])("never retries a %s classifier failure", async (reason, stage) => {
    const f = fixture();
    f.control.decide.mockResolvedValueOnce({ reason, status: "UNAVAILABLE" } as never);
    expect(await f.handler.execute(job, f.context)).toMatchObject({ stage });
    expect(f.control.decide).toHaveBeenCalledOnce();
    expect(mocks.log).not.toHaveBeenCalled();
  });

  it("does not retry an invalid answer after cancellation", async () => {
    const f = fixture();
    const abort = new AbortController();
    f.control.decide.mockImplementationOnce(async () => {
      abort.abort();
      return { reason: "memory_action_intent_invalid", status: "UNAVAILABLE" };
    });
    expect(await f.handler.execute(job, { ...f.context, signal: abort.signal })).toMatchObject({ stage: "command_failed" });
    expect(f.control.decide).toHaveBeenCalledOnce();
  });

  it.each(["memory_action_intent_invalid", "memory_action_intent_transient"])(
    "spends the reserved slot once on a re-claim after a settled %s first call", async (errorCode) => {
      const f = fixture();
      f.client.memoryExecutionBinding.findFirst.mockResolvedValue({ ordinal: 0, state: "FAILED", errorCode, startedAt: new Date() } as never);
      f.control.decide.mockResolvedValueOnce({ reason: "memory_action_intent_invalid", status: "UNAVAILABLE" } as never);
      expect(await f.handler.execute(job, f.context)).toMatchObject({ stage: "command_failed" });
      expect(f.control.decide).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ordinal: 2 }));
      expect(mocks.log).toHaveBeenCalledExactlyOnceWith("service_operation", expect.objectContaining({ code: errorCode }));
    });

  it.each([
    { ordinal: 0, state: "FAILED", errorCode: "memory_action_intent_statement_too_long" },
    { ordinal: 0, state: "FAILED", errorCode: "memory_action_intent_unavailable" },
    { ordinal: 0, state: "RUNNING", errorCode: null },
    { ordinal: 0, state: "OUTCOME_UNKNOWN", errorCode: "memory_action_intent_outcome_unknown" },
    { ordinal: 2, state: "FAILED", errorCode: "memory_action_intent_invalid" },
    { ordinal: 2, state: "FAILED", errorCode: "memory_action_intent_transient" },
    { ordinal: 2, state: "RUNNING", errorCode: null }
  ])("never dispatches again on a re-claim after $state $errorCode at ordinal $ordinal", async (binding) => {
    const f = fixture();
    f.client.memoryExecutionBinding.findFirst.mockResolvedValue({ ...binding, startedAt: new Date() } as never);
    expect(await f.handler.execute(job, f.context)).toMatchObject({ stage: "command_unknown" });
    expect(f.control.decide).not.toHaveBeenCalled();
  });

  it("fails closed after a selector dispatch without its exact target checkpoint", async () => {
    const forgotten = { ...intent, action: "FORGET" as const, targetQuery: "green", reasonCode: "forget_request" as const };
    const f = fixture("RUNNING", { bindingId: "binding", intent: forgotten });
    f.client.memoryExecutionBinding.findFirst.mockResolvedValue({ ordinal: 1, state: "RUNNING", startedAt: new Date() } as never);
    expect(await f.handler.execute(job, f.context)).toMatchObject({ stage: "command_unknown" });
    expect(f.control.decide).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("requires an exact checkpoint shape and does not repair altered decoded content", () => {
    const value = { bindingId: "binding", intent };
    expect(decodeMemoryCommandIntent(value)).toEqual(value);
    expect(decodeMemoryCommandIntent({ ...value, hidden: "data" })).toBeNull();
    expect(decodeMemoryCommandIntent({ ...value, bindingId: " binding" })).toBeNull();
    expect(decodeMemoryCommandIntent({ ...value, intent: { ...intent, statement: "irrelevant" } })).toBeNull();
  });

  it.each([
    { error: new MemoryPersistenceError("memory_mutation_authorization_invalid"), code: "memory_mutation_authorization_invalid", prisma_code: "unknown" },
    { error: new ExplicitMemoryServiceError("memory_statement_invalid"), code: "memory_statement_invalid", prisma_code: "unknown" },
    { error: new MemoryLifecycleServiceError("memory_version_stale"), code: "memory_version_stale", prisma_code: "unknown" },
    { error: new Prisma.PrismaClientKnownRequestError("PRIVATE_STATEMENT", { clientVersion: "test", code: "P2002", meta: { statement: "PRIVATE_STATEMENT" } }), code: "memory_command_database_failed", prisma_code: "P2002" },
    { error: Object.assign(new Error("PRIVATE_STATEMENT"), { code: "PRIVATE_STATEMENT" }), code: "memory_command_failed", prisma_code: "unknown" }
  ])("reports content-free command exceptions as $code/$prisma_code", async ({ error, code, prisma_code }) => {
    const saved = { ...intent, action: "SAVE" as const, statement: "PRIVATE_STATEMENT", reasonCode: "save_request" as const };
    const f = fixture("RUNNING", { bindingId: "binding", intent: saved });
    mocks.execute.mockRejectedValueOnce(error);
    expect(await f.handler.execute(job, f.context)).toMatchObject({ stage: "command_failed" });
    expect(mocks.attempt).toHaveBeenCalledWith(job, { code, prisma_code, stage: "publish", work_stage: "write", outcome: "failed", action: "fail" });
    expect(JSON.stringify(mocks.attempt.mock.calls)).not.toContain("PRIVATE_STATEMENT");
    const logged = serializeEvent("job_attempt", { subsystem: "memory", job_id: job.id,
      ...mocks.attempt.mock.calls[0]![1] });
    expect(JSON.parse(logged!)).toMatchObject({ code, prisma_code });
    expect(logged).not.toContain("PRIVATE_STATEMENT");
  });

  it("keeps the precise mapped persistence reason and a committed receipt", async () => {
    const error = new MemoryLifecycleServiceError("memory_action_failed");
    rememberMemoryPersistenceFailure(error, "memory_forget_peer_ineligible_after_fence");
    const saved = { ...intent, action: "SAVE" as const, statement: "I prefer green", reasonCode: "save_request" as const };
    const f = fixture("RUNNING", { bindingId: "binding", intent: saved });
    f.client.memoryJob.findFirst.mockResolvedValueOnce({ commandStatus: "RUNNING", commandIntent: { bindingId: "binding", intent: saved } })
      .mockResolvedValueOnce({ commandStatus: "COMMITTED", commandIntent: null });
    mocks.execute.mockRejectedValueOnce(error);
    expect(await f.handler.execute(job, f.context)).toMatchObject({ stage: "command_committed" });
    expect(mocks.attempt).toHaveBeenCalledWith(job, expect.objectContaining({
      code: "memory_forget_peer_ineligible_after_fence", outcome: "degraded", action: "complete"
    }));
  });

  it("rejects stale exact-source authority before a provider dispatch", async () => {
    const f = fixture(); mocks.source.mockRejectedValueOnce(new Error("stale"));
    expect(await f.handler.execute(job, f.context)).toMatchObject({ stage: "command_stale" });
    expect(f.control.decide).not.toHaveBeenCalled();
  });

  it("classifies with the durable job owner and checkpoints before declining an ordinary message", async () => {
    const f = fixture();
    expect(await f.handler.execute(job, f.context)).toMatchObject({ stage: "command_rejected" });
    expect(f.control.decide).toHaveBeenCalledWith(expect.objectContaining({ owner: { type: "JOB", memoryJobId: job.id } }));
    expect(f.client.memoryJob.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      commandIntent: { bindingId: "binding", intent }, commandOperation: "UNKNOWN"
    }) }));
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(f.client.memoryJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      commandStatus: "REJECTED", commandResult: { classification: "NONE" }
    }) }));
  });

  it("releases automatic learning for a real NONE decision without a confidence field", async () => {
    const decoded = decodeMemoryActionControlDecision({ decision: {
      action: "NONE", reasonCode: "no_memory_request"
    } }, "I prefer green notebooks.");
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error(decoded.code);
    // NONE has no wire confidence; the retained representation defaults LOW.
    expect(decoded.value.confidenceBand).toBe("LOW");
    const f = fixture();
    f.control.decide.mockResolvedValueOnce({ bindingId: "binding", status: "READY", intent: decoded.value });
    await f.handler.execute(job, f.context);
    expect(f.client.memoryJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ commandResult: { classification: "NONE" } })
    }));
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    { action: "SAVE" as const, reasonCode: "save_request" as const, statement: "I prefer green" },
    { action: "NONE" as const, reasonCode: "no_memory_request" as const }
  ])("settles a $action checkpoint of an earlier intent version visibly without new work", async (fields) => {
    // An older stored decision keeps a field this intent version dropped. Its
    // classifier proof binds that shape, so it can never authorize again.
    const current = { ...intent, ...fields };
    expect(decodeMemoryCommandIntent({ bindingId: "binding", intent: current })).not.toBeNull();
    const checkpoint = { bindingId: "binding", intent: { ...current, retiredHint: false } };
    expect(decodeMemoryCommandIntent(checkpoint)).toBeNull();
    const f = fixture("RUNNING", checkpoint);
    expect(await f.handler.execute(job, f.context)).toMatchObject({ stage: "command_failed" });
    expect(f.control.decide).not.toHaveBeenCalled();
    expect(f.client.memoryExecutionBinding.findFirst).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.attempt).toHaveBeenCalledExactlyOnceWith(job, {
      action: "fail", code: "memory_command_checkpoint_invalid", outcome: "failed", stage: "validate"
    });
    // The reason survives the content-free log boundary instead of "unknown".
    const [, logged] = mocks.attempt.mock.calls[0]!;
    expect(JSON.parse(serializeEvent("job_attempt", { ...logged, job_id: job.id, subsystem: "memory" })!))
      .toMatchObject({ code: "memory_command_checkpoint_invalid", outcome: "failed" });
    expect(f.client.memoryJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { commandIntent: Prisma.DbNull, commandResult: Prisma.DbNull, commandStatus: "FAILED" }
    }));
  });

  it.each([
    { reasonCode: "uncertain" },
    { reasonCode: "unsupported" },
    { reasonCode: "low_confidence" }
  ])("does not release learning for excluded NONE $reasonCode", async (decision) => {
    const decoded = decodeMemoryActionControlDecision({ decision: { action: "NONE", ...decision } }, "Synthetic request");
    if (!decoded.ok) throw new Error(decoded.code);
    const f = fixture();
    f.control.decide.mockResolvedValueOnce({ bindingId: "binding", status: "READY", intent: decoded.value });
    await f.handler.execute(job, f.context);
    expect(f.client.memoryJob.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ commandResult: { classification: "NONE" } })
    }));
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
