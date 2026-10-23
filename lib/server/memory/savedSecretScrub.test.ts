// @vitest-environment node
import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryDeletionClaim } from "./coordinator/types";

const mocks = vi.hoisted(() => ({
  forget: vi.fn(async (..._args: unknown[]) => 1),
  history: vi.fn(async (..._args: unknown[]) => 2),
  lock: vi.fn(async (..._args: unknown[]) => ({ memoryGeneration: 5, userId: "user-1" })),
  logEvent: vi.fn(),
  values: vi.fn(async (..._args: unknown[]): Promise<readonly string[]> => [])
}));
vi.mock("../observability", () => ({ logEvent: mocks.logEvent }));
vi.mock("../prisma", () => ({ prisma: {} }));
vi.mock("./persistence/savedSecrets", () => ({ memorySavedSecretValues: mocks.values }));
vi.mock("./persistence/transaction", () => ({ lockMemorySettings: mocks.lock }));
vi.mock("./lifecycle/repository", () => ({ forgetMemoryFactsHoldingSavedSecret: mocks.forget }));
vi.mock("./history/sourceLifecycle", () => ({ invalidateMemoryHistoryHoldingSavedSecret: mocks.history }));

import {
  createMemorySavedSecretScrubBackfill,
  createMemorySavedSecretScrubDeletionHandler,
  MEMORY_SAVED_SECRET_BACKFILL_TARGET_ID,
  MEMORY_SAVED_SECRET_SCRUB_PASS_LIMIT
} from "./savedSecretScrub";
import { MEMORY_SAVED_SECRET_SCRUB_TARGET_TYPE } from "./savedSecretScrubRequest";

const TOKEN = "tok_demo_7f3a9c21b8e4";
const NOW = new Date("2026-10-23T12:00:00.000Z");
const context = { now: () => NOW, signal: new AbortController().signal };

function claim(targetType = MEMORY_SAVED_SECRET_SCRUB_TARGET_TYPE): MemoryDeletionClaim {
  return {
    admissionAuthorizationId: null, admittedActiveLeafMessageId: null, admittedChatSourceRevision: null,
    alsoForgetOriginMemories: null, attemptCount: 1, claimToken: "claim-1", id: "deletion-1",
    leaseExpiresAt: new Date(NOW.getTime() + 60_000), memoryGeneration: 4, operation: "SOURCE_PURGE",
    recoveredLease: false, resumedFromBlocked: false, targetId: "revision-1", targetType, userId: "user-1"
  };
}

type Row = Record<string, unknown> & { id: string };
type Memory = Partial<Record<"chunks" | "evidence" | "facts" | "rounds" | "toolEvents" | "versions", Row[]>>;

/** Rows filtered by the `in` lists the handler passes; pages are never full. */
function db(memory: Memory) {
  const filtered = (rows: Row[] | undefined, where: Record<string, unknown>) => (rows ?? []).filter((row) =>
    Object.entries(where).every(([field, condition]) => {
      if (field === "userId" || field === "contentPurgedAt") return true;
      if (condition && typeof condition === "object" && "in" in condition) {
        return (condition.in as unknown[]).includes(row[field]);
      }
      return condition === undefined || row[field] === condition;
    }));
  const delegate = (rows: Row[] | undefined) => ({
    findMany: vi.fn(async (query: { where: Record<string, unknown> }) => filtered(rows, query.where))
  });
  return {
    memoryDeletionOutbox: { create: vi.fn(async (..._args: unknown[]) => ({})) },
    memoryEvidence: delegate(memory.evidence),
    memoryFact: delegate(memory.facts),
    memoryFactVersion: delegate(memory.versions),
    memoryRecallChunk: delegate(memory.chunks),
    memoryRecallRound: delegate(memory.rounds),
    memoryToolEvent: delegate(memory.toolEvents)
  };
}

const ready = () => ({ keyring: { id: "keyring" }, status: "ready" }) as never;

