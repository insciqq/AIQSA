import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { hashPassword } from "../../lib/server/auth/password";
import { provisionActiveUser } from "../../lib/server/auth/provisioning";
import { providerTemplateIds } from "../../lib/domain/providerTemplates";
import { runAccountMenuAction } from "./shell/page";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { startOAuthMcpEndpoint } from "./support/oauthMcpEndpoint";

const prisma = new PrismaClient();
test.afterAll(() => prisma.$disconnect());
test.beforeEach(() => execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" }));

async function createOwner(page: Page) {
  const id = randomUUID();
  const email = `studio-real-${id}@example.test`;
  const password = `Synthetic-${randomUUID()}`;
  await prisma.user.create({ data: { id, email, displayName: "Synthetic Studio owner", role: "admin", status: "active",
    authIdentities: { create: { normalizedEmail: email, provider: "password", providerAccountId: email,
      passwordHash: await hashPassword(password), emailVerifiedAt: new Date() } } } });
  try {
    await prisma.$transaction(tx => provisionActiveUser(tx, { userId: id, groups: [] }));
    await prisma.accessGrant.create({ data: { userId: id, providerModelId: providerTemplateIds.fakeModel } });
    await prisma.userSettings.update({ where: { userId: id }, data: { defaultProviderModelId: providerTemplateIds.fakeModel } });
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    // First access may compile the catalog and Memory routes on a reused dev stand.
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible({ timeout: 90_000 });
    return id;
  } catch (error) { await prisma.user.delete({ where: { id } }); throw error; }
}

test("Memory saves and forgets actual owned facts and persists the reset", async ({ page }, info) => {
  test.setTimeout(180_000);
  const ownerId = await createOwner(page);
  try {
    await runAccountMenuAction(page, "Memory");
    const library = page.getByTestId("library-v2");
    const learn = library.getByRole("switch", { name: /^Learn automatically:/ });
    await expect(learn).toBeChecked();
    const preference = page.waitForResponse(response => response.url().endsWith("/api/me/memory/settings") && response.request().method() === "PATCH");
    await learn.click();
    expect((await preference).ok()).toBe(true);
    await expect(learn).not.toBeChecked();
    for (const label of ["Use memories in answers", "Search past chats", "Notice repeated details", "Learn from what you use"]) {
      await expect(library.getByRole("switch", { name: new RegExp(`^${label}:`) })).toBeChecked();
    }
    await library.getByRole("button", { name: "Add memory", exact: true }).first().click();
    await library.getByRole("textbox", { name: "New memory", exact: true }).fill("I prefer ceramic mugs for my morning tea.");
    const saved = page.waitForResponse(response => response.url().endsWith("/api/me/memories") && response.request().method() === "POST");
    await library.getByRole("button", { name: "Save memory", exact: true }).click();
    expect((await saved).ok()).toBe(true);
    await expect(library.getByText("I prefer ceramic mugs for my morning tea.", { exact: true })).toBeVisible();
    await page.reload();
    await runAccountMenuAction(page, "Memory");
    await expect(library.getByText("I prefer ceramic mugs for my morning tea.", { exact: true })).toBeVisible();
    await library.getByRole("button", { name: "Add memory", exact: true }).first().click();
    await library.getByRole("textbox", { name: "New memory", exact: true }).fill("An unsaved draft to clear");
    await library.getByRole("button", { name: "Forget everything…" }).click();
    const reset = page.waitForResponse(response => response.url().endsWith("/api/me/memory/reset"));
    await page.getByRole("alertdialog", { name: "Forget everything?" }).getByRole("button", { name: "Forget everything", exact: true }).click();
    expect((await reset).ok()).toBe(true);
    await expect(library.getByRole("textbox", { name: "New memory", exact: true })).toHaveCount(0);
    await expect(library.getByText("I prefer ceramic mugs for my morning tea.", { exact: true })).toHaveCount(0);
    await page.reload();
    await runAccountMenuAction(page, "Memory");
    await expect(library.getByRole("button", { name: "Add memory", exact: true }).first()).toBeEnabled();
    const list = await page.request.get("/api/me/memories?pageSize=20");
    expect(list.ok()).toBe(true);
    expect((await list.json()).items).toEqual([]);
    for (const label of ["Use memories in answers", "Search past chats", "Learn automatically", "Notice repeated details", "Learn from what you use"]) {
      await expect(library.getByRole("switch", { name: new RegExp(`^${label}:`) })).not.toBeChecked();
    }
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: info.outputPath("memory-real-reset.png") });
  } finally {
    await page.goto("about:blank");
    await prisma.$transaction([
      prisma.memoryDeletionOutbox.deleteMany({ where: { userId: ownerId } }),
      prisma.user.deleteMany({ where: { id: ownerId } })
    ]);
  }
});

