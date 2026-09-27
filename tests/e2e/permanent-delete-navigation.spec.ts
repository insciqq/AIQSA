import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { providerTemplateIds } from "../../lib/domain/providerTemplates";
import { signInWithLocalToken } from "./support/localAuth";

for (const filtered of [false, true]) {
  test(`permanent deletion removes the active chat from ${filtered ? "search results" : "navigation"} without reload`, async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    await signInWithLocalToken(page);
    const owned: string[] = [];
    try {
      for (const title of ["Queue survivor", "Queue deletion target"]) {
        const response = await page.request.post("/api/chats", { data: { title, memoryMode: "EXCLUDED" } });
        expect(response.status()).toBe(201);
        owned.push((await response.json()).chat.id);
      }
      const [survivor, target] = owned;
      await page.goto(`/c/${target}`);
      const row = page.locator(`[data-navigation-chat-id="${target}"]`);
      await expect(row.getByRole("treeitem")).toHaveAttribute("aria-current", "page");
      const filter = page.getByRole("searchbox", { name: "Filter chats" });
      if (filtered) {
        await filter.fill("Queue");
        await expect(page.getByRole("group", { name: "Results" })).toBeVisible();
        await expect(row).toBeVisible();
      }
      await row.getByRole("button", { name: "Actions: Queue deletion target" }).click();
      await page.getByRole("menuitem", { name: "Delete…", exact: true }).click();
      const response = page.waitForResponse((item) => item.request().method() === "POST" &&
        new URL(item.url()).pathname === `/api/chats/${target}/delete-permanently`);
      await page.getByRole("dialog", { name: "Delete this chat permanently?" })
        .getByRole("button", { name: "Delete permanently", exact: true }).click();
      expect((await response).status()).toBe(202);
      const status = page.getByRole("dialog", { name: "Permanent deletion", exact: true });
      await status.getByRole("button", { name: "Close", exact: true }).last().click();
      await expect(row).toHaveCount(0);
      // The deletion fallback replaces the address instead of adding history.
      await expect.poll(() => page.evaluate(() => window.location.pathname)).toBe(`/c/${survivor}`);
      await expect(filter).toHaveValue(filtered ? "Queue" : "");
      if (filtered) {
        await filter.fill("");
        await expect(page.getByRole("group", { name: "Results" })).toHaveCount(0);
        await expect(row).toHaveCount(0);
      }
      expect((await page.request.get(`/api/chats/${target}`)).status()).toBe(404);
      await page.screenshot({ path: testInfo.outputPath("deleted-chat-reconciled.png") });
    } finally {
      for (const id of owned) await page.request.delete(`/api/chats/${id}`);
    }
  });
}

test("permanent deletion after a Project visit falls back to a personal chat and keeps the Project draft", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await signInWithLocalToken(page);
  const suffix = randomUUID().slice(0, 8);
  const owned: string[] = [];
  // The personal chats are older than the Project chat, so a scope-blind
  // fallback would open the Project chat outside its Project.
  for (const title of [`Scope survivor ${suffix}`, `Scope deletion target ${suffix}`]) {
    const response = await page.request.post("/api/chats", { data: { title, memoryMode: "EXCLUDED" } });
    expect(response.status()).toBe(201);
    owned.push((await response.json()).chat.id);
  }
  const [survivor, target] = owned;
  const projectName = `Scope deletion Project ${suffix}`;
  const project = await page.request.post("/api/projects", {
    data: { name: projectName, preferredModelId: providerTemplateIds.fakeModel }
  });
  expect(project.status()).toBe(201);
  const projectId = (await project.json()).project.id as string;
  const projectChatTitle = `Scope deletion Project chat ${suffix}`;
  const projectChat = await page.request.post(`/api/projects/${projectId}/chats`, { data: { title: projectChatTitle } });
  expect(projectChat.status()).toBe(201);
  const projectChatId = (await projectChat.json()).chat.id as string;
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  const projects = page.locator('section[aria-label="Shared projects"]');
  try {
    await page.goto(`/c/${target}`);
    await expect(page.getByTestId("header-title")).toHaveText(`Scope deletion target ${suffix}`, { timeout: 30_000 });
    await expect(async () => {
      if (!(await projects.isVisible())) await page.getByRole("button", { exact: true, name: "Projects" }).click();
      await expect(projects).toBeVisible();
    }).toPass({ timeout: 30_000 });
    await projects.locator(".v2-project-row").filter({ hasText: projectName }).click();
    await projects.locator(".v2-project-chat-row").filter({ hasText: projectChatTitle }).click();
    await expect(page.getByTestId("header-title")).toHaveText(projectChatTitle, { timeout: 20_000 });
    await composer.fill("Project draft through deletion");
    await page.goBack();
    await page.goBack();
    await expect.poll(() => page.evaluate(() => window.location.pathname)).toBe(`/c/${target}`);
    await expect(page.getByTestId("header-title")).toHaveText(`Scope deletion target ${suffix}`);

    const historyLength = await page.evaluate(() => window.history.length);
    const row = page.locator(`[data-navigation-chat-id="${target}"]`);
    await row.getByRole("button", { name: `Actions: Scope deletion target ${suffix}` }).click();
    await page.getByRole("menuitem", { name: "Delete…", exact: true }).click();
    const response = page.waitForResponse((item) => item.request().method() === "POST" &&
      new URL(item.url()).pathname === `/api/chats/${target}/delete-permanently`);
    await page.getByRole("dialog", { name: "Delete this chat permanently?" })
      .getByRole("button", { name: "Delete permanently", exact: true }).click();
    expect((await response).status()).toBe(202);
    await page.getByRole("dialog", { name: "Permanent deletion", exact: true })
      .getByRole("button", { name: "Close", exact: true }).last().click();
    await expect(row).toHaveCount(0);
    // The fallback stays personal and replaces the address.
    await expect.poll(() => page.evaluate(() => window.location.pathname)).toBe(`/c/${survivor}`);
    await expect(page.getByTestId("header-title")).toHaveText(`Scope survivor ${suffix}`);
    await expect(page.getByRole("complementary", { name: "Shared project context" })).toHaveCount(0);
    expect(await page.evaluate(() => window.history.length)).toBe(historyLength);

    await page.goForward();
    await expect.poll(() => page.evaluate(() => window.location.pathname)).toBe(`/p/${projectId}`);
    await page.goForward();
    await expect.poll(() => page.evaluate(() => window.location.pathname)).toBe(`/p/${projectId}/c/${projectChatId}`);
    await expect(page.getByTestId("header-title")).toHaveText(projectChatTitle, { timeout: 20_000 });
    await expect(composer).toHaveValue("Project draft through deletion");
    await page.screenshot({ path: testInfo.outputPath("deleted-chat-scope-fallback.png") });
  } finally {
    for (const id of owned) await page.request.delete(`/api/chats/${id}`).catch(() => undefined);
    await page.request.delete(`/api/projects/${projectId}`).catch(() => undefined);
  }
});