/** A token fact, its conflicted twin, a clean peer, and history in three chats. */
const memory: Memory = {
  chunks: [
    { chatId: "chat-visible", id: "chunk-1", safeProjectedText: `User: my token is ${TOKEN}`, state: "ACTIVE" },
    { chatId: "chat-clean", id: "chunk-2", safeProjectedText: "User: localhost", state: "ACTIVE" },
    { chatId: "chat-hidden", id: "chunk-3", safeProjectedText: `old ${TOKEN}`, state: "INVALIDATED" }
  ],
  evidence: [{ factVersionId: "v-2", id: "e-2", safeExcerpt: `the token ${TOKEN}` }],
  facts: [
    { currentVersionId: "v-1", id: "fact-1", state: "ACTIVE" },
    { currentVersionId: null, id: "fact-2", state: "CONFLICTED" }
  ],
  rounds: [],
  toolEvents: [{ chatId: "chat-tool", id: "event-1", safeProjectedText: "Tool observation", state: "ACTIVE",
    structuredIdentifiers: { error: `rejected ${TOKEN}` } }],
  versions: [
    { displayText: `My token is ${TOKEN}.`, factId: "fact-1", id: "v-1", rawTemporalExpression: null,
      state: "ACTIVE", structuredValue: null },
    { displayText: "My token is stored.", factId: "fact-2", id: "v-2", rawTemporalExpression: null,
      state: "CONFLICTING", structuredValue: null },
    { displayText: "I do not drink coffee.", factId: "fact-3", id: "v-3", rawTemporalExpression: null,
      state: "ACTIVE", structuredValue: { statement: "I do not drink coffee." } }
  ]
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.values.mockResolvedValue([TOKEN]);
});

