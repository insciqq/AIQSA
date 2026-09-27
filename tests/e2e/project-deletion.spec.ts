import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { LOCAL_MCP_MEMBER } from "../../prisma/local-seed-fixtures";
import { workspaceSandboxName } from "../../lib/domain/workspace";
import { getWorkspaceConfig } from "../../lib/server/workspace/config";
import { expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";

const prisma = new PrismaClient();
test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);
test.use({ trace: "off" });
test.afterAll(async () => { await prisma.$disconnect(); });

async function openProjectOverview(page: Page, name: string) {
  await page.getByRole("button", { exact: true, name: "Projects" }).click();
  const projects = page.locator('section[aria-label="Shared projects"]');
  await expect(projects).toBeVisible();
  await projects.locator(".v2-project-row").filter({ hasText: name }).click();
  const overview = page.getByTestId("project-overview-page");
  await expect(overview.getByRole("heading", { name, exact: true })).toBeVisible();
  return overview;
}

test("Owner can reload a failed deletion, inspect pending status, and retry without exposing Project content", async ({ page }, testInfo) => {
  const name = `Deletion ${randomUUID()}`;
  let projectId: string | undefined;
  const sessionId = `ws_${randomBytes(20).toString("hex")}`;
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/login");
    await page.getByLabel("Email").fill(LOCAL_MCP_MEMBER.email);
    await page.getByLabel("Password", { exact: true }).fill(LOCAL_MCP_MEMBER.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 30_000 });
    const created = await page.request.post("/api/projects", { data: { name, description: "Private deletion fixture" } });
    expect(created.ok()).toBe(true);
    projectId = (await created.json()).project.id as string;
    const grant = await prisma.projectGrant.findFirstOrThrow({ where: { projectId, role: "OWNER" } });
    const chat = await prisma.chat.create({ data: { projectId, userId: null, createdByUserId: grant.userId,
      createdByDisplayName: "Deletion fixture", memoryMode: "EXCLUDED", title: "Private deletion chat" } });
    // A held receiver operation is a deterministic temporary cleanup failure;
    // it never dispatches guest commands or touches another test's Workspace.
    await prisma.workspaceSession.create({ data: { id: sessionId, chatId: chat.id,
      expiresAt: new Date(Date.now() + 3_600_000), imageRef: getWorkspaceConfig().imageRef,
      internetEnabled: false, policyRevision: 1, runtimeSandboxId: null, sandboxName: workspaceSandboxName(sessionId),
      state: "READY", operationOwner: `fixture:${randomUUID()}`, operationExpiresAt: new Date(Date.now() + 3_600_000) } });
    const overview = await openProjectOverview(page, name);
    await overview.getByRole("button", { name: `${name} details`, exact: true }).click();
    await page.getByRole("button", { name: "Delete project", exact: true }).click();
    const confirmation = page.getByRole("alertdialog", { name: "Confirm project deletion" });
    await confirmation.getByRole("textbox").fill(name);
    await confirmation.getByRole("button", { name: "Delete permanently" }).click();
    await expect(overview.getByRole("status")).toHaveText(/Deletion needs another attempt/);
    await page.reload();
    await openProjectOverview(page, name);
    await expect(overview.getByRole("button", { name: "Retry deletion" })).toBeVisible();
    await expect(overview.getByText("Private deletion chat")).toHaveCount(0);
    await expect(overview.getByText("Private deletion fixture")).toHaveCount(0);
    await expect(overview.getByText("Shared setup")).toHaveCount(0);
    for (const viewport of [{ width: 1440, height: 900 }, { width: 768, height: 1024 },
      { width: 1024, height: 768 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      const retry = overview.getByRole("button", { name: "Retry deletion" });
      await retry.scrollIntoViewIfNeeded();
      await expectWithinViewport(page, retry);
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: testInfo.outputPath(`deletion-failed-${viewport.width}x${viewport.height}.png`) });
    }
    await prisma.project.update({ where: { id: projectId }, data: { deletionLastErrorCode: null,
      deletionClaimToken: randomUUID(), deletionClaimExpiresAt: new Date(Date.now() + 3_600_000) } });
    await page.reload();
    await openProjectOverview(page, name);
    await expect(overview.getByRole("status")).toHaveText(/Deletion in progress/);
    await expect(overview.getByRole("button", { name: "Retry deletion" })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("deletion-pending.png") });
    await prisma.project.update({ where: { id: projectId }, data: { deletionLastErrorCode: "project_deletion_failed",
      deletionClaimToken: null, deletionClaimExpiresAt: null } });
    await page.reload();
    await openProjectOverview(page, name);
    const retry = overview.getByRole("button", { name: "Retry deletion" });
    await expect(retry).toBeVisible();
    await prisma.workspaceSession.update({ where: { id: sessionId }, data: { operationOwner: null, operationExpiresAt: null } });
    // Either the Owner retry or the maintenance worker may win completion.
    if (await retry.isVisible()) await retry.click();
    await expect.poll(() => prisma.project.count({ where: { id: projectId } })).toBe(0);
    await expect(page.getByText("Project deleted.", { exact: true })).toBeVisible();
  } finally {
    await prisma.workspaceCleanupJob.deleteMany({ where: { workspaceSessionId: sessionId } });
    await prisma.workspaceSession.deleteMany({ where: { id: sessionId } });
    if (projectId) await prisma.project.deleteMany({ where: { id: projectId } });
  }
});
