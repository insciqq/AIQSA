// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { adminHealthQueueIds } from "../../../contracts/adminHealthQueues";
import { prisma } from "../../prisma";
import { queueAttentionItems } from "../attention/queueRules";
import { createAdminHealthQueuesService } from "./queues";
import { readAdminHealthQueueCounts } from "./queuesRepository";

// Other rows in the database may add to shared totals, so counts are lower
// bounds; the synthetic jobs are decades old, so their queues are stalled.
const DAY_SECONDS = 86_400;
const dueAt = new Date("1998-01-01T00:00:00.000Z");
const service = createAdminHealthQueuesService({ read: (queues, now) => readAdminHealthQueueCounts(prisma, { now, queues }) });

afterAll(async () => {
  await prisma.$disconnect();
});

describe("background queue repository over PostgreSQL", () => {
  it("reads every queue from the real schema", async () => {
    const snapshot = await service.read();
    expect(snapshot.queues.map((row) => row.queue)).toEqual([...adminHealthQueueIds]);
    for (const row of snapshot.queues) {
      expect(row.state, row.queue).not.toBe("unavailable");
      expect(row.waiting).toBeGreaterThanOrEqual(0);
      expect(row.running).toBeGreaterThanOrEqual(0);
    }
    expect(snapshot.queues.find((row) => row.queue === "memory")?.failed24h).toBeNull();
  });

  it("turns synthetic stuck jobs into stalled rows and one attention item per unwatched queue", async () => {
    const user = await prisma.user.create({
      data: { displayName: "Queue Test", email: `queues-${randomUUID()}@example.test`, status: "active" }
    });
    const storageKey = `queues/stuck-${randomUUID()}`;
    const claimedKey = `queues/claimed-${randomUUID()}`;
    const deletionTarget = randomUUID();
    const recent = new Date(Date.now() - 60_000);
    try {
      const [stuck, claimed] = await Promise.all([storageKey, claimedKey].map((key) => prisma.attachment.create({
        data: { byteSize: 4, fileName: "stuck.txt", kind: "document", metadata: {}, mimeType: "text/plain",
          status: "processing", storageKey: key, userId: user.id }
      })));
      await prisma.attachmentProcessingJob.createMany({ data: [
        { attachmentId: stuck!.id, createdAt: dueAt, nextAttemptAt: dueAt, ownerUserId: user.id },
        { attachmentId: claimed!.id, claimToken: randomUUID(), claimedAt: new Date(), lastAttemptAt: recent,
          lastErrorCode: "attachment_parse_failed", ownerUserId: user.id }
      ] });
      await prisma.scheduledTask.create({ data: {
        modelId: "queue-test-model", nextRunAt: dueAt, prompt: "Queue test", provider: "queue-test", scheduleKind: "DAILY",
        timeOfDayMinutes: 0, timeZone: "UTC", title: "Queue test", userId: user.id
      } });
      await prisma.knowledgeDeletionJob.create({ data: {
        attemptCount: 1, createdAt: dueAt, lastAttemptAt: recent, lastErrorCode: "knowledge_purge_failed",
        ownerUserId: user.id, state: "RUNNING", targetId: deletionTarget, targetType: "SOURCE"
      } });

      const snapshot = await service.read();
      const row = (queue: string) => snapshot.queues.find((item) => item.queue === queue)!;
      const age = (Date.parse(snapshot.checkedAt) - dueAt.getTime()) / 1_000;

      expect(row("attachment_processing")).toMatchObject({ state: "stalled" });
      expect(row("attachment_processing").waiting).toBeGreaterThanOrEqual(1);
      expect(row("attachment_processing").running).toBeGreaterThanOrEqual(1);
      expect(row("attachment_processing").failed24h).toBeGreaterThanOrEqual(1);
      // A day of tolerance absorbs a session time zone.
      expect(row("attachment_processing").oldestSeconds).toBeGreaterThan(age - DAY_SECONDS);
      expect(row("scheduled_tasks")).toMatchObject({ state: "stalled" });
      expect(row("scheduled_tasks").waiting).toBeGreaterThanOrEqual(1);
      expect(row("scheduled_tasks").oldestSeconds).toBeGreaterThan(age - DAY_SECONDS);
      // A running deletion still ages its queue, and its failed last attempt counts.
      expect(row("knowledge_deletion")).toMatchObject({ state: "stalled" });
      expect(row("knowledge_deletion").running).toBeGreaterThanOrEqual(1);
      expect(row("knowledge_deletion").failed24h).toBeGreaterThanOrEqual(1);

      const findings = await service.stalled();
      expect(findings.map((finding) => finding.queue)).toEqual(expect.arrayContaining(["attachment_processing", "scheduled_tasks"]));
      // Knowledge deletion has its own Knowledge alert and raises nothing here.
      expect(findings.map((finding) => finding.queue)).not.toContain("knowledge_deletion");
      const items = queueAttentionItems(findings).filter((item) => item.id === "queue_stalled:attachment_processing");
      expect(items).toHaveLength(1);
      expect(items[0]!.detail).toMatch(/^Chat file processing · /u);
    } finally {
      await prisma.knowledgeDeletionJob.deleteMany({ where: { targetId: deletionTarget } });
      await prisma.scheduledTask.deleteMany({ where: { userId: user.id } });
      await prisma.attachmentProcessingJob.deleteMany({ where: { ownerUserId: user.id } });
      await prisma.user.deleteMany({ where: { id: user.id } });
      await prisma.attachmentDeletionJob.deleteMany({ where: { storageKey: { in: [storageKey, claimedKey] } } });
    }

    // Once the synthetic jobs are gone, nothing of them is left to age the queues.
    const after = await service.read();
    const attachmentAge = after.queues.find((item) => item.queue === "attachment_processing")?.oldestSeconds ?? null;
    if (attachmentAge !== null) {
      expect(attachmentAge).toBeLessThan((Date.parse(after.checkedAt) - dueAt.getTime()) / 1_000 - DAY_SECONDS);
    }
  });
});