describe("saved secret scrub deletion handler", () => {
  it("serves only its own target", async () => {
    await expect(createMemorySavedSecretScrubDeletionHandler(db({}) as never)
      .execute(claim("HISTORY_SOURCE@memory-history-source-v1"), context))
      .rejects.toMatchObject({ code: "memory_deletion_target_invalid" });
  });

  it("completes with nothing to apply when no value is saved or none is held", async () => {
    mocks.values.mockResolvedValueOnce([]);
    const empty = db(memory);
    await expect(createMemorySavedSecretScrubDeletionHandler(empty as never).execute(claim(), context))
      .resolves.toEqual({});
    expect(empty.memoryFactVersion.findMany).not.toHaveBeenCalled();
    await expect(createMemorySavedSecretScrubDeletionHandler(db({
      chunks: [{ chatId: "chat-clean", id: "chunk-2", safeProjectedText: "User: localhost", state: "ACTIVE" }]
    }) as never).execute(claim(), context)).resolves.toEqual({});
  });

  it("waits for the suppression keyring before forgetting a fact", async () => {
    const handler = createMemorySavedSecretScrubDeletionHandler(db(memory) as never, {
      keyring: () => ({ code: "memory_suppression_keyring_invalid", status: "blocked" })
    });
    await expect(handler.execute(claim(), context)).rejects.toMatchObject({
      code: "memory_suppression_keyring_invalid",
      retryable: true
    });
  });

  it("forgets held facts and cleans held chats after proving them again under the owner's lock", async () => {
    const execution = await createMemorySavedSecretScrubDeletionHandler(db(memory) as never, { keyring: ready })
      .execute(claim(), context);
    expect(execution.apply).toBeTypeOf("function");
    expect(mocks.forget).not.toHaveBeenCalled();

    const tx = db(memory);
    await execution.apply!(tx as never, claim());
    expect(mocks.lock).toHaveBeenCalledWith(tx, "user-1", false);
    // The commit reads only the scan's hits.
    expect(tx.memoryFactVersion.findMany.mock.calls[0]![0].where).toMatchObject({
      factId: { in: ["fact-1", "fact-2"] }
    });
    expect(tx.memoryRecallChunk.findMany.mock.calls[0]![0].where).toMatchObject({
      chatId: { in: ["chat-tool", "chat-visible", "chat-hidden"] }
    });
    expect(mocks.forget).toHaveBeenCalledWith(tx, { memoryGeneration: 5, userId: "user-1" },
      { id: "keyring" }, {
        facts: [{ expectedVersionId: "v-1", factId: "fact-1" }, { expectedVersionId: "v-2", factId: "fact-2" }],
        now: NOW
      });
    expect(mocks.history).toHaveBeenCalledWith(tx, { memoryGeneration: 5, userId: "user-1" },
      { hidden: ["chat-hidden"], visible: ["chat-tool", "chat-visible"] }, NOW);
    expect(tx.memoryDeletionOutbox.create).not.toHaveBeenCalled();
    expect(mocks.logEvent).toHaveBeenCalledWith("service_operation", expect.objectContaining({
      code: "memory_saved_secret_scrub", count: 3, outcome: "completed"
    }));
    expect(JSON.stringify(mocks.logEvent.mock.calls)).not.toContain(TOKEN);
  });

  it("finds a value in a JSON key or value, and only a saved value", async () => {
    const keyed = db({
      facts: [{ currentVersionId: "v-4", id: "fact-4", state: "ACTIVE" }],
      versions: [{ displayText: "A structured fact.", factId: "fact-4", id: "v-4", rawTemporalExpression: null,
        state: "ACTIVE", structuredValue: { nested: [{ [TOKEN]: true }] } }]
    });
    const execution = await createMemorySavedSecretScrubDeletionHandler(keyed as never, { keyring: ready })
      .execute(claim(), context);
    await execution.apply!(keyed as never, claim());
    expect(mocks.forget).toHaveBeenCalledWith(keyed, expect.anything(), expect.anything(), {
      facts: [{ expectedVersionId: "v-4", factId: "fact-4" }], now: NOW
    });
    mocks.values.mockResolvedValue([]);
    await expect(createMemorySavedSecretScrubDeletionHandler(db(memory) as never)
      .execute(claim(), context)).resolves.toEqual({});
  });

  it("leaves a fresh obligation when a pass reaches its limit", async () => {
    const facts = Array.from({ length: MEMORY_SAVED_SECRET_SCRUB_PASS_LIMIT }, (_, index) => ({
      currentVersionId: `v-${index}`, id: `fact-${index}`, state: "ACTIVE"
    }));
    const versions = facts.map((fact) => ({
      displayText: `token ${TOKEN}`, factId: fact.id, id: fact.currentVersionId, rawTemporalExpression: null,
      state: "ACTIVE", structuredValue: null
    }));
    const execution = await createMemorySavedSecretScrubDeletionHandler(db({ facts, versions }) as never,
      { keyring: ready }).execute(claim(), context);
    const tx = db({ facts, versions });
    await execution.apply!(tx as never, claim());
    expect(tx.memoryDeletionOutbox.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      memoryGeneration: 5,
      operation: "SOURCE_PURGE",
      targetType: MEMORY_SAVED_SECRET_SCRUB_TARGET_TYPE,
      userId: "user-1"
    }) });
  });

  it("does nothing under the lock when the hits are gone", async () => {
    const execution = await createMemorySavedSecretScrubDeletionHandler(db(memory) as never, { keyring: ready })
      .execute(claim(), context);
    mocks.values.mockResolvedValueOnce([]);
    await execution.apply!(db(memory) as never, claim());
    expect(mocks.forget).not.toHaveBeenCalled();
    expect(mocks.history).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });
});

