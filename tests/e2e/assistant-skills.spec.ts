import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { LOCAL_RESTRICTED_MEMBER } from "../../prisma/local-seed-fixtures";
import { runAccountMenuAction } from "./shell/page";
import { e2eAssistantRows } from "./support/assistants";
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
    category: null, description: "", name,
    rows: e2eAssistantRows(model.modelId, {
      controls: { policy: "fixed", value: { reasoningEffort: "medium" } },
      skills: { policy: "fixed", value: { links: skillIds.map((skillId) => ({ delivery: "always", skillId })), mode: "auto" } }
    }),
    starterPrompts: [], systemPrompt: "You are terse."
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

/** Edit lives in the card's "…" menu (a sheet on phones). */
async function editAssistant(page: Page, assistantId: string, name: string): Promise<void> {
  await page.getByTestId(`assistant-card-${assistantId}`).getByRole("button", { name: `More actions for ${name}`, exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
}

function linkedSkillIds(assistant: { content: { rows: { skills: { value: { links: { skillId: string }[] } } } } }): string[] {
  return assistant.content.rows.skills.value.links.map((link) => link.skillId);
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

    const startChat = (viewer: Page) =>
      viewer.getByTestId(`assistant-card-${assistantId}`).getByRole("button", { name: `Start chat with ${name}`, exact: true });
    for (const viewer of [page, recipient]) {
      await openLibrary(viewer);
      await expect(startChat(viewer)).toBeEnabled();
    }
    await archiveSkill(page, skill.id, true);
    for (const viewer of [page, recipient]) {
      await viewer.reload();
      await openLibrary(viewer);
      await expect(startChat(viewer)).toBeDisabled();
    }
    // The card's status line is the reason: the owner reads what needs attention, the recipient only the fact.
    await expect(page.getByTestId(`assistant-card-${assistantId}`)).toContainText("Needs attention");
    await editAssistant(page, assistantId, name);
    const editor = page.getByTestId("assistant-editor");
    await expect(editor).toBeVisible();
    await editor.locator('button[aria-controls="assistant-setup-skills"]').click();
    const ownerLinks = editor.getByRole("list", { name: "Linked Skills" });
    await expect(ownerLinks.getByRole("listitem").filter({ hasText: skill.name })).toContainText("Unavailable");
    await expect(ownerLinks.getByRole("button", { name: `Remove ${skill.name}`, exact: true })).toBeEnabled();

    const recipientCard = recipient.getByTestId(`assistant-card-${assistantId}`);
    await expect(recipientCard).toContainText("Not available to you");
    await expect(recipientCard).not.toContainText(skill.name);
    // No repair path for someone else's Assistant: its menu has no Edit.
    await recipientCard.getByRole("button", { name: `More actions for ${name}`, exact: true }).click();
    await expect(recipient.getByRole("menuitem", { name: "Duplicate", exact: true })).toBeVisible();
    await expect(recipient.getByRole("menuitem", { name: "Edit", exact: true })).toHaveCount(0);
    await recipient.keyboard.press("Escape");
    await expect(recipient.getByRole("menuitem", { name: "Duplicate", exact: true })).toHaveCount(0);
    const hidden = await recipient.request.get(`/api/me/assistants/${assistantId}`);
    expect(hidden.ok()).toBe(true);
    const hiddenBody = await hidden.json();
    expect(hiddenBody.assistant.availability).toEqual({ ok: false, reason: "skills_access" });
    expect(JSON.stringify(hiddenBody)).not.toContain(skill.id);
    expect(JSON.stringify(hiddenBody)).not.toContain(skill.name);
    await recipient.getByRole("button", { name: "Back to chat", exact: true }).click();
    // The picker opens from the header selector since the "+" entry was removed.
    await recipient.getByTestId("header-assistant-selector").click();
    await expect(recipient.getByTestId(`assistant-picker-row-${assistantId}`)).toBeDisabled();
    await recipient.keyboard.press("Escape");

    await archiveSkill(page, skill.id, false);
    for (const viewer of [page, recipient]) {
      await viewer.reload();
      await openLibrary(viewer);
      await expect(startChat(viewer)).toBeEnabled();
    }
    await startChat(recipient).click();
    await expect(recipient.getByTestId("library-v2")).toHaveCount(0);
    // The Assistant's fixed Always Skill counts as pinned, and the chip says who fixed the row.
    await expect(recipient.getByRole("button", { name: "Change Skills mode" }))
      .toHaveAccessibleDescription(`Skills: Auto · 1 pinned (always loaded) · Fixed by ${name}`);
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
    const originalSkills = skills.slice(1, 32);
    const originalIds = originalSkills.map(({ id }) => id);
    const assistantName = `Paged Assistant ${suffix}`;
    assistantId = await createAssistant(page, assistantName, originalIds);
    await openLibrary(page);
    await editAssistant(page, assistantId, assistantName);
    const editor = page.getByTestId("assistant-editor");
    const description = editor.getByLabel("Description", { exact: true });
    await description.fill("Preserve this unsaved description through discovery.");
    await editor.locator('button[aria-controls="assistant-setup-skills"]').click();
    const links = editor.getByRole("list", { name: "Linked Skills" });
    await expect(links.getByRole("listitem")).toHaveCount(originalSkills.length);
    for (const [index, skill] of originalSkills.entries()) {
      await expect(links.getByRole("listitem").nth(index)).toContainText(skill.name);
    }
    await expect(editor.getByText(`${originalSkills.length} always · 0 on demand`, { exact: true })).toBeVisible();
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
    const browse = editor.getByRole("button", { name: "Add Skills…", exact: true });
    await browse.tap();
    const picker = page.getByRole("dialog", { name: "Skills", exact: true });
    await expectWithinViewport(page, picker);
    await expectNoHorizontalOverflow(page);
    const available = picker.getByRole("list", { name: "Available Skills" });
    await expect(available.getByRole("button", { name: `Select ${skills[32]!.name}`, exact: true })).toBeEnabled();
    await expect(available.getByRole("button", { name: `Select ${oldest.name}`, exact: true })).toHaveCount(0);
    await picker.getByRole("button", { name: "Load more", exact: true }).click();
    await expect(picker.getByRole("alert")).toHaveText("More Skills could not be loaded.");
    await picker.getByRole("button", { name: "Load more", exact: true }).click();
    await available.getByRole("button", { name: `Select ${oldest.name}`, exact: true }).click();
    const selection = picker.getByRole("region", { name: "Selected Skills" });
    await expect(selection).toContainText("32 Skills selected");
    await expect(selection.getByRole("button", { name: /^Remove manual / })).toHaveCount(32);
    await expect(available.getByRole("button", { name: `Select ${skills[32]!.name}`, exact: true })).toBeEnabled();
    await selection.getByRole("button", { name: `Remove manual ${oldest.name}`, exact: true }).click();
    await expect(selection).toContainText("31 Skills selected");
    await expect(available.getByRole("button", { name: `Select ${skills[32]!.name}`, exact: true })).toBeEnabled();
    await picker.getByRole("searchbox", { name: "Search Skills" }).fill(oldest.name);
    await expect(picker.getByRole("alert")).toContainText("Skills could not be loaded. Earlier results are shown.");
    await picker.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(available.getByRole("button", { name: /^Open / })).toHaveCount(1);
    await available.getByRole("button", { name: `Select ${oldest.name}`, exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(browse).toBeFocused();
    await expect(description).toHaveValue("Preserve this unsaved description through discovery.");
    await expect(links.getByRole("listitem").nth(31)).toContainText(oldest.name);
    await expect(links.getByRole("radiogroup", { name: `Delivery for ${oldest.name}` }).getByRole("radio", { name: "Always" }))
      .toHaveAttribute("aria-checked", "true");
    expect(detailRequests).toBe(0);
    await editor.getByTestId("assistant-editor-save").click();
    await expect(editor.getByTestId("assistant-library-notice")).toContainText("Saved. Future runs use these changes.");
    const saved = (await (await page.request.get(`/api/me/assistants/${assistantId}`)).json()).assistant;
    expect(linkedSkillIds(saved)).toEqual([...originalIds, oldest.id]);

    await page.unroute(/\/api\/me\/skills(?:\?|$)/u);
    await archiveSkill(page, oldest.id, true);
    await page.reload();
    await openLibrary(page);
    await editAssistant(page, assistantId, assistantName);
    await editor.locator('button[aria-controls="assistant-setup-skills"]').click();
    await expect(links.getByRole("listitem").nth(31)).toContainText("Unavailable");
    await links.getByRole("button", { name: `Remove ${oldest.name}`, exact: true }).click();
    await expect(links.getByRole("listitem").filter({ hasText: oldest.name })).toHaveCount(0);
    await editor.getByTestId("assistant-editor-save").click();
    await expect(editor.getByTestId("assistant-library-notice")).toContainText("Saved. Future runs use these changes.");
    const repaired = (await (await page.request.get(`/api/me/assistants/${assistantId}`)).json()).assistant;
    expect(linkedSkillIds(repaired)).toEqual(originalIds);
    expect(repaired.availability.ok).toBe(true);
    expect(repaired.content.description).toBe("Preserve this unsaved description through discovery.");
  } finally {
    await cleanFixtures(page, assistantId, skills);
  }
});
