import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  createAutomaticMaintenanceFact, createMaintenanceMessage, createMaintenanceOwner, deleteMaintenanceOwner,
  drainMaintenanceForgetPurges, maintenanceFixtureTime, settleMaintenanceJob
} from "@/tests/support/memoryMaintenance";
import { prisma } from "../../prisma";
import type { MemoryJobClaim } from "../coordinator/types";
import { createPrismaMemoryMaintenanceHandler } from "./handler";
import { MEMORY_MAINTENANCE_BLOCKED_RECHECK_MS, MEMORY_MAINTENANCE_POLICY_VERSION } from "./policy";
import { reconcileMemoryMaintenanceWork, scheduleOwnerMemoryMaintenance } from "./reconcile";
import { createPrismaMemoryMaintenanceRepository } from "./repository";
import { loadMemoryMaintenanceSources } from "./source";

const owners: string[] = [];
async function owner(): Promise<string> {
  const userId = await createMaintenanceOwner("memory-cleanup-pass");
  owners.push(userId);
  return userId;
}
afterEach(async () => {
  for (const userId of owners.splice(0)) await deleteMaintenanceOwner(userId);
});
afterAll(async () => { await prisma.$disconnect(); });

/** One planner pass from the beginning of the owner's versions. */
async function plan(userId: string, now = new Date()): Promise<number> {
  await prisma.userMemorySettings.update({ where: { userId }, data: { maintenanceCursor: null } });
  return scheduleOwnerMemoryMaintenance(prisma, userId, now);
}
function reviews(userId: string) {
  return prisma.memoryMaintenanceReview.findMany({ where: { userId, policyVersion: MEMORY_MAINTENANCE_POLICY_VERSION },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
}

describe("maintenance policy v3 cleanup pass", () => {
  it("removes a two-version fact with different spans in one apply without affecting the batch", async () => {
    const userId = await owner();
    const before = await createMaintenanceMessage(userId, "The parcel ships on Tuesday.");
    const after = await createMaintenanceMessage(userId, "Update: the parcel now ships on Thursday.");
    const shortTerm = await createAutomaticMaintenanceFact(userId, [
      { statement: "The parcel ships on Tuesday.", source: before, usefulness: "ONGOING" },
      { statement: "The parcel ships on Thursday.", source: after, start: 8, usefulness: "DURABLE" }
    ]);
    const lastingSource = await createMaintenanceMessage(userId, "I have kept a vegetarian diet for ten years.");
    const lasting = await createAutomaticMaintenanceFact(userId, [{ statement: lastingSource.text, source: lastingSource }]);
    expect(await plan(userId)).toBe(1);
    const settled = await settleMaintenanceJob(userId, (factId) => factId === lasting.factId ? "KEEP" : "REMOVE");
    expect(settled.outcome).toMatchObject({ reviewed: 2, removed: 1, blocked: 0 });
    expect(await prisma.memoryFactVersion.findMany({ where: { factId: shortTerm.factId }, select: { state: true, displayText: true } }))
      .toEqual([{ state: "FORGOTTEN", displayText: null }, { state: "FORGOTTEN", displayText: null }]);
    expect(await prisma.memoryMaintenanceSuppression.findMany({ where: { userId }, orderBy: { sourceStartOffset: "asc" },
      select: { sourceMessageId: true, sourceStartOffset: true, sourceEndOffset: true } })).toEqual([
      { sourceMessageId: before.messageId, sourceStartOffset: 0, sourceEndOffset: before.text.length },
      { sourceMessageId: after.messageId, sourceStartOffset: 8, sourceEndOffset: after.text.length }
    ]);
    expect(await prisma.memoryMaintenanceReview.findFirst({ where: { userId, factVersionId: lasting.currentVersionId } }))
      .toMatchObject({ disposition: "KEEP", usefulness: "DURABLE" });
    expect(await prisma.memoryFact.findUnique({ where: { id: lasting.factId } })).toMatchObject({ state: "ACTIVE" });
    expect(await prisma.memoryDeletionOutbox.count({ where: { userId, operation: "FORGET_PURGE", targetId: shortTerm.factId } })).toBe(1);
    expect(await prisma.message.count({ where: { id: { in: [before.messageId, after.messageId] } } })).toBe(2);
  });

  it("purges every removed fact of a mixed corpus, including dated and two-version ones, keeping neighbours and chats", async () => {
    const userId = await owner();
    const shared = await createMaintenanceMessage(userId, "I have been vegetarian for ten years; yesterday I tried a new falafel place.");
    const lasting = await createAutomaticMaintenanceFact(userId, [{ statement: "I have been vegetarian for ten years.", source: shared,
      end: "I have been vegetarian for ten years".length, usefulness: "DURABLE" }]);
    const episode = await createAutomaticMaintenanceFact(userId, [{ statement: "Yesterday I tried a new falafel place.", source: shared,
      start: shared.text.indexOf("yesterday"), usefulness: "EPISODIC" }]);
    const overlap = await createMaintenanceMessage(userId, "Yesterday I saw the dentist and then had lunch with Anna at the cafe.");
    const dentist = await createAutomaticMaintenanceFact(userId, [{ statement: "Yesterday I saw the dentist.", source: overlap,
      end: overlap.text.indexOf(" with Anna"), dated: true }]);
    const lunch = await createAutomaticMaintenanceFact(userId, [{ statement: "Yesterday I had lunch with Anna.", source: overlap,
      start: overlap.text.indexOf("and then"), dated: true }]);
    const first = await createMaintenanceMessage(userId, "The parcel arrives on Tuesday.");
    const second = await createMaintenanceMessage(userId, "Correction: the parcel now arrives on Thursday.");
    const parcel = await createAutomaticMaintenanceFact(userId, [{ statement: first.text, source: first, dated: true },
      { statement: "The parcel arrives on Thursday.", source: second, start: second.text.indexOf("the parcel") }]);
    expect(await plan(userId)).toBe(1);
    const settled = await settleMaintenanceJob(userId, (factId) => factId === lasting.factId ? "KEEP" : "REMOVE");
    expect(settled.outcome).toMatchObject({ reviewed: 5, removed: 4, blocked: 0 });
    const removed = [episode, dentist, lunch, parcel].map(({ factId }) => factId);
    expect(await drainMaintenanceForgetPurges(userId)).toBe(4);
    expect((await prisma.memoryDeletionOutbox.findMany({ where: { userId, operation: "FORGET_PURGE" },
      select: { targetId: true, state: true } })).sort((left, right) => left.targetId.localeCompare(right.targetId)))
      .toEqual([...removed].sort().map((targetId) => ({ targetId, state: "SUCCEEDED" })));
    expect(await prisma.memoryFactVersion.count({ where: { userId, factId: { in: removed }, OR: [{ displayText: { not: null } },
      { occurredAt: { not: null } }, { rawTemporalExpression: { not: null } }, { contentPurgedAt: null }] } })).toBe(0);
    expect(await prisma.memoryFact.findUnique({ where: { id: lasting.factId } })).toMatchObject({ state: "ACTIVE", currentVersionId: lasting.currentVersionId });
    expect(await prisma.memoryEvidence.count({ where: { userId, factVersionId: lasting.currentVersionId } })).toBe(1);
    expect(await prisma.message.count({ where: { chat: { userId } } })).toBe(4);
  });

  it("blocks a lineage with inexact evidence before any provider call, without a job, and never writes from the read path", async () => {
    const userId = await owner();
    const legacy = await createMaintenanceMessage(userId, "I am waiting for a call from the bank.");
    const current = await createMaintenanceMessage(userId, "Still waiting for the bank to call back.");
    const fact = await createAutomaticMaintenanceFact(userId, [
      { statement: "The user is waiting for a call from the bank.", source: legacy, legacy: true },
      { statement: "The user is still waiting for the bank to call back.", source: current }
    ]);
    const read = await loadMemoryMaintenanceSources(prisma, userId, { now: new Date(), versionIds: [fact.currentVersionId] });
    expect(read.sources.size).toBe(0);
    expect(read.blockers.get(fact.currentVersionId)).toMatchObject({ disposition: "BLOCKED", reasonCode: "evidence_without_offsets" });
    expect(await prisma.memoryMaintenanceReview.count({ where: { userId } })).toBe(0);
    expect(await plan(userId)).toBe(0);
    expect(await prisma.memoryJob.count({ where: { userId } })).toBe(0);
    expect(await reviews(userId)).toEqual([expect.objectContaining({ factVersionId: fact.currentVersionId, memoryJobId: null,
      disposition: "BLOCKED", reasonCode: "evidence_without_offsets", usefulness: null, reviewedAt: expect.any(Date) })]);
    // Covered until the weekly recheck: neither planned again nor offered as owner work.
    expect(await plan(userId)).toBe(0);
    expect(await reviews(userId)).toHaveLength(1);
    const offered: string[] = [];
    await reconcileMemoryMaintenanceWork(prisma, new Date(), async (candidate) => { offered.push(candidate); return false; });
    expect(offered).not.toContain(userId);
  });

  it("blocks a newer pending version, rechecks weekly without a key conflict, and reviews once the blocker clears", async () => {
    const userId = await owner();
    const first = await createMaintenanceMessage(userId, "The meeting is at ten.");
    const second = await createMaintenanceMessage(userId, "The meeting moved to eleven.");
    const fact = await createAutomaticMaintenanceFact(userId, [
      { statement: first.text, source: first, state: "ACTIVE" },
      { statement: second.text, source: second, state: "PENDING_RELATION" }
    ]);
    const now = new Date();
    expect(await plan(userId, now)).toBe(0);
    expect(await plan(userId, new Date(now.getTime() + 60_000))).toBe(0);
    const week = new Date(now.getTime() + MEMORY_MAINTENANCE_BLOCKED_RECHECK_MS + 60_000);
    expect(await plan(userId, week)).toBe(0);
    const blocked = await reviews(userId);
    expect(blocked.map(({ disposition, reasonCode, memoryJobId }) => ({ disposition, reasonCode, memoryJobId })))
      .toEqual(Array.from({ length: 2 }, () => ({ disposition: "BLOCKED", reasonCode: "pending_relation", memoryJobId: null })));
    expect(new Set(blocked.map(({ sourceSnapshotHash }) => sourceSnapshotHash)).size).toBe(2);
    // The relation resolves into the reviewed version without a newer version.
    await prisma.memoryFactVersion.update({ where: { id: fact.versionIds[1]! }, data: {
      state: "MERGED", mergedIntoVersionId: fact.currentVersionId, systemTo: new Date() } });
    expect(await plan(userId, new Date(week.getTime() + 60_000))).toBe(0);
    expect(await plan(userId, new Date(week.getTime() + MEMORY_MAINTENANCE_BLOCKED_RECHECK_MS + 120_000))).toBe(1);
    const reviewed = await reviews(userId);
    expect(reviewed).toHaveLength(3);
    expect(reviewed.at(-1)).toMatchObject({ factVersionId: fact.currentVersionId, disposition: "PENDING", reasonCode: null });
    expect(reviewed.at(-1)?.memoryJobId).not.toBeNull();
  });

  it("records unreviewable sources by reason and reviews long source and reference messages by window", async () => {
    const userId = await owner();
    const longStatementSource = await createMaintenanceMessage(userId, "I keep a long and detailed note about my reading list.");
    await createAutomaticMaintenanceFact(userId, [{ statement: `I keep notes about ${"books ".repeat(400)}`, source: longStatementSource }]);
    const parentAt = new Date(maintenanceFixtureTime().getTime() - 60_000);
    const hiddenParent = await createMaintenanceMessage(userId, "Private material outside future Memory admission.", { at: parentAt });
    const child = await createMaintenanceMessage(userId, "I prefer short answers.", { parent: hiddenParent });
    await createAutomaticMaintenanceFact(userId, [{ statement: child.text, source: child }]);
    await prisma.memoryPauseInterval.create({ data: { userId, scope: "MASTER", memoryGeneration: 0,
      pausedAt: new Date(parentAt.getTime() - 1), resumedAt: new Date(parentAt.getTime() + 1) } });
    const evidence = "I have practised judo every week for six years.";
    const longSource = await createMaintenanceMessage(userId, `${"y".repeat(12_000)} ${evidence} ${"y".repeat(12_000)}`);
    const start = longSource.text.indexOf(evidence);
    const windowed = await createAutomaticMaintenanceFact(userId, [{ statement: evidence, source: longSource, start, end: start + evidence.length }]);
    const reference = await createMaintenanceMessage(userId, `${"z".repeat(12_000)} Which club suits my schedule?`);
    const reply = await createMaintenanceMessage(userId, "I train in the evenings.", { parent: reference });
    const referenced = await createAutomaticMaintenanceFact(userId, [{ statement: reply.text, source: reply }]);
    expect(await plan(userId)).toBe(1);
    const rows = await reviews(userId);
    expect(rows.filter(({ disposition }) => disposition === "UNREVIEWABLE").map(({ reasonCode, memoryJobId }) => ({ reasonCode, memoryJobId }))
      .sort((left, right) => left.reasonCode!.localeCompare(right.reasonCode!)))
      .toEqual([{ reasonCode: "statement_too_long", memoryJobId: null }, { reasonCode: "unreviewable_context", memoryJobId: null }]);
    const job = await prisma.memoryJob.findFirstOrThrow({ where: { userId, state: "QUEUED" } });
    const snapshot = await createPrismaMemoryMaintenanceRepository(prisma).snapshot({ ...job, claimToken: "", recoveredLease: false } as MemoryJobClaim);
    const sources = new Map(snapshot!.plan!.sources.map((source) => [source.factId, source]));
    expect([...sources.keys()].sort()).toEqual([windowed.factId, referenced.factId].sort());
    const sourceWindow = sources.get(windowed.factId)!.context!.find(({ kind }) => kind === "SOURCE_MESSAGE")!;
    expect(sourceWindow.text.length).toBeLessThanOrEqual(8_002);
    expect(sourceWindow.text).toContain(evidence);
    expect(sourceWindow.text.startsWith("…") && sourceWindow.text.endsWith("…")).toBe(true);
    const tail = sources.get(referenced.factId)!.context!.find(({ kind }) => kind === "REFERENCE_MESSAGE")!;
    expect(tail.text.length).toBeLessThanOrEqual(8_001);
    expect(tail.text.startsWith("…")).toBe(true);
    expect(tail.text.endsWith("Which club suits my schedule?")).toBe(true);
  });

  it("allows one more review job after a failed attempt and covers the version after the second", async () => {
    const userId = await owner();
    const source = await createMaintenanceMessage(userId, "The plumber comes on Friday.");
    const fact = await createAutomaticMaintenanceFact(userId, [{ statement: source.text, source }]);
    expect(await plan(userId)).toBe(1);
    const first = await prisma.memoryJob.findFirstOrThrow({ where: { userId } });
    // An unadmitted stale job is revived with the same identity; no attempt is counted.
    await prisma.memoryJob.update({ where: { id: first.id }, data: { state: "STALE", completedAt: new Date() } });
    await reconcileMemoryMaintenanceWork(prisma, new Date(), async () => false);
    expect(await reviews(userId)).toHaveLength(0);
    expect(await plan(userId)).toBe(1);
    expect(await prisma.memoryJob.findMany({ where: { userId }, select: { id: true, state: true } }))
      .toEqual([{ id: first.id, state: "QUEUED" }]);
    const firstReview = (await reviews(userId))[0]!;
    await prisma.memoryJob.update({ where: { id: first.id }, data: { state: "TERMINAL_FAILED", completedAt: new Date() } });
    await reconcileMemoryMaintenanceWork(prisma, new Date(), async () => false);
    expect(await prisma.memoryMaintenanceReview.findUnique({ where: { id: firstReview.id } })).toMatchObject({ disposition: "UNKNOWN" });
    expect(await plan(userId)).toBe(1);
    const second = await prisma.memoryJob.findFirstOrThrow({ where: { userId, state: "QUEUED" } });
    expect(second.id).not.toBe(first.id);
    const retry = await prisma.memoryMaintenanceReview.findFirstOrThrow({ where: { userId, memoryJobId: second.id } });
    expect(retry).toMatchObject({ factVersionId: fact.currentVersionId, disposition: "PENDING" });
    expect(retry.sourceSnapshotHash).not.toBe(firstReview.sourceSnapshotHash);
    expect(await prisma.memoryJob.findUnique({ where: { id: first.id } })).toMatchObject({ state: "TERMINAL_FAILED" });
    await prisma.memoryJob.update({ where: { id: second.id }, data: { state: "TERMINAL_FAILED", completedAt: new Date() } });
    await reconcileMemoryMaintenanceWork(prisma, new Date(), async () => false);
    expect(await plan(userId)).toBe(0);
    expect(await prisma.memoryJob.count({ where: { userId } })).toBe(2);
    expect((await reviews(userId)).map(({ disposition }) => disposition)).toEqual(["UNKNOWN", "UNKNOWN"]);
  });

  it("never reviews explicit, pinned, owner-touched or remembered-on-request lineages, even when labelled episodic", async () => {
    const userId = await owner();
    const remembered = await createMaintenanceMessage(userId, "Remember that my locker number is 27.");
    const later = await createMaintenanceMessage(userId, "My locker is number 27 this week.");
    await createAutomaticMaintenanceFact(userId, [
      { statement: "The user's locker number is 27.", source: remembered, frame: { memoryDirective: "EXPLICIT_REMEMBER" } },
      { statement: "The user's locker is number 27 this week.", source: later, usefulness: "EPISODIC" }
    ]);
    const pinnedSource = await createMaintenanceMessage(userId, "Today I wore the green jacket.");
    await createAutomaticMaintenanceFact(userId, [{ statement: pinnedSource.text, source: pinnedSource, usefulness: "EPISODIC" }], { pinned: true });
    const editedSource = await createMaintenanceMessage(userId, "Today I parked on level three.");
    const edited = await createAutomaticMaintenanceFact(userId, [{ statement: editedSource.text, source: editedSource, usefulness: "EPISODIC" }]);
    await prisma.memoryEvent.create({ data: { userId, factId: edited.factId, factVersionId: edited.currentVersionId,
      operation: "EDIT", actorType: "USER", actorUserId: userId } });
    expect(await plan(userId)).toBe(0);
    expect(await prisma.memoryMaintenanceReview.count({ where: { userId } })).toBe(0);
    expect(await prisma.memoryJob.count({ where: { userId } })).toBe(0);
  });

  it("defers work while automatic learning is off and continues the pass after it resumes", async () => {
    const userId = await owner();
    const source = await createMaintenanceMessage(userId, "My cousin visits tomorrow.");
    await createAutomaticMaintenanceFact(userId, [{ statement: source.text, source }]);
    await prisma.userMemorySettings.update({ where: { userId }, data: { learnAutomatically: false } });
    expect(await plan(userId)).toBe(0);
    const offered: string[] = [];
    await reconcileMemoryMaintenanceWork(prisma, new Date(), async (candidate) => { offered.push(candidate); return false; });
    expect(offered).not.toContain(userId);
    expect(await prisma.memoryMaintenanceReview.count({ where: { userId } })).toBe(0);
    await prisma.userMemorySettings.update({ where: { userId }, data: { learnAutomatically: true } });
    expect(await plan(userId)).toBe(1);
  });

  it("finishes every owner and batch without new messages and never pays again for settled sources", async () => {
    const mine = new Set<string>();
    const facts = new Map<string, string[]>();
    for (let index = 0; index < 9; index++) {
      const userId = await owner();
      mine.add(userId);
      const source = await createMaintenanceMessage(userId, `Short-lived detail number ${index}.`);
      facts.set(userId, [(await createAutomaticMaintenanceFact(userId, [{ statement: source.text, source }])).factId]);
    }
    const large = [...mine][0]!;
    for (let index = 0; index < 17; index++) {
      const source = await createMaintenanceMessage(large, `Another short-lived detail ${index}.`);
      facts.get(large)!.push((await createAutomaticMaintenanceFact(large, [{ statement: source.text, source }])).factId);
    }
    const settledJobs = new Map<string, number>();
    for (let tick = 0; tick < 12; tick++) {
      const offered: string[] = [];
      await reconcileMemoryMaintenanceWork(prisma, new Date(), async (candidate) => { offered.push(candidate); return mine.has(candidate); });
      expect(offered.length).toBeLessThanOrEqual(8);
      // A restarted worker continues from durable state: settle what is queued.
      for (const userId of mine) {
        if (await prisma.memoryJob.count({ where: { userId, state: "QUEUED" } })) {
          await settleMaintenanceJob(userId, () => "REMOVE");
          settledJobs.set(userId, (settledJobs.get(userId) ?? 0) + 1);
        }
      }
      if ([...mine].every((userId) => (settledJobs.get(userId) ?? 0) * 16 >= facts.get(userId)!.length)) break;
    }
    for (const [userId, ids] of facts) {
      expect(await prisma.memoryFact.count({ where: { id: { in: ids }, state: "FORGOTTEN" } })).toBe(ids.length);
      const decided = await prisma.memoryMaintenanceReview.groupBy({ by: ["factVersionId"], where: { userId }, _count: true });
      expect(decided.every(({ _count }) => _count === 1)).toBe(true);
      expect(decided).toHaveLength(ids.length);
    }
    expect(settledJobs.get(large)).toBe(2);
    const offered: string[] = [];
    await reconcileMemoryMaintenanceWork(prisma, new Date(), async (candidate) => { offered.push(candidate); return false; });
    expect(offered.filter((userId) => mine.has(userId))).toEqual([]);
  });

  it("accepts previous-release v2 writes during replacement and stales an old v2 job", async () => {
    const userId = await owner();
    const source = await createMaintenanceMessage(userId, "The delivery arrives at noon.");
    const fact = await createAutomaticMaintenanceFact(userId, [{ statement: source.text, source }]);
    const job = await prisma.memoryJob.create({ data: { userId, kind: "SYNTHESIZE_MEMORIES", pipelineVersion: "memory-maintenance-v1",
      idempotencyFingerprint: randomUUID(), memoryGenerationSnapshot: 0, memoryRevisionSnapshot: 0 } });
    const base = { userId, factVersionId: fact.currentVersionId, evidenceThrough: maintenanceFixtureTime() };
    const legacy = await prisma.memoryMaintenanceReview.create({ data: { ...base, memoryJobId: job.id,
      policyVersion: "memory-maintenance-policy-v2", sourceSnapshotHash: "a".repeat(64) } });
    await prisma.memoryMaintenanceReview.update({ where: { id: legacy.id }, data: { disposition: "KEEP", usefulness: "EPISODIC", reviewedAt: new Date() } });
    const handler = createPrismaMemoryMaintenanceHandler(prisma);
    await expect(handler.preflight({ ...job, claimToken: "", recoveredLease: false } as MemoryJobClaim))
      .resolves.toEqual({ status: "STALE", errorCode: "memory_maintenance_source_stale" });
    const v3 = { ...base, policyVersion: MEMORY_MAINTENANCE_POLICY_VERSION };
    for (const data of [
      { ...v3, memoryJobId: null, sourceSnapshotHash: "b".repeat(64) },
      { ...v3, memoryJobId: job.id, sourceSnapshotHash: "c".repeat(64), reasonCode: "source_changed" },
      { ...v3, memoryJobId: null, sourceSnapshotHash: "d".repeat(64), disposition: "BLOCKED", reasonCode: "statement_too_long", reviewedAt: new Date() },
      { ...v3, memoryJobId: null, sourceSnapshotHash: "e".repeat(64), disposition: "KEEP", usefulness: "DURABLE", reviewedAt: new Date() }
    ]) await expect(prisma.memoryMaintenanceReview.create({ data })).rejects.toThrow();
    const blocker = await prisma.memoryMaintenanceReview.create({ data: { ...v3, memoryJobId: null, sourceSnapshotHash: "f".repeat(64),
      disposition: "UNREVIEWABLE", reasonCode: "statement_too_long", reviewedAt: new Date() } });
    await expect(prisma.memoryMaintenanceReview.update({ where: { id: blocker.id }, data: { reasonCode: "evidence_not_current" } })).rejects.toThrow();
    const pending = await prisma.memoryMaintenanceReview.create({ data: { ...v3, memoryJobId: job.id, sourceSnapshotHash: "1".repeat(64) } });
    await expect(prisma.memoryMaintenanceReview.update({ where: { id: pending.id }, data: {
      disposition: "UNREVIEWABLE", reasonCode: "unreviewable_context", reviewedAt: new Date() } })).rejects.toThrow();
    await expect(prisma.memoryMaintenanceReview.update({ where: { id: pending.id }, data: {
      disposition: "BLOCKED", reasonCode: "source_changed", reviewedAt: new Date() } })).resolves.toMatchObject({ reasonCode: "source_changed" });
  });
});
