import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  createAutomaticMaintenanceFact, createMaintenanceMessage, createMaintenanceOwner, deleteMaintenanceOwner
} from "@/tests/support/memoryMaintenance";
import { prisma } from "../../prisma";
import { MEMORY_MAINTENANCE_POLICY_VERSION, type MemoryMaintenanceSource } from "./policy";
import { scheduleOwnerMemoryMaintenance } from "./reconcile";
import { scanMemoryMaintenanceSources } from "./source";

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

/** An 8,000-character message and its exact 2,000-character quote: about
 * 10,000 characters a source, so three fill a batch and a fourth does not.
 * The text ends in a non-space: the safe projection trims trailing
 * whitespace, and the fixture hashes the raw text as the exact source. */
async function longWalkingFact(userId: string, label: string): Promise<string> {
  const source = await createMaintenanceMessage(userId,
    `${`My ${label} long note about evening walks near the river. `.repeat(200).slice(0, 7_999)}.`);
  return (await createAutomaticMaintenanceFact(userId, [{ statement: `The ${label} walking habit.`, source, end: 2_000 }]))
    .currentVersionId;
}

function reviewSize(source: MemoryMaintenanceSource): number {
  return source.statement.length + source.evidence.reduce((sum, item) => sum + item.quote.length, 0) +
    (source.context ?? []).reduce((sum, item) => sum + item.text.length, 0);
}

describe("maintenance source scan", () => {
  it("never moves its cursor past a source a full batch could not take", async () => {
    const userId = await owner();
    // Three fill a batch, the fourth by version order does not fit beside them.
    const versionIds: string[] = [];
    for (const label of ["first", "second", "third", "fourth"]) versionIds.push(await longWalkingFact(userId, label));
    const ordered = [...versionIds].sort();
    const now = new Date();

    const full = await scanMemoryMaintenanceSources(prisma, userId, now, null);
    expect(full.blockers.map(({ versionId, reasonCode }) => ({ versionId, reasonCode }))).toEqual([]);
    expect(full.plan?.sources.map(({ versionId }) => versionId)).toEqual(ordered.slice(0, 3));
    expect(full.plan!.sources.every((source) => reviewSize(source) > BATCH_CHARACTERS / 4)).toBe(true);
    expect(full.plan!.sources.reduce((sum, source) => sum + reviewSize(source), 0)).toBeLessThanOrEqual(BATCH_CHARACTERS);
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
    for (const label of ["first", "second", "third", "fourth"]) await longWalkingFact(userId, label);
    const settle = async () => prisma.memoryJob.updateMany({ where: { userId, state: "QUEUED" },
      data: { state: "SUCCEEDED", completedAt: new Date() } });

    expect(await scheduleOwnerMemoryMaintenance(prisma, userId, new Date())).toBe(1);
    await settle();
    // A blocker row would cover its source without a job; none is blocked.
    expect(await prisma.memoryMaintenanceReview.findMany({ where: { userId, disposition: { not: "PENDING" } },
      select: { disposition: true, reasonCode: true } })).toEqual([]);
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
});
