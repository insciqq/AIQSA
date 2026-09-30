import { Prisma, type PrismaClient } from "@prisma/client";
import { expect, type Page } from "@playwright/test";
import { providerTemplateIds } from "../../../lib/domain/providerTemplates";
import { parseChatRoutePath } from "../../../lib/domain/chatRoute";

/** Workspace's admitted contract and tool schemas exceed Fake QSA's 8k seed
 * window. Bound only this disposable fake fixture; normal budgeting stays on.
 * The caller owns setup/teardown and must run its spec alone with one worker. */
export async function prepareWorkspaceFakeContext(prisma: PrismaClient): Promise<() => Promise<void>> {
  expect(process.env.AIQSA_STATEFUL_TEST_TARGET).toBe("DISPOSABLE");
  expect(process.env.AIQSA_TEST_MODE).toBe("1");
  expect(process.env.NODE_ENV).not.toBe("production");
  const database = new URL(process.env.DATABASE_URL!);
  expect([database.protocol, database.hostname, database.port, database.pathname, database.username])
    .toEqual(["postgresql:", "postgres", "5432", "/aiqsa", "aiqsa"]);
  expect(database.password).not.toBe("");
  expect([...database.searchParams]).toEqual([["schema", "public"]]);
  expect(database.hash).toBe("");
  const before = await prisma.providerModel.findUniqueOrThrow({ where: { id: providerTemplateIds.fakeModel },
    select: { activeConfig: true, capabilities: true } });
  const config = before.activeConfig as Prisma.JsonObject;
  expect(config.adapterKind).toBe("fake");
  const activeConfig = { ...config, capabilities: { ...config.capabilities as Prisma.JsonObject, contextWindow: 65_536 } };
  const capabilities = { ...before.capabilities as Prisma.JsonObject, contextWindow: 65_536 };
  await prisma.providerModel.update({ where: { id: providerTemplateIds.fakeModel }, data: { activeConfig, capabilities } });
  return async () => {
    // Do not overwrite a concurrent writer even on this disposable stand.
    const restored = await prisma.providerModel.updateMany({ where: { id: providerTemplateIds.fakeModel,
      activeConfig: { equals: activeConfig }, capabilities: { equals: capabilities } },
    data: { activeConfig: before.activeConfig as Prisma.InputJsonValue, capabilities: before.capabilities as Prisma.InputJsonValue } });
    expect(restored.count, "Workspace fake context fixture lost ownership before restoration").toBe(1);
  };
}

/** Explicit per-composer modes prevent unrelated real routing/search/Skill
 * selection on a disposable stand that also hosts provider checks. */
export async function configureWorkspaceOnlyTools(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Change MCP mode", exact: true }).click();
  await page.getByRole("menu", { name: "MCP tools", exact: true }).getByRole("menuitemradio", { name: /^Off/u }).click();
  await page.getByRole("button", { name: "Change Skills mode", exact: true }).click();
  await page.getByRole("menu", { name: "Skills", exact: true }).getByRole("menuitemradio", { name: /^Off/u }).click();
  const search = page.getByRole("button", { name: /^Choose web search/u });
  if (await search.count()) {
    await search.click();
    const off = page.getByRole("dialog", { name: "Web search", exact: true }).getByRole("button", { name: "Turn off search", exact: true });
    if (await off.isEnabled()) await off.click();
    await page.keyboard.press("Escape");
  }
}

/** Published answer text releases the composer before output transfer finishes.
 * Wait for this exact owned run's export and session retirement before reset,
 * continuation, or assertions against its idle disk and activity timestamps. */
export async function waitForWorkspaceExport(prisma: PrismaClient, chatId: string): Promise<void> {
  const run = await prisma.modelRun.findFirstOrThrow({ where: { chatId }, orderBy: { createdAt: "desc" }, select: { id: true } });
  await expect.poll(async () => {
    const current = await prisma.modelRun.findUniqueOrThrow({ where: { id: run.id }, select: {
      status: true, workspaceRunBinding: { select: { exportState: true,
        workspaceSession: { select: { operationOwner: true, state: true } } } }
    } });
    const binding = current.workspaceRunBinding;
    return { run: current.status, export: binding?.exportState, retired: binding?.workspaceSession.operationOwner === null,
      idle: ["STOPPED", "READY", "PENDING"].includes(binding?.workspaceSession.state ?? "") };
  }, { timeout: 90_000, message: "Workspace export and authority retirement must finish for the owned run" })
    .toEqual({ run: "complete", export: "COMPLETE", retired: true, idle: true });
}

/** These specs always open a fresh chat before sending. Context closure alone
 * cannot Stop a run; cancel owned work and await retirement before archiving.
 * Preserve output/recovery rows for disposable-stack teardown. */
export async function cleanupWorkspaceFixtureChat(prisma: PrismaClient, page: Page, chatId = parseChatRoutePath(new URL(page.url()).pathname)?.chatId): Promise<void> {
  if (!chatId) return;
  const chat = await prisma.chat.findUnique({ where: { id: chatId }, select: { id: true, archived: true } });
  if (!chat) return;
  const active = ["preparing", "queued", "in_progress", "streaming"] as const;
  const runs = await prisma.modelRun.findMany({ where: { chatId, status: { in: [...active] } }, select: { id: true } });
  for (const run of runs) {
    const response = await page.request.post(`/api/model-runs/${run.id}/cancel`);
    if (response.status() === 409) expect((await response.json()).error).toBe("model_run_not_cancelable");
    else expect(response.ok(), "Owned Workspace run cancellation failed").toBe(true);
  }
  await expect.poll(async () => {
    const session = await prisma.workspaceSession.findUnique({ where: { chatId }, select: { operationOwner: true, state: true } });
    return await prisma.modelRun.count({ where: { chatId, status: { in: [...active] } } }) === 0 &&
      (!session || session.operationOwner === null && ["PENDING", "READY", "STOPPED"].includes(session.state));
  }, { timeout: 90_000, message: "Owned Workspace cleanup must retire guest authority before archiving" }).toBe(true);
  if (!chat.archived) expect((await page.request.delete(`/api/chats/${chatId}`)).ok(), "Owned Workspace chat archival failed").toBe(true);
}
