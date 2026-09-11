import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { signInWithLocalToken } from "./support/localAuth";
import { expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";

test("Project Skill selection stays scoped, reaches admission and responds to revocation", async ({ page }) => {
  test.setTimeout(180_000);
  await signInWithLocalToken(page);
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  const catalog = (await (await page.request.get("/api/me/catalog")).json()).catalog;
  const model = catalog.models.find((value: { providerFamily: string; upstreamModelId: string }) =>
    value.providerFamily === "fake" && value.upstreamModelId === "fake-qsa");
  expect(model).toBeTruthy();
  const suffix = randomUUID().slice(0, 8);
  const skills: Array<{ id: string; name: string }> = [];
  let projectId: string | undefined;
  try {
    for (const prefix of ["Personal only", "Project checklist"]) {
      const response = await page.request.post("/api/me/skills", {
        data: { name: `${prefix} ${suffix}`, description: "Synthetic selection fixture", instructions: "Keep the response concise." }
      });
      expect(response.status()).toBe(201);
      skills.push((await response.json()).skill);
    }
    const personal = skills[0]!;
    const shared = skills[1]!;
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Skills…/ }).click();
    await page.getByRole("button", { name: `Use ${personal.name}`, exact: true }).click();
    await page.keyboard.press("Escape");

    const created = await page.request.post("/api/projects", {
      data: { name: `Skill scope ${suffix}`, preferredModelId: model.modelId }
    });
    expect(created.status()).toBe(201);
    const project = (await created.json()).project;
    projectId = project.id;
    const bound = await page.request.post(`/api/projects/${project.id}/resources`, {
      data: { expectedPolicyRevision: project.policyRevision, resourceId: shared.id, type: "skill" }
    });
    expect(bound.status()).toBe(201);
    await page.getByRole("button", { name: "Projects", exact: true }).click();
    await page.locator('section[aria-label="Shared projects"] .v2-project-row').filter({ hasText: project.name }).click();
    const message = page.getByRole("textbox", { name: "Message" });
    await message.fill("Summarize the shared checklist.");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Skills…/ }).click();
    const picker = page.getByRole("dialog", { name: "Project Skills", exact: true });
    await expect(picker.getByText(personal.name, { exact: true })).toHaveCount(0);
    await expect(picker.getByRole("button", { name: "Close Skills" })).toBeFocused();
    await picker.getByRole("button", { name: `Use ${shared.name}`, exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Manage selected Skills" })).toHaveText("Skills: 1");
    await expect(message).toHaveValue("Summarize the shared checklist.");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await page.getByRole("button", { name: "Manage selected Skills" }).click();
    await expectWithinViewport(page, picker);
    await expectNoHorizontalOverflow(page);
    await picker.getByRole("button", { name: `Remove manual ${shared.name}` }).click();
    await expect(picker.getByRole("button", { name: `Use ${shared.name}`, exact: true })).toBeEnabled();
    await picker.getByRole("button", { name: `Use ${shared.name}`, exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Manage selected Skills" })).toBeFocused();
    const sent = page.waitForResponse((response) => response.request().method() === "POST" &&
      /^\/api\/chats\/[^/]+\/messages$/u.test(new URL(response.url()).pathname));
    await page.getByRole("button", { name: "Send message" }).click();
    const admitted = await sent;
    expect(admitted.ok()).toBe(true);
    expect(admitted.request().postDataJSON().skillIds).toEqual([shared.id]);
    await expect(page.getByRole("button", { name: "Send message" })).toBeVisible({ timeout: 30_000 });

    await page.getByRole("button", { name: "Manage selected Skills" }).click();
    const current = (await (await page.request.get(`/api/projects/${project.id}`)).json()).project;
    const binding = current.resources.find((resource: { resourceId: string }) => resource.resourceId === shared.id);
    const removed = await page.request.delete(`/api/projects/${project.id}/resources/${binding.id}?expectedPolicyRevision=${current.policyRevision}`);
    expect(removed.ok()).toBe(true);
    await expect(picker.getByText("No Skills have been shared with this Project.")).toBeVisible({ timeout: 20_000 });
    await expect(picker.getByRole("button", { name: `Remove manual ${shared.name}` })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: "Chats", exact: true }).click();
    await page.getByRole("button", { name: "Manage selected Skills" }).click();
    await expect(page.getByRole("dialog", { name: "Skills", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: `Remove manual ${personal.name}` })).toBeVisible();
  } finally {
    if (projectId) expect((await page.request.delete(`/api/projects/${projectId}`)).ok()).toBe(true);
    for (const skill of skills) expect((await page.request.delete(`/api/me/skills/${skill.id}`)).ok()).toBe(true);
  }
});

