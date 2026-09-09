// @vitest-environment node

import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { prisma } from "@/lib/server/prisma";
import { getWorkspaceConfig } from "./config";
import { createPrismaWorkspaceOverviewRepository, createWorkspaceOverviewService } from "./overviewService";

afterAll(async () => prisma.$disconnect());

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
