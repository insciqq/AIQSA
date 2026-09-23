import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { signInWithLocalToken } from "./support/localAuth";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";

const prisma = new PrismaClient();
test.afterAll(() => prisma.$disconnect());

test("folder disclosure survives reload and chats move through personal and Project folders", async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  page.setDefaultTimeout(15_000);
  const suffix = randomUUID().slice(0, 8);
  const folderIds: string[] = [], chatIds: string[] = [];
  let projectId: string | undefined;
  await signInWithLocalToken(page);
  const post = async (url: string, data: object) => {
    const response = await page.request.post(url, { data });
    expect(response.ok()).toBe(true);
    return response.json();
  };
  try {
    const parent = (await post("/api/folders", { name: `Research ${suffix}` })).folder;
    folderIds.push(parent.id);
    const child = (await post("/api/folders", { name: `Notes ${suffix}`, parentId: parent.id })).folder;
    folderIds.push(child.id);
    const chat = (await post("/api/chats", { title: `Unopened chat ${suffix}` })).chat;
    chatIds.push(chat.id);
    await page.reload();
    const parentToggle = page.getByRole("treeitem", { name: parent.name, exact: true });
    const childToggle = page.getByRole("treeitem", { name: child.name, exact: true });
    await expect(parentToggle).toHaveAttribute("aria-expanded", "true");
    await childToggle.click();
    await parentToggle.click();
    await page.reload();
    await expect(parentToggle).toHaveAttribute("aria-expanded", "false");
    await parentToggle.click();
    await expect(childToggle).toHaveAttribute("aria-expanded", "true");
    const chatRow = page.locator(`[data-navigation-chat-id="${chat.id}"]`);
    await chatRow.dragTo(page.locator(`[data-folder-id="${child.id}"] > .v2-folder-row`));
    await expect.poll(async () => (await prisma.chat.findUniqueOrThrow({ where: { id: chat.id } })).folderId).toBe(child.id);
    await expect(page.locator(`[data-folder-id="${child.id}"] [data-navigation-chat-id="${chat.id}"]`)).toBeVisible();
    await page.reload();
    await expect(childToggle).toHaveAttribute("aria-expanded", "true");
    await parentToggle.click();
    for (const viewport of [{ width: 1440, height: 900 }, { width: 768, height: 1024 }, { width: 1024, height: 768 },
      { width: 390, height: 844 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      await page.reload();
      const toggle = page.getByRole("button", { name: "Open sidebar", exact: true });
      await expect.poll(async () => await parentToggle.isVisible() || await toggle.isVisible()).toBe(true);
      if (await toggle.isVisible() && await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
      await expect(parentToggle).toBeVisible();
      await expect(parentToggle).toHaveAttribute("aria-expanded", "false");
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: testInfo.outputPath(`folders-${viewport.width}x${viewport.height}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    const project = (await post("/api/projects", { name: `Shared research ${suffix}` })).project;
    projectId = project.id;
    const projectFolder = (await post(`/api/projects/${project.id}/folders`, { name: "Project notes" })).folder;
    const projectChat = (await post(`/api/projects/${project.id}/chats`, { title: "Project draft" })).chat;
    await page.reload();
    await page.getByRole("button", { name: "Projects", exact: true }).click();
    await page.locator('section[aria-label="Shared projects"] .v2-project-row').filter({ hasText: project.name }).click();
    const projectToggle = page.getByRole("treeitem", { name: /^Project notes,/ });
    await projectToggle.click();
    await page.reload();
    await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Projects", exact: true }).click();
    await page.locator('section[aria-label="Shared projects"] .v2-project-row').filter({ hasText: project.name }).click();
    await expect(projectToggle).toHaveAttribute("aria-expanded", "false");
    await page.getByRole("treeitem", { name: "Project draft", exact: true }).locator("..").dragTo(
      page.locator(`[data-project-folder-id="${projectFolder.id}"] > .v2-project-folder-heading`));
    await expect.poll(async () => (await prisma.chat.findUniqueOrThrow({ where: { id: projectChat.id } })).projectFolderId).toBe(projectFolder.id);
    await projectToggle.click();
    await expect(page.locator(`[data-project-folder-id="${projectFolder.id}"]`).getByRole("treeitem", { name: "Project draft", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("project-folder-moved.png") });
  } finally {
    if (projectId) {
      await prisma.chat.deleteMany({ where: { projectId } });
      await prisma.projectFolder.deleteMany({ where: { projectId } });
      await prisma.project.delete({ where: { id: projectId } });
    }
    await prisma.chat.deleteMany({ where: { id: { in: chatIds } } });
    await prisma.folder.deleteMany({ where: { id: { in: folderIds } } });
  }
});