test("Assistant selection preserves manual Skills and permits recovery from the combined limit", async ({ page }) => {
  test.setTimeout(180_000);
  await signInWithLocalToken(page);
  const catalog = (await (await page.request.get("/api/me/catalog")).json()).catalog;
  const model = catalog.models.find((value: { providerFamily: string; upstreamModelId: string }) =>
    value.providerFamily === "fake" && value.upstreamModelId === "fake-qsa");
  expect(model).toBeTruthy();
  const suffix = randomUUID().slice(0, 8);
  const skills: Array<{ id: string; name: string }> = [];
  let assistantId: string | undefined;
  let chatId: string | null = null;
  try {
    for (let index = 0; index < 9; index += 1) {
      const response = await page.request.post("/api/me/skills", {
        data: { name: `Limit ${suffix} ${index + 1}`, description: "Synthetic limit fixture", instructions: "Keep the response concise." }
      });
      expect(response.status()).toBe(201);
      skills.push((await response.json()).skill);
    }
    const created = await page.request.post("/api/me/assistants", { data: {
      avatar: { accents: [0, 2], backgroundShape: "circle", foregroundShape: "diamond", kind: "generated",
        paletteId: "ocean", recipeVersion: 1, rotations: [0, 1] },
      category: null, description: "", developerPrompt: null,
      knowledgeSelection: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
      mcpServerIds: [], name: `Skill limit ${suffix}`, providerModelId: model.modelId,
      runControls: { reasoningEffort: "medium" }, searchPlan: { mode: "all_selected", optionIds: [] },
      skillIds: skills.slice(0, 6).map(({ id }) => id), starterPrompts: [], systemPrompt: "You are terse."
    } });
    expect(created.status()).toBe(201);
    assistantId = (await created.json()).assistant.id;
    const message = page.getByRole("textbox", { name: "Message" });
    await message.fill("Keep this draft while fixing the selection.");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Skills…/ }).click();
    const picker = page.getByRole("dialog", { name: "Skills", exact: true });
    for (const skill of skills.slice(6)) {
      await picker.getByRole("button", { name: `Use ${skill.name}`, exact: true }).click();
    }
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Manage selected Skills" })).toHaveText("Skills: 3");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByRole("menuitem", { name: /Use an Assistant/ }).click();
    await page.getByTestId(`assistant-picker-row-${assistantId}`).click();
    await expect(page.getByTestId("assistant-picker")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Manage selected Skills" })).toHaveText("Skills: 9");
    await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
    await expect(page.getByTestId("composer-v2-surface").getByRole("alert")).toHaveText(
      "Choose at most 8 Skills. Remove manual selections or change the Assistant before sending."
    );
    await expect(message).toHaveValue("Keep this draft while fixing the selection.");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Manage selected Skills" }).click();
    await expectWithinViewport(page, picker);
    const selection = picker.getByRole("region", { name: "Selected Skills" });
    await expect(selection).toContainText("Included by Assistant");
    await expect(selection).toContainText("Added manually");
    await expect(selection.getByRole("button", { name: /^Remove manual/ })).toHaveCount(3);
    for (const skill of skills.slice(0, 6)) await expect(selection).toContainText(skill.name);
    await selection.getByRole("button", { name: `Remove manual ${skills[8]!.name}` }).click();
    await expect(selection).toContainText("8 of 8 Skills selected.");
    await expect(picker.getByRole("button", { name: `Use ${skills[8]!.name}`, exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Manage selected Skills" })).toBeFocused();
    await expect(message).toHaveValue("Keep this draft while fixing the selection.");
    await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
    const sent = page.waitForResponse((response) => response.request().method() === "POST" &&
      /^\/api\/chats\/[^/]+\/messages$/u.test(new URL(response.url()).pathname));
    await page.getByRole("button", { name: "Send message" }).click();
    const admitted = await sent;
    chatId = new URL(admitted.url()).pathname.split("/")[3]!;
    expect(admitted.ok()).toBe(true);
    expect(admitted.request().postDataJSON().skillIds).toEqual(skills.slice(6, 8).map(({ id }) => id));
    await expect(page.getByRole("button", { name: "Send message" })).toBeVisible({ timeout: 30_000 });
  } finally {
    if (chatId) expect((await page.request.delete(`/api/chats/${chatId}`)).ok()).toBe(true);
    if (assistantId) {
      const response = await page.request.get(`/api/me/assistants/${assistantId}`);
      expect(response.ok()).toBe(true);
      const detail = (await response.json()).assistant;
      expect((await page.request.patch(`/api/me/assistants/${assistantId}`, {
        data: { archived: true, expectedVersion: detail.version }
      })).ok()).toBe(true);
    }
    for (const skill of skills) expect((await page.request.delete(`/api/me/skills/${skill.id}`)).ok()).toBe(true);
  }
});
