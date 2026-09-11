import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import type { AdminMcpCatalogResponse } from "../../lib/contracts/mcp";
import { createPrismaMcpRepository } from "../../lib/server/mcp/prismaRepository";
import { expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

const prisma = new PrismaClient();
test.afterAll(() => prisma.$disconnect());

for (const viewport of [
  { width: 1440, height: 1000, theme: "light" },
  { width: 390, height: 844, theme: "dark" }
] as const) {
  test(`MCP tool access persists and detects competing edits at ${viewport.width}px`, async ({ page, context }, testInfo) => {
    test.setTimeout(120_000);
    execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
    await page.setViewportSize(viewport);
    await page.emulateMedia({ colorScheme: viewport.theme });
    await context.addCookies([{ name: "aiqsa.theme", value: viewport.theme, url: "http://127.0.0.1:3000" }]);
    const suffix = randomUUID();
    const userId = randomUUID();
    const groupId = randomUUID();
    const userName = `MCP recipient ${suffix.slice(0, 8)}`;
    const groupName = `Tracker editors with a deliberately long group name ${suffix.slice(0, 8)}`;
    let serverId: string | null = null;
    let upstreamRequests = 0;
    const endpoint = createServer((_request, response) => { upstreamRequests += 1; response.writeHead(500); response.end(); });
    await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
    const repository = createPrismaMcpRepository({ prisma, encryptionKey: () => Buffer.alloc(32, 1),
      draftValidator: { validate: async () => ({ kind: "ok", resolvedArtifact: null, evidence: {},
        toolInventory: [{ name: "issue_get", description: "Read fixture issues" }, { name: "issue_update", description: "Update fixture issues" }] }) } });
    try {
      await prisma.user.create({ data: { id: userId, displayName: userName, email: `mcp-access-${suffix}@example.test`, role: "admin", status: "active" } });
      await prisma.group.create({ data: { id: groupId, name: groupName, users: { create: { userId } } } });
      const created = await repository.createServer({ description: "Synthetic tool access browser fixture", name: `MCP access ${suffix.slice(0, 8)}`,
        sharedValues: {}, draft: { auth: { mode: "none" }, slots: [], runtime: { callTimeoutMs: 2000, startupTimeoutMs: 2000 },
          source: { kind: "remote", url: `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}/mcp`, allowPrivateNetwork: true }, transport: "streamable_http" } });
      expect(created.kind).toBe("ok");
      if (created.kind !== "ok") throw new Error(created.kind);
      serverId = created.value.id;
      expect((await repository.testDraft({ serverId, expectedUpdatedAt: created.value.updatedAt, validationUserId: userId, oneTimeValues: {}, publish: true })).kind).toBe("ok");
      const original = await prisma.mcpServer.findUniqueOrThrow({ where: { id: serverId } });
      await signInWithLocalToken(page);
      await page.goto(`/admin?section=mcp&resource=${serverId}`);
      const openEditor = async () => {
        const button = page.getByRole("button", { name: "Edit access to issue_update", exact: true });
        await button.focus();
        await page.keyboard.press("Enter");
        await expect(page.getByRole("heading", { name: "Access to issue_update" })).toBeFocused();
        return page.getByRole("region", { name: "Access to issue_update" });
      };
      let editor = await openEditor();
      await expect(editor.getByText("Available to everyone with MCP access", { exact: true })).toBeVisible();
      await editor.getByRole("switch").focus();
      await page.keyboard.press("Space");
      await expect(editor.getByText("Restricted · No one has access", { exact: true })).toBeVisible();
      await editor.getByRole("button", { name: "Save access", exact: true }).click();
      await expect(editor).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Edit access to issue_update" })).toBeFocused();
      const policy = () => prisma.mcpToolAccessPolicy.findUniqueOrThrow({
        where: { serverId_toolName: { serverId: serverId!, toolName: "issue_update" } }, include: { users: true, groups: true }
      });
      expect(await policy()).toMatchObject({ restricted: true, users: [], groups: [] });
      editor = await openEditor();
      await editor.getByRole("searchbox").fill(groupName);
      await editor.getByRole("checkbox", { name: `Allow group ${groupName}` }).check();
      await editor.getByRole("searchbox").fill(userName);
      await expect(editor.getByText(`Via ${groupName}`, { exact: true })).toBeVisible();
      await editor.getByRole("checkbox", { name: `Allow user ${userName}` }).check();
      await editor.getByRole("searchbox").fill("No matching recipient");
      await expect(editor.getByRole("checkbox", { name: `Allow user ${userName}` })).toBeChecked();
      await expectNoHorizontalOverflow(page);
      const save = editor.getByRole("button", { name: "Save access", exact: true });
      await save.scrollIntoViewIfNeeded();
      await expectWithinViewport(page, save);
      await page.screenshot({ path: testInfo.outputPath(`mcp-tool-access-${viewport.theme}.png`) });
      await save.click();
      await expect(editor).toHaveCount(0);
      expect(await policy()).toMatchObject({ restricted: true, users: [{ userId }], groups: [{ groupId }] });
      await page.reload();
      editor = await openEditor();
      await editor.getByRole("searchbox").fill(userName);
      await editor.getByRole("checkbox", { name: `Allow user ${userName}` }).uncheck();
      await expect(editor.getByText(`Via ${groupName}`, { exact: true })).toBeVisible();
      const catalog = await (await page.request.get("/api/admin/mcp")).json() as AdminMcpCatalogResponse;
      const current = catalog.servers.find(({ id }) => id === serverId)!;
      const competing = await page.request.patch(`/api/admin/mcp/${serverId}`, { data: {
        expectedUpdatedAt: current.updatedAt, toolAccess: { name: "issue_update", restricted: true, userIds: [userId], groupIds: [] }
      } });
      expect(competing.status()).toBe(200);
      const conflict = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().endsWith(`/api/admin/mcp/${serverId}`));
      await editor.getByRole("button", { name: "Save access", exact: true }).click();
      expect((await conflict).status()).toBe(409);
      await expect(editor.getByText(/Your selections are kept/)).toBeVisible();
      await expect(editor.getByRole("checkbox", { name: `Allow group ${groupName}` })).toBeChecked();
      await editor.getByRole("button", { name: "Refresh server data", exact: true }).click();
      await editor.getByRole("button", { name: "Load saved access", exact: true }).click();
      await expect(editor.getByRole("checkbox", { name: `Allow user ${userName}` })).toBeChecked();
      await editor.getByRole("switch").click();
      await editor.getByRole("button", { name: "Save access", exact: true }).click();
      await expect(editor).toHaveCount(0);
      expect(await policy()).toMatchObject({ restricted: false, users: [{ userId }], groups: [] });
      editor = await openEditor();
      const beforeDeletion = await prisma.mcpServer.findUniqueOrThrow({ where: { id: serverId } });
      await prisma.user.delete({ where: { id: userId } });
      expect((await prisma.mcpServer.findUniqueOrThrow({ where: { id: serverId } })).updatedAt).toEqual(beforeDeletion.updatedAt);
      await editor.getByRole("button", { name: "Save access", exact: true }).click();
      await expect(editor.getByText(/Your selections are kept/)).toBeVisible();
      await editor.getByRole("button", { name: "Refresh server data", exact: true }).click();
      await expect(editor.getByRole("button", { name: "Save access", exact: true })).toBeDisabled();
      await editor.getByRole("button", { name: "Load saved access", exact: true }).click();
      await editor.getByRole("button", { name: "Save access", exact: true }).click();
      await expect(editor).toHaveCount(0);
      expect(await policy()).toMatchObject({ restricted: false, users: [], groups: [] });
      const final = await prisma.mcpServer.findUniqueOrThrow({ where: { id: serverId } });
      expect({ ...final, updatedAt: original.updatedAt }).toEqual(original);
      expect(upstreamRequests).toBe(0);
      expect(await prisma.modelRun.count({ where: { userId } })).toBe(0);
    } finally {
      await page.goto("/admin");
      await prisma.user.deleteMany({ where: { id: userId } });
      await prisma.group.deleteMany({ where: { id: groupId } });
      if (serverId) {
        await prisma.mcpRevision.deleteMany({ where: { serverId } });
        await prisma.mcpServer.deleteMany({ where: { id: serverId } });
      }
      endpoint.closeAllConnections();
      await new Promise<void>((resolve) => endpoint.close(() => resolve()));
    }
  });
}
