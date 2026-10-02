import { serializeEvent } from "../../observability/runtime.cjs";
import { Prisma } from "@prisma/client";
import { MemoryPersistenceError, rememberMemoryPersistenceFailure } from "../persistence/errors";
import { ExplicitMemoryServiceError } from "../explicit/service";
import { MemoryLifecycleServiceError } from "../lifecycle/service";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeMemoryActionControlDecision, type MemoryActionIntent } from "../../../contracts/memoryActionIntent";
import type { MemoryJobClaim } from "../coordinator/types";
import { createPrismaMemoryCommandHandler, decodeMemoryCommandIntent } from "./worker";

const mocks = vi.hoisted(() => ({ source: vi.fn(), execute: vi.fn(), attempt: vi.fn() }));
vi.mock("../coordinator/observability", () => ({ memoryAttempt: mocks.attempt }));
vi.mock("./sourceAuthority", () => ({ requireMemoryCommandSource: mocks.source }));
vi.mock("../persistence/transaction", () => ({ withLockedMemoryTransaction: (
  client: unknown, _userId: string, callback: (tx: unknown, settings: unknown) => Promise<unknown>
) => callback(client, { useMemoryFacts: true, learnAutomatically: true, referenceChatHistory: true }) }));
vi.mock("../actions/intentExecutor", () => ({ createMemoryIntentActionExecutor: () => ({ execute: mocks.execute }) }));
vi.mock("./services", () => ({ createMemoryCommandServices: () => ({ explicitService: {}, lifecycleService: {} }) }));

const intent: MemoryActionIntent = { action: "NONE", aggregationRequested: false,
  applyResponsePreferences: false, category: null, categoryHint: null, confidenceBand: "HIGH",
  entityMentions: [], memoryUseful: false, patternExclusionRequested: false, pastChatsUseful: false,
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

  it("releases automatic learning for a real v13 NONE decision without a confidence field", async () => {
    const decoded = decodeMemoryActionControlDecision({ decision: {
      action: "NONE", patternExclusionRequested: false, reasonCode: "no_memory_request"
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

  it("ignores a retained pattern exclusion when releasing learning for a v13 NONE", async () => {
    const decoded = decodeMemoryActionControlDecision({ decision: {
      action: "NONE", patternExclusionRequested: true, reasonCode: "no_memory_request"
    } }, "Synthetic request");
    if (!decoded.ok) throw new Error(decoded.code);
    const f = fixture();
    f.control.decide.mockResolvedValueOnce({ bindingId: "binding", status: "READY", intent: decoded.value });
    await f.handler.execute(job, f.context);
    expect(f.client.memoryJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ commandResult: { classification: "NONE" } })
    }));
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("executes a stored checkpoint carrying the retired pattern exclusion", async () => {
    // A checkpoint accepted before the retirement: the decoder keeps the
    // field only beside a current targeted Memory read.
    const excluded = { ...intent, memoryUseful: true, patternExclusionRequested: true,
      queryText: "green notebooks" };
    const saved = { ...excluded, action: "SAVE" as const, reasonCode: "save_request" as const,
      statement: "I prefer green" };
    const checkpoint = { bindingId: "binding", intent: saved };
    expect(decodeMemoryCommandIntent(checkpoint)).toEqual(checkpoint);
    const f = fixture("RUNNING", checkpoint);
    mocks.execute.mockResolvedValueOnce({ operation: "SAVE", status: "COMMITTED" });
    expect(await f.handler.execute(job, f.context)).toMatchObject({ stage: "command_committed" });
    expect(f.control.decide).not.toHaveBeenCalled();
    expect(mocks.execute).toHaveBeenCalledWith(expect.objectContaining({ intent: saved }));

    const declined = { bindingId: "binding", intent: { ...excluded,
      reasonCode: "no_memory_request" as const } };
    expect(decodeMemoryCommandIntent(declined)).toEqual(declined);
    const g = fixture("RUNNING", declined);
    expect(await g.handler.execute(job, g.context)).toMatchObject({ stage: "command_rejected" });
    expect(g.client.memoryJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ commandResult: { classification: "NONE" } })
    }));
  });

  it.each([
    { reasonCode: "uncertain", patternExclusionRequested: false },
    { reasonCode: "unsupported", patternExclusionRequested: false },
    { reasonCode: "low_confidence", patternExclusionRequested: false }
  ])("does not release learning for excluded v13 NONE $reasonCode/$patternExclusionRequested", async (decision) => {
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