describe("saved secret scrub backfill", () => {
  const key = () => Buffer.alloc(32, 1);

  function backfillDb(owners: readonly string[]) {
    return {
      $queryRaw: vi.fn(async (_query: Prisma.Sql) => owners.map((id) => ({ id }))),
      memoryDeletionOutbox: { createMany: vi.fn(async (..._args: unknown[]) => ({ count: 1 })) },
      userMemorySettings: { findUnique: vi.fn(async (..._args: unknown[]) => ({ memoryGeneration: 3 })) }
    };
  }

  it("enqueues a cleanup for an owner with a screened value and records the others done, holding no value", async () => {
    mocks.values.mockImplementation(async (_db, userId) => userId === "user-a" ? [TOKEN] : []);
    const db = backfillDb(["user-a", "user-b"]);
    await expect(createMemorySavedSecretScrubBackfill(db as never, { key }).reconcile())
      .resolves.toEqual({ enqueued: 1, settled: 1 });
    expect(db.memoryDeletionOutbox.createMany).toHaveBeenNthCalledWith(1, {
      data: [{
        memoryGeneration: 3, operation: "SOURCE_PURGE", targetId: MEMORY_SAVED_SECRET_BACKFILL_TARGET_ID,
        targetType: MEMORY_SAVED_SECRET_SCRUB_TARGET_TYPE, userId: "user-a"
      }],
      skipDuplicates: true
    });
    expect(db.memoryDeletionOutbox.createMany).toHaveBeenNthCalledWith(2, {
      data: [expect.objectContaining({
        completedAt: expect.any(Date), lastAuditAt: expect.any(Date), state: "SUCCEEDED",
        targetId: MEMORY_SAVED_SECRET_BACKFILL_TARGET_ID, userId: "user-b"
      })],
      skipDuplicates: true
    });
    expect(mocks.logEvent).toHaveBeenCalledWith("service_operation", expect.objectContaining({
      code: "memory_saved_secret_backfill", completed_count: 1, count: 1, outcome: "completed"
    }));
    expect(JSON.stringify([db.memoryDeletionOutbox.createMany.mock.calls, mocks.logEvent.mock.calls]))
      .not.toContain(TOKEN);
  });

  it("takes a bounded batch and settles the process once no owner is left", async () => {
    const db = backfillDb([]);
    const backfill = createMemorySavedSecretScrubBackfill(db as never, { key, limit: 4 });
    await expect(backfill.reconcile()).resolves.toEqual({ enqueued: 0, settled: 0 });
    expect(db.$queryRaw.mock.calls[0]![0].values)
      .toEqual(expect.arrayContaining([4, MEMORY_SAVED_SECRET_SCRUB_TARGET_TYPE]));
    await backfill.reconcile();
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    // A pass scoped to given owners still reads, and never settles the process.
    await backfill.reconcile({ userIds: ["user-a"] });
    expect(db.$queryRaw).toHaveBeenCalledTimes(2);
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it("changes nothing without the encryption key, so no owner is recorded done unread", async () => {
    const db = backfillDb(["user-a"]);
    const backfill = createMemorySavedSecretScrubBackfill(db as never, {
      key: () => { throw new Error("encryption key unavailable"); }
    });
    await expect(backfill.reconcile()).resolves.toEqual({ enqueued: 0, settled: 0 });
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(db.memoryDeletionOutbox.createMany).not.toHaveBeenCalled();
    expect(mocks.logEvent).toHaveBeenCalledWith("service_operation", expect.objectContaining({
      code: "memory_saved_secret_unreadable", outcome: "degraded"
    }));
  });

  it("counts an owner a concurrent pass recorded first as nothing, and keeps going past a failing owner", async () => {
    const db = backfillDb(["user-a", "user-b", "user-c"]);
    db.memoryDeletionOutbox.createMany
      .mockResolvedValueOnce({ count: 0 })
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce({ count: 1 });
    await expect(createMemorySavedSecretScrubBackfill(db as never, { key }).reconcile())
      .resolves.toEqual({ enqueued: 1, settled: 0 });
    expect(mocks.logEvent).toHaveBeenCalledWith("service_operation", expect.objectContaining({
      code: "memory_saved_secret_backfill", outcome: "degraded"
    }));
  });
});
