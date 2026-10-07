// @vitest-environment node

import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { prisma } from "@/lib/server/prisma";
import { scheduledTaskScheduleColumns } from "@/lib/server/scheduledTasks/store";
import { getWorkspaceConfig } from "./config";
import { createPrismaWorkspaceOverviewRepository, createWorkspaceOverviewService } from "./overviewService";

afterAll(async () => prisma.$disconnect());

it("counts retained disks, those an active scheduled task keeps and scheduled capacity waits and skips of the last day", async () => {
  const userId = `workspace-footprint-test-${randomUUID()}`;
  const chatIds: string[] = [];
  const config = getWorkspaceConfig({});
  const repository = createPrismaWorkspaceOverviewRepository(prisma, { retentionSeconds: config.retentionSeconds });
  const now = new Date();
  const hours = (count: number) => new Date(now.getTime() - count * 3_600_000);
  await prisma.user.create({ data: { displayName: "Workspace Footprint Fixture", id: userId, status: "active" } });
  try {
    const before = await repository.footprint!(now);
    // Two created disks, one never started and one being deleted.
    for (const state of ["READY", "STOPPED", "PENDING", "DELETING"] as const) {
      const chat = await prisma.chat.create({ data: { title: "Private chat fixture", userId, workspaceEnabled: true } });
      chatIds.push(chat.id);
      await prisma.workspaceSession.create({ data: {
        chatId: chat.id, expiresAt: new Date(now.getTime() + 3_600_000), imageRef: config.imageRef, internetEnabled: false,
        policyRevision: 1, runtimeSandboxId: state === "PENDING" ? null : randomUUID(), sandboxName: `aiqsa-ws-${randomUUID()}`, state
      } });
    }
    // An active same-chat Workspace task keeps the first disk until its next run.
    const task = await prisma.scheduledTask.create({ data: {
      ...scheduledTaskScheduleColumns({ kind: "daily", time: "09:00" }), chatId: chatIds[0], chatMode: "SAME", modelId: "fake-qsa",
      nextRunAt: new Date(now.getTime() + 3_600_000), prompt: "Synthetic scheduled prompt", provider: "fake", status: "ACTIVE",
      timeZone: "Europe/Moscow", title: "Synthetic brief", toolsEnabled: true, userId, workspaceEnabled: true
    } });
    await prisma.scheduledTaskOccurrence.createMany({ data: [
      { scheduledFor: hours(1), taskId: task.id, trigger: "schedule", userId, workspaceWaitStartedAt: hours(1) },
      { scheduledFor: hours(25), taskId: task.id, trigger: "schedule", userId, workspaceWaitStartedAt: hours(25),
        finishedAt: hours(25), reasonCode: "superseded", state: "SKIPPED" },
      { scheduledFor: hours(3), taskId: task.id, trigger: "schedule", userId, workspaceWaitStartedAt: hours(3),
        finishedAt: hours(2), reasonCode: "workspace_capacity", state: "SKIPPED" },
      { scheduledFor: hours(30), taskId: task.id, trigger: "schedule", userId, finishedAt: hours(26), reasonCode: "workspace_capacity",
        state: "SKIPPED" }
    ] });
    const after = await repository.footprint!(now);
    expect({
      retainedDisks: after.retainedDisks - before.retainedDisks, scheduledDisks: after.scheduledDisks - before.scheduledDisks,
      scheduledSkips: after.scheduledSkips - before.scheduledSkips, scheduledWaits: after.scheduledWaits - before.scheduledWaits
    }).toEqual({ retainedDisks: 2, scheduledDisks: 1, scheduledSkips: 1, scheduledWaits: 2 });
    // Pausing the task lifts its pin.
    await prisma.scheduledTask.update({ data: { nextRunAt: null, status: "PAUSED" }, where: { id: task.id } });
    expect((await repository.footprint!(now)).scheduledDisks).toBe(before.scheduledDisks);
  } finally {
    await prisma.scheduledTask.deleteMany({ where: { userId } });
    await prisma.workspaceSession.deleteMany({ where: { chatId: { in: chatIds } } });
    await prisma.chat.deleteMany({ where: { id: { in: chatIds } } });
    await prisma.user.delete({ where: { id: userId } });
  }
});

it("reads personal and Project environments without changing last activity, expiry, state or ownership", async () => {
  const userId = `workspace-overview-test-${randomUUID()}`;
  const chatIds: string[] = [];
  let projectId: string | null = null;
  const config = getWorkspaceConfig({});
  await prisma.user.create({ data: { displayName: "Workspace Overview Fixture", id: userId, status: "active" } });
  try {
    const project = await prisma.project.create({ data: {
      createdByDisplayName: "Workspace Overview Fixture", createdByUserId: userId,
      grants: { create: { role: "OWNER", userId } }, name: "Private project fixture"
    } });
    projectId = project.id;
    const lastActiveAt = new Date();
    for (const [index, state] of (["READY", "STOPPED", "RUNNING"] as const).entries()) {
      const chat = await prisma.chat.create({ data: {
        title: `Private chat fixture ${index}`,
        ...(index === 2 ? { createdByDisplayName: "Workspace Overview Fixture", createdByUserId: userId,
          memoryMode: "EXCLUDED" as const, projectId } : { userId }),
        workspaceEnabled: true
      } });
      chatIds.push(chat.id);
      await prisma.workspaceSession.create({ data: {
        chatId: chat.id, expiresAt: new Date(Date.now() + 3_600_000), imageRef: config.imageRef,
        internetEnabled: false, lastActiveAt, policyRevision: 1, runtimeSandboxId: randomUUID(),
        sandboxName: `aiqsa-ws-${randomUUID()}`, state, stoppedAt: state === "STOPPED" ? lastActiveAt : null
      } });
    }
    const before = await prisma.workspaceSession.findMany({ orderBy: { id: "asc" }, where: { chatId: { in: chatIds } } });
    const repository = createPrismaWorkspaceOverviewRepository(prisma);
    const owned = (await repository.read()).filter((row) => before.some((session) => session.id === row.id));
    expect(owned).toHaveLength(3);
    expect(owned.filter((row) => row.context === "project")).toHaveLength(1);
    expect(owned.every((row) => row.user === "Workspace Overview Fixture")).toBe(true);
    const service = createWorkspaceOverviewService({ repository, runtime: {
      async listSessions() { return { entries: before.map((session) => ({
        runtimeSandboxId: session.runtimeSandboxId!, sandboxName: session.sandboxName,
        state: session.state === "STOPPED" ? "stopped" as const : "running" as const
      })), nextCursor: null }; }
    } });
    const overview = await service.read({ filter: "all", page: 1 });
    expect(overview.activeCount).toBe(2);
    expect(overview.stoppedCount).toBe(1);
    expect(JSON.stringify(overview)).not.toMatch(/Private chat fixture|Private project fixture|runtimeSandboxId|sandboxName|operationOwner/u);
    await service.read({ filter: "active", page: 2 });
    expect(await prisma.workspaceSession.findMany({ orderBy: { id: "asc" }, where: { chatId: { in: chatIds } } })).toEqual(before);
  } finally {
    await prisma.workspaceSession.deleteMany({ where: { chatId: { in: chatIds } } });
    await prisma.chat.deleteMany({ where: { id: { in: chatIds } } });
    if (projectId) await prisma.project.delete({ where: { id: projectId } });
    await prisma.user.delete({ where: { id: userId } });
  }
});
