import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  addMaintenanceEvidence, createAutomaticMaintenanceFact, createMaintenanceMessage, createMaintenanceOwner,
  deleteMaintenanceOwner
} from "@/tests/support/memoryMaintenance";
import { prisma } from "../../prisma";
import { MEMORY_MAINTENANCE_POLICY_VERSION, type MemoryMaintenanceSource } from "./policy";
import { scheduleOwnerMemoryMaintenance } from "./reconcile";
import { loadMemoryMaintenanceSources, scanMemoryMaintenanceSources } from "./source";

/** The batch budget of one review request, in UTF-16 code units. */
const BATCH_CHARACTERS = 40_000;

const owners: string[] = [];
async function owner(): Promise<string> {
  const userId = await createMaintenanceOwner("memory-maintenance-scan");
  owners.push(userId);
  return userId;
}
afterEach(async () => {
  for (const userId of owners.splice(0)) await deleteMaintenanceOwner(userId);
});
afterAll(async () => { await prisma.$disconnect(); });

function reviewSize(source: MemoryMaintenanceSource): number {
  return source.statement.length + source.evidence.reduce((sum, item) => sum + item.quote.length, 0) +
    (source.context ?? []).reduce((sum, item) => sum + item.text.length, 0);
}

describe("maintenance source scan", () => {
  it("never moves its cursor past a source a full batch could not take", async () => {
    const userId = await owner();
    // About 11,000 characters each with its quote and source window: three
    // fill a batch, the fourth by version order does not fit beside them.
    const versionIds: string[] = [];
    for (const label of ["first", "second", "third", "fourth"]) {
      const source = await createMaintenanceMessage(userId,
        `My ${label} long note about evening walks near the river. `.repeat(140).slice(0, 7_000));
      versionIds.push((await createAutomaticMaintenanceFact(userId, [{ statement: `The ${label} walking habit.`, source }]))
        .currentVersionId);
    }
    const ordered = [...versionIds].sort();
    const now = new Date();

    const full = await scanMemoryMaintenanceSources(prisma, userId, now, null);
    expect(full.plan?.sources.map(({ versionId }) => versionId)).toEqual(ordered.slice(0, 3));
    expect(full.plan!.sources.reduce((sum, source) => sum + reviewSize(source), 0)).toBeLessThanOrEqual(BATCH_CHARACTERS);
    expect(full.blockers).toEqual([]);
    // The cursor stops before the source that did not fit, not at the last row.
    expect(full.cursor).toBe(ordered[2]);

    const next = await scanMemoryMaintenanceSources(prisma, userId, now, full.cursor);
    expect(next.plan?.sources.map(({ versionId }) => versionId)).toEqual([ordered[3]]);
    expect(next.cursor).toBe(ordered[3]);

    // Past the last uncovered source the scan starts over at once, exactly once.
    const wrapped = await scanMemoryMaintenanceSources(prisma, userId, now, ordered[3]!);
    expect(wrapped.plan?.sources.map(({ versionId }) => versionId)).toEqual(ordered.slice(0, 3));
    expect(wrapped.cursor).toBe(ordered[2]);
  });

  it("plans every source of a scheduler cycle and ends with a clean cursor", async () => {
    const userId = await owner();
    for (const label of ["first", "second", "third", "fourth"]) {
      const source = await createMaintenanceMessage(userId,
        `My ${label} long note about evening walks near the river. `.repeat(140).slice(0, 7_000));
      await createAutomaticMaintenanceFact(userId, [{ statement: `The ${label} walking habit.`, source }]);
    }
    const settle = async () => prisma.memoryJob.updateMany({ where: { userId, state: "QUEUED" },
      data: { state: "SUCCEEDED", completedAt: new Date() } });

    expect(await scheduleOwnerMemoryMaintenance(prisma, userId, new Date())).toBe(1);
    await settle();
    expect(await scheduleOwnerMemoryMaintenance(prisma, userId, new Date())).toBe(1);
    await settle();
    expect(await prisma.memoryMaintenanceReview.count({ where: { userId, policyVersion: MEMORY_MAINTENANCE_POLICY_VERSION,
      disposition: "PENDING" } })).toBe(4);
    // Everything is covered: the wrap finds nothing, plans nothing and clears the cursor.
    expect(await scheduleOwnerMemoryMaintenance(prisma, userId, new Date())).toBe(0);
    expect(await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId }, select: { maintenanceCursor: true } }))
      .toEqual({ maintenanceCursor: null });
    expect(await prisma.memoryJob.count({ where: { userId } })).toBe(2);
  });

  it("reviews a source larger than a whole batch with its newest supports within the budget", async () => {
    const userId = await owner();
    // Eight supports of 6,000 characters: eight 4,001-character quotes and
    // their source windows exceed one batch, fewer of the newest fit.
    const messages = [];
    for (let index = 0; index < 8; index += 1) {
      messages.push(await createMaintenanceMessage(userId,
        `Note ${index + 1}: I walk along the river every evening after work. `.repeat(100).slice(0, 6_000)));
    }
    const fact = await createAutomaticMaintenanceFact(userId, [{ statement: "I walk along the river every evening.",
      source: messages[0]! }]);
    for (const message of messages.slice(1)) await addMaintenanceEvidence(userId, fact.currentVersionId, message);
    const supports = (await prisma.memoryEvidence.findMany({ where: { userId, factVersionId: fact.currentVersionId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true } })).map(({ id }) => id);
    expect(supports).toHaveLength(8);

    const scan = await scanMemoryMaintenanceSources(prisma, userId, new Date(), null);
    expect(scan.blockers).toEqual([]);
    expect(scan.cursor).toBe(fact.currentVersionId);
    const [source] = scan.plan?.sources ?? [];
    expect(source?.versionId).toBe(fact.currentVersionId);
    expect(reviewSize(source!)).toBeLessThanOrEqual(BATCH_CHARACTERS);
    const reviewed = source!.evidence.map(({ id }) => id);
    expect(reviewed.length).toBeGreaterThan(0);
    expect(reviewed.length).toBeLessThan(8);
    expect(reviewed).toEqual(supports.slice(-reviewed.length));

    // The apply recomputes the same trimmed snapshot, so the review can settle.
    const current = await loadMemoryMaintenanceSources(prisma, userId,
      { now: new Date(), versionIds: [fact.currentVersionId] });
    expect(current.sources.get(fact.currentVersionId)?.sourceSnapshotHash).toBe(source!.sourceSnapshotHash);

    expect(await scheduleOwnerMemoryMaintenance(prisma, userId, new Date())).toBe(1);
    expect(await prisma.memoryMaintenanceReview.findMany({ where: { userId }, select: { factVersionId: true, disposition: true } }))
      .toEqual([{ factVersionId: fact.currentVersionId, disposition: "PENDING" }]);
  });
});