test("MCP personal values and OAuth persist through real redirects without waking idle peers", async ({ page }, info) => {
  test.setTimeout(240_000);
  const endpoint = await startOAuthMcpEndpoint();
  const ownerId = await createOwner(page).catch(async error => { await endpoint.close(); throw error; });
  let serverId: string | undefined;
  try {
    const created = await page.request.post("/api/admin/mcp", { data: {
      name: "Synthetic Studio tools", description: "Local OAuth integration for Studio verification", activate: false,
      sharedValues: { fixture_key: "synthetic-shared-value" }, draft: {
        auth: { mode: "oauth", scopes: ["mcp.read"], allowedAuthorizationServerOrigins: [endpoint.origin] },
        source: { kind: "remote", url: `${endpoint.origin}/mcp`, allowPrivateNetwork: true }, transport: "streamable_http",
        runtime: { startupTimeoutMs: 10_000, callTimeoutMs: 10_000 },
        slots: [{ slotKey: "fixture_key", label: "Personal fixture key", sensitive: true, valueType: "secret",
          target: { kind: "header", name: "X-Fixture-Key" }, policy: { kind: "shared", allowPersonalOverride: true } }]
      }
    } });
    expect(created.status()).toBe(201);
    serverId = (await created.json()).server.id;
    await page.goto(`/api/admin/mcp/${serverId}/oauth/validation/connect`);
    await page.getByRole("link", { name: "Approve test connection" }).click();
    await expect(page).toHaveURL(/\/admin\?/);
    await expect.poll(async () => Boolean((await prisma.mcpServer.findUniqueOrThrow({ where: { id: serverId } })).activeRevisionId), { timeout: 30_000 }).toBe(true);
    expect(endpoint.counts.exchange).toBe(1);
    expect(endpoint.counts.list).toBeGreaterThan(0);
    const grant = await page.request.put(`/api/admin/mcp/${serverId}/grants`, { data: { userId: ownerId, canUse: true, personalSlotKeys: ["fixture_key"] } });
    expect(grant.ok()).toBe(true);
    await page.goto("/");
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible({ timeout: 30_000 });
    const initializations = endpoint.counts.initialize;
    await runAccountMenuAction(page, "MCP servers");
    const library = page.getByTestId("library-v2");
    await library.getByRole("searchbox").fill("Synthetic Studio");
    const row = library.getByRole("article", { name: "Synthetic Studio tools", exact: true });
    await expect(row).toBeVisible();
    expect(endpoint.counts.initialize).toBe(initializations);
    await row.getByRole("button", { name: "Open Synthetic Studio tools" }).click();
    const sheet = page.getByRole("dialog", { name: "Synthetic Studio tools", exact: true });
    await sheet.getByLabel("Personal fixture key", { exact: true }).fill("synthetic-personal-value");
    const savedValues = page.waitForResponse(response => response.url().endsWith(`/api/me/mcp/${serverId}`) && response.request().method() === "PATCH");
    await sheet.getByRole("button", { name: "Save personal values" }).click();
    expect((await savedValues).ok()).toBe(true);
    await expect(sheet.getByLabel("Personal fixture key", { exact: true })).toHaveValue("");
    await sheet.getByRole("link", { name: "Connect", exact: true }).click();
    await page.getByRole("link", { name: "Approve test connection" }).click();
    await expect(page).toHaveURL(/library=mcp/);
    await expect(library.getByRole("heading", { name: "MCP servers", exact: true })).toBeVisible();
    await expect(row.getByRole("switch")).toBeChecked();
    expect(endpoint.counts.exchange).toBe(2);
    await row.getByRole("button", { name: "Open Synthetic Studio tools" }).click();
    await expect(sheet.getByRole("heading", { name: "Tools · 1", exact: true })).toBeVisible();
    // Enabling and observing a remote server does not initialize its runtime.
    // Names appear after a run obtains fresh protocol evidence; the saved count is available now.
    expect(endpoint.counts.initialize).toBe(initializations);
    const personalCatalog = await page.request.get("/api/me/mcp");
    const projection = await personalCatalog.text();
    expect(projection).not.toContain("synthetic-personal-value");
    expect(JSON.parse(projection).servers.find((server: { id: string }) => server.id === serverId).fields)
      .toContainEqual(expect.objectContaining({ slotKey: "fixture_key", configured: true, source: "personal" }));
    await expect(sheet.getByLabel("Personal fixture key", { exact: true })).toHaveValue("");
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: info.outputPath("mcp-real-oauth-connected.png") });
    await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
    await row.getByRole("switch").click();
    await expect(row.getByRole("switch")).not.toBeChecked();
    await page.reload();
    await runAccountMenuAction(page, "MCP servers");
    await expect(row.getByRole("switch")).not.toBeChecked();
    await row.getByRole("switch").click();
    await expect(row.getByRole("switch")).toBeChecked();
    await row.getByRole("button", { name: "Open Synthetic Studio tools" }).click();
    const disconnected = page.waitForResponse(response => response.url().includes(`/api/me/mcp/${serverId}/oauth/`) && response.request().method() === "POST");
    await sheet.getByRole("button", { name: "Disconnect", exact: true }).click();
    expect((await disconnected).ok()).toBe(true);
    await expect(sheet.getByRole("link", { name: "Connect", exact: true })).toBeVisible();
    expect(endpoint.counts.revoke).toBeGreaterThan(0);
    expect(endpoint.counts.errors).toBe(0);
    expect(endpoint.counts.personalHeader).toBe(0);
    expect(await prisma.modelRun.count({ where: { userId: ownerId } })).toBe(0);
  } finally {
    await page.goto("about:blank");
    if (serverId) {
      const clients = await prisma.mcpOAuthConnection.findMany({ where: { serverId }, select: { oauthClientId: true } });
      await page.request.delete(`/api/admin/mcp/${serverId}`);
      await prisma.mcpRevision.deleteMany({ where: { serverId } });
      await prisma.mcpServer.deleteMany({ where: { id: serverId } });
      await prisma.mcpOAuthClient.deleteMany({ where: { id: { in: clients.flatMap(client => client.oauthClientId ? [client.oauthClientId] : []) } } });
    }
    await prisma.user.deleteMany({ where: { id: ownerId } });
    await endpoint.close();
  }
});
