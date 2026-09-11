import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { LOCAL_RESTRICTED_MEMBER } from "../../prisma/local-seed-fixtures";
import { runAccountMenuAction } from "./shell/page";
import { expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
test.setTimeout(180_000);

type SkillFixture = { id: string; name: string };

async function createSkill(page: Page, name: string): Promise<SkillFixture> {
  const response = await page.request.post("/api/me/skills", {
    data: { name, description: "Synthetic Assistant fixture", instructions: "Keep the response concise." }
  });
  expect(response.status()).toBe(201);
  return (await response.json()).skill;
}

async function createAssistant(page: Page, name: string, skillIds: string[]): Promise<string> {
  const response = await page.request.get("/api/me/catalog");
  expect(response.ok()).toBe(true);
  const model = (await response.json()).catalog.models.find(
    (value: { providerFamily: string; upstreamModelId: string }) =>
      value.providerFamily === "fake" && value.upstreamModelId === "fake-qsa"
  );
  expect(model).toBeTruthy();
  const created = await page.request.post("/api/me/assistants", { data: {
    avatar: { accents: [0, 2], backgroundShape: "circle", foregroundShape: "diamond", kind: "generated",
      paletteId: "ocean", recipeVersion: 1, rotations: [0, 1] },
    category: null, description: "", developerPrompt: null,
    knowledgeSelection: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    mcpServerIds: [], name, providerModelId: model.modelId,
    runControls: { reasoningEffort: "medium" }, searchPlan: { mode: "all_selected", optionIds: [] },
    skillIds, starterPrompts: [], systemPrompt: "You are terse."
  } });
  expect(created.status()).toBe(201);
  return (await created.json()).assistant.id;
}

async function archiveSkill(page: Page, id: string, archived: boolean): Promise<void> {
  const response = await page.request.get(`/api/me/skills/${id}`);
  expect(response.ok()).toBe(true);
  const detail = (await response.json()).skill;
  expect((await page.request.patch(`/api/me/skills/${id}`, {
    data: { archived, expectedVersion: detail.version }
  })).ok()).toBe(true);
}

async function cleanFixtures(page: Page, assistantId: string | undefined, skills: SkillFixture[]): Promise<void> {
  try {
    if (assistantId) {
      const response = await page.request.get(`/api/me/assistants/${assistantId}`);
      expect(response.ok()).toBe(true);
      const detail = (await response.json()).assistant;
      expect((await page.request.patch(`/api/me/assistants/${assistantId}`, {
        data: { archived: true, expectedVersion: detail.version }
      })).ok()).toBe(true);
    }
  } finally {
    const removed = [];
    for (const skill of skills) removed.push((await page.request.delete(`/api/me/skills/${skill.id}`)).ok());
    expect(removed.every(Boolean)).toBe(true);
  }
}

async function openLibrary(page: Page): Promise<void> {
  await runAccountMenuAction(page, "Assistants");
  await expect(page.getByTestId("library-v2")).toBeVisible();
}

test("Skill availability refreshes owner repair and privacy-safe recipient cards and picker", async ({ page, browser, baseURL }) => {
  await signInWithLocalToken(page);
  const recipientContext = await browser.newContext({ baseURL, hasTouch: true, viewport: { width: 390, height: 844 } });
  const recipient = await recipientContext.newPage();
  const suffix = randomUUID().slice(0, 8);
  const name = `Shared Skill check ${suffix}`;
  const skills: SkillFixture[] = [];
  let assistantId: string | undefined;
  try {
    const skill = await createSkill(page, `Private dependency name ${suffix}`);
    skills.push(skill);
    expect((await page.request.post(`/api/me/skills/${skill.id}/publications`, { data: { scope: "installation" } })).ok()).toBe(true);
    assistantId = await createAssistant(page, name, [skill.id]);
    expect((await page.request.post(`/api/me/assistants/${assistantId}/publications`, { data: { scope: "installation" } })).ok()).toBe(true);
    await recipient.goto("/login");
    await recipient.getByLabel("Email").fill(LOCAL_RESTRICTED_MEMBER.email);
    await recipient.getByLabel("Password", { exact: true }).fill(LOCAL_RESTRICTED_MEMBER.password);
    await recipient.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(recipient.getByTestId("app-shell")).toBeVisible();

    for (const viewer of [page, recipient]) {
      await openLibrary(viewer);
      await expect(viewer.getByTestId(`assistant-card-${assistantId}`).getByRole("button", { name: `Use ${name}`, exact: true })).toBeEnabled();
    }
    await archiveSkill(page, skill.id, true);
    for (const viewer of [page, recipient]) {
      await viewer.reload();
      await openLibrary(viewer);
      const card = viewer.getByTestId(`assistant-card-${assistantId}`);
      await expect(card.getByRole("button", { name: `Use ${name}`, exact: true })).toBeDisabled();
      await expect(card).toContainText("Needs available Skills");
      await card.getByRole("button", { name: "Why?", exact: true }).click();
    }
    const ownerCard = page.getByTestId(`assistant-card-${assistantId}`);
    await ownerCard.getByRole("button", { name: "Edit setup", exact: true }).click();
    const editor = page.getByTestId("assistant-editor");
    await expect(editor).toBeVisible();
    await expect(editor.getByRole("button", { name: "Use in chat", exact: true })).toHaveCount(0);
    await editor.locator('button[aria-controls="assistant-setup-skills"]').click();
    await expect(editor.getByRole("checkbox", { name: `${skill.name} · unavailable Order 1`, exact: true })).toBeEnabled();

    const recipientCard = recipient.getByTestId(`assistant-card-${assistantId}`);
    await expect(recipientCard).toContainText("Required Skills are not available to you.");
    await expect(recipientCard.getByRole("button", { name: "Edit setup", exact: true })).toHaveCount(0);
    const hidden = await recipient.request.get(`/api/me/assistants/${assistantId}`);
    expect(hidden.ok()).toBe(true);
    const hiddenBody = await hidden.json();
    expect(hiddenBody.assistant.availability).toEqual({ ok: false, reason: "skills_access" });
    expect(JSON.stringify(hiddenBody)).not.toContain(skill.id);
    expect(JSON.stringify(hiddenBody)).not.toContain(skill.name);
    await recipient.getByRole("button", { name: "Back to chat", exact: true }).click();
    await recipient.getByRole("button", { name: "Add", exact: true }).click();
    await recipient.getByRole("menuitem", { name: /Use an Assistant/ }).click();
    await expect(recipient.getByTestId(`assistant-picker-row-${assistantId}`)).toBeDisabled();
    await recipient.keyboard.press("Escape");

    await archiveSkill(page, skill.id, false);
    for (const viewer of [page, recipient]) {
      await viewer.reload();
      await openLibrary(viewer);
      await expect(viewer.getByTestId(`assistant-card-${assistantId}`).getByRole("button", { name: `Use ${name}`, exact: true })).toBeEnabled();
    }
    await recipient.getByTestId(`assistant-card-${assistantId}`).getByRole("button", { name: `Use ${name}`, exact: true }).click();
    await expect(recipient.getByTestId("library-v2")).toHaveCount(0);
    await expect(recipient.getByRole("button", { name: "Manage selected Skills" })).toHaveText("Skills: 1");
  } finally {
    await recipientContext.close();
    await cleanFixtures(page, assistantId, skills);
  }
});

test("Assistant Skill discovery spans pages, retries failures and preserves ordered drafts and repair", async ({ page }) => {
  page.setDefaultTimeout(15_000);
  await signInWithLocalToken(page);
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  const suffix = randomUUID().slice(0, 8);
  const skills: SkillFixture[] = [];
  let assistantId: string | undefined;
  try {
    for (let index = 0; index < 33; index += 1) skills.push(await createSkill(page, `Paged ${suffix} ${String(index).padStart(2, "0")}`));
    const oldest = skills[0]!;
    const originalIds = skills.slice(1, 8).map(({ id }) => id);
    assistantId = await createAssistant(page, `Paged Assistant ${suffix}`, originalIds);
    await openLibrary(page);
    await page.getByTestId(`assistant-card-${assistantId}`).getByRole("button", { name: "Edit", exact: true }).click();
    const editor = page.getByTestId("assistant-editor");
    const description = editor.getByLabel("Description", { exact: true });
    await description.fill("Preserve this unsaved description through discovery.");
    await editor.locator('button[aria-controls="assistant-setup-skills"]').click();
    for (const [index, skill] of skills.slice(1, 8).entries()) {
      await expect(editor.getByRole("checkbox", { name: `${skill.name} Order ${index + 1}`, exact: true })).toBeChecked();
    }
    let pageAttempts = 0;
    let searchAttempts = 0;
    let detailRequests = 0;
    page.on("request", (request) => {
      if (request.method() === "GET" && /^\/api\/me\/skills\/[^/]+$/u.test(new URL(request.url()).pathname)) detailRequests += 1;
    });
    await page.route(/\/api\/me\/skills(?:\?|$)/u, async (route) => {
      const parameters = new URL(route.request().url()).searchParams;
      if ((parameters.has("cursor") && ++pageAttempts === 1) ||
        (parameters.get("q") === oldest.name && ++searchAttempts === 1)) {
        await route.fulfill({ status: 503, json: { error: "skill_request_failed" } });
      } else await route.continue();
    });
    const browse = editor.getByRole("button", { name: "Browse Skills", exact: true });
    await browse.tap();
    const picker = page.getByRole("dialog", { name: "Skills", exact: true });
    await expectWithinViewport(page, picker);
    await expectNoHorizontalOverflow(page);
    const available = picker.getByRole("list", { name: "Available Skills" });
    await expect(available.getByRole("button", { name: `Use ${oldest.name}`, exact: true })).toHaveCount(0);
    await picker.getByRole("button", { name: "Load more", exact: true }).click();
    await expect(picker.getByRole("alert")).toHaveText("More Skills could not be loaded.");
    await picker.getByRole("button", { name: "Load more", exact: true }).click();
    await available.getByRole("button", { name: `Use ${oldest.name}`, exact: true }).click();
    const selection = picker.getByRole("region", { name: "Selected Skills" });
    await expect(selection).toContainText("8 of 8 Skills selected.");
    await expect(available.getByRole("button", { name: `Use ${skills[32]!.name}`, exact: true })).toBeDisabled();
    await selection.getByRole("button", { name: `Remove manual ${oldest.name}`, exact: true }).click();
    await picker.getByRole("searchbox", { name: "Search Skills" }).fill(oldest.name);
    await expect(picker.getByRole("alert")).toContainText("Skills could not be loaded. Earlier results are shown.");
    await picker.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(available.getByRole("button", { name: /^Open / })).toHaveCount(1);
    await available.getByRole("button", { name: `Use ${oldest.name}`, exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(browse).toBeFocused();
    await expect(description).toHaveValue("Preserve this unsaved description through discovery.");
    await expect(editor.getByRole("checkbox", { name: `${oldest.name} Order 8`, exact: true })).toBeChecked();
    expect(detailRequests).toBe(0);
    await editor.getByTestId("assistant-editor-save").click();
    await expect(editor.getByTestId("assistant-library-notice")).toContainText("Saved. Future runs use these changes.");
    const saved = (await (await page.request.get(`/api/me/assistants/${assistantId}`)).json()).assistant;
    expect(saved.content.skillIds).toEqual([...originalIds, oldest.id]);

    await page.unroute(/\/api\/me\/skills(?:\?|$)/u);
    await archiveSkill(page, oldest.id, true);
    await page.reload();
    await openLibrary(page);
    await page.getByTestId(`assistant-card-${assistantId}`).getByRole("button", { name: "Edit setup", exact: true }).click();
    await editor.locator('button[aria-controls="assistant-setup-skills"]').click();
    await expect(editor.getByRole("checkbox", { name: `${oldest.name} · unavailable Order 8`, exact: true })).toBeChecked();
    // Removal deletes the row, so there is no unchecked input left to await.
    await editor.getByRole("checkbox", { name: `${oldest.name} · unavailable Order 8`, exact: true }).click();
    await expect(editor.getByRole("checkbox", { name: `${oldest.name} · unavailable Order 8`, exact: true })).toHaveCount(0);
    await editor.getByTestId("assistant-editor-save").click();
    await expect(editor.getByTestId("assistant-library-notice")).toContainText("Saved. Future runs use these changes.");
    const repaired = (await (await page.request.get(`/api/me/assistants/${assistantId}`)).json()).assistant;
    expect(repaired.content.skillIds).toEqual(originalIds);
    expect(repaired.availability.ok).toBe(true);
    expect(repaired.content.description).toBe("Preserve this unsaved description through discovery.");
  } finally {
    await cleanFixtures(page, assistantId, skills);
  }
});
