import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { hashPassword } from "../../lib/server/auth/password";
import { provisionActiveUser } from "../../lib/server/auth/provisioning";
import { providerTemplateIds } from "../../lib/domain/providerTemplates";
import { runAccountMenuAction } from "./shell/page";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { startMcpOAuth } from "./support/mcpOAuthStart";
import { startOAuthMcpEndpoint } from "./support/oauthMcpEndpoint";

const prisma = new PrismaClient();
test.afterAll(() => prisma.$disconnect());
test.beforeEach(() => execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" }));

async function createOwner(page: Page) {
  const id = randomUUID();
  const email = `settings-real-${id}@example.test`;
  const password = `Synthetic-${randomUUID()}`;
  await prisma.user.create({ data: { id, email, displayName: "Synthetic Settings owner", role: "admin", status: "active",
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
    // First access may compile the catalog and Settings routes on a reused dev stand.
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible({ timeout: 90_000 });
    return id;
  } catch (error) { await prisma.user.delete({ where: { id } }); throw error; }
}

test("Memory saves the note and its switches for real and clears the note after confirming", async ({ page }, info) => {
  test.setTimeout(180_000);
  const ownerId = await createOwner(page);
  try {
    await runAccountMenuAction(page, "Memory");
    const library = page.getByTestId("library-v2");
    const offers = library.getByRole("switch", { name: "Offer to remember" });
    await expect(offers).toHaveAttribute("aria-checked", "true");
    const preference = page.waitForResponse(response => response.url().endsWith("/api/me/memory/preferences") && response.request().method() === "PATCH");
    await offers.click();
    expect((await preference).ok()).toBe(true);
    await expect(offers).toHaveAttribute("aria-checked", "false");
    for (const label of ["Use Memory in answers", "Search past chats"]) {
      await expect(library.getByRole("switch", { name: label })).toHaveAttribute("aria-checked", "true");
    }
    const note = library.getByRole("textbox", { name: "Memory note", exact: true });
    await note.fill("I prefer ceramic mugs for my morning tea.");
    const saved = page.waitForResponse(response => response.url().endsWith("/api/me/memory/note") && response.request().method() === "PUT");
    await library.getByRole("button", { name: "Save", exact: true }).click();
    expect((await saved).ok()).toBe(true);
    await page.reload();
    await runAccountMenuAction(page, "Memory");
    await expect(note).toHaveValue("I prefer ceramic mugs for my morning tea.");
    await expect(offers).toHaveAttribute("aria-checked", "false");
    expect(await prisma.userMemoryNote.findUnique({ where: { userId: ownerId } }))
      .toMatchObject({ lastChangedBy: "USER", text: "I prefer ceramic mugs for my morning tea." });
    await library.getByRole("button", { name: "Clear note…", exact: true }).click();
    const cleared = page.waitForResponse(response => response.url().endsWith("/api/me/memory/note") && response.request().method() === "PUT");
    await page.getByRole("dialog", { name: "Clear your note?" }).getByRole("button", { name: "Confirm clear note" }).click();
    expect((await cleared).ok()).toBe(true);
    await expect(note).toHaveValue("");
    await page.reload();
    await runAccountMenuAction(page, "Memory");
    await expect(note).toHaveValue("");
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: info.outputPath("memory-real-note.png") });
  } finally {
    await page.goto("about:blank");
    await prisma.user.deleteMany({ where: { id: ownerId } });
  }
});

test("MCP personal values and OAuth persist through real redirects without waking idle peers", async ({ page }, info) => {
  test.setTimeout(240_000);
  const endpoint = await startOAuthMcpEndpoint();
  const ownerId = await createOwner(page).catch(async error => { await endpoint.close(); throw error; });
  let serverId: string | undefined;
  try {
    const created = await page.request.post("/api/admin/mcp", { data: {
      name: "Synthetic Settings tools", description: "Local OAuth integration for Settings verification", activate: false,
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
    await startMcpOAuth(page, `/api/admin/mcp/${serverId}/oauth/validation/connect`);
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
    await library.getByRole("searchbox", { name: "Search MCP servers" }).fill("Synthetic Settings");
    const row = library.getByRole("article", { name: "Synthetic Settings tools", exact: true });
    await expect(row).toBeVisible();
    expect(endpoint.counts.initialize).toBe(initializations);
    await row.getByRole("button", { name: "Open Synthetic Settings tools" }).click();
    const sheet = page.getByRole("dialog", { name: "Synthetic Settings tools", exact: true });
    await sheet.getByLabel("Personal fixture key", { exact: true }).fill("synthetic-personal-value");
    const savedValues = page.waitForResponse(response => response.url().endsWith(`/api/me/mcp/${serverId}`) && response.request().method() === "PATCH");
    await sheet.getByRole("button", { name: "Save personal values" }).click();
    expect((await savedValues).ok()).toBe(true);
    await expect(sheet.getByLabel("Personal fixture key", { exact: true })).toHaveValue("");
    await sheet.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByRole("link", { name: "Approve test connection" }).click();
    await expect(page).toHaveURL(/library=mcp/);
    await expect(library.getByRole("heading", { name: "MCP servers", exact: true })).toBeVisible();
    await expect(row.getByRole("switch")).toBeChecked();
    expect(endpoint.counts.exchange).toBe(2);
    await row.getByRole("button", { name: "Open Synthetic Settings tools" }).click();
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
    await row.getByRole("button", { name: "Open Synthetic Settings tools" }).click();
    const disconnected = page.waitForResponse(response => response.url().includes(`/api/me/mcp/${serverId}/oauth/`) && response.request().method() === "POST");
    await sheet.getByRole("button", { name: "Disconnect", exact: true }).click();
    expect((await disconnected).ok()).toBe(true);
    await expect(sheet.getByRole("button", { name: "Connect", exact: true })).toBeVisible();
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
