import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { memoryConsumerSettingsFixture } from "../support/memoryFixtures";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { runAccountMenuAction } from "./shell/page";
import { authenticateWithLocalToken } from "./support/localAuth";
import { expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";

const sizes = [{ width: 1440, height: 900 }, { width: 1280, height: 640 },
  { width: 768, height: 1024 }, { width: 1024, height: 768 }, { width: 390, height: 844 }, { width: 844, height: 390 }];

async function cleanupFixtures(actions: readonly (() => Promise<void>)[], errors: unknown[]) {
  for (const action of actions) {
    try { await action(); } catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Skills scenario and fixture cleanup failed");
}

async function createSkill(page: Page, name: string): Promise<{ id: string; name: string }> {
  const response = await page.request.post("/api/me/skills", { data: {
    name, description: "Review a short answer for clear claims and concrete next steps.",
    instructions: "Check the claims and finish with a short next step."
  } });
  expect(response.status()).toBe(201);
  return (await response.json()).skill;
}

async function openPins(page: Page) {
  await page.getByRole("button", { name: "Change Skills mode" }).click();
  await page.getByRole("menuitem", { name: /Skill library/ }).click();
  return page.getByRole("dialog", { name: "Skills", exact: true });
}

test("Skills preferences, Auto/Off, and Assistant delivery persist with usable responsive controls", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await authenticateWithLocalToken(page.request);
  const suffix = randomUUID().slice(0, 8);
  const skills: { id: string; name: string }[] = [];
  let assistantId: string | undefined;
  const catalogResponse = await page.request.get("/api/me/catalog");
  expect(catalogResponse.ok()).toBe(true);
  const catalog = (await catalogResponse.json()).catalog;
  const originalDefault = catalog.defaults.skillsMode ?? "auto";
  const model = catalog.models.find((model: { providerFamily: string; upstreamModelId: string }) => model.providerFamily === "fake" && model.upstreamModelId === "fake-qsa");
  expect(model).toBeTruthy();
  const errors: unknown[] = [];
  try {
    skills.push(await createSkill(page, `Review ${suffix}`));
    skills.push(await createSkill(page, `Charts ${suffix}`));
    const [review, charts] = skills;
    const created = await page.request.post("/api/me/assistants", { data: {
      avatar: { accents: [0, 2], backgroundShape: "circle", foregroundShape: "diamond", kind: "generated", paletteId: "ocean", recipeVersion: 1, rotations: [0, 1] },
      category: null, description: "A concise reviewer", developerPrompt: null,
      knowledgeSelection: { baseIds: [], mode: "none", sourceIds: [], version: 1 }, mcpServerIds: [],
      name: `Progressive helper ${suffix}`, providerModelId: model.modelId, runControls: {}, searchPlan: { mode: "all_selected", optionIds: [] },
      skills: { mode: "auto" }, skillIds: [review!.id, charts!.id], skillModes: { [review!.id]: "pinned", [charts!.id]: "available" },
      starterPrompts: [], systemPrompt: "Answer clearly."
    } });
    expect(created.status()).toBe(201);
    assistantId = (await created.json()).assistant.id;
    await page.setViewportSize(sizes[0]);
    await page.goto("/");
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Keep this draft.");
    const picker = await openPins(page);
    await picker.getByRole("searchbox", { name: "Search Skills" }).fill(suffix);
    const enabled = picker.getByRole("switch", { name: `Auto load: ${review!.name}`, exact: true });
    await expect(enabled).toHaveAttribute("aria-checked", "true");
    await enabled.click();
    await expect(enabled).toHaveAttribute("aria-checked", "false");
    expect((await (await page.request.get(`/api/me/skills/${review!.id}`)).json()).skill.enabled).toBe(false);
    await picker.getByRole("button", { name: `Always use ${review!.name}`, exact: true }).click();
    await picker.getByRole("button", { name: "Close Skills", exact: true }).click();
    const chip = page.getByRole("button", { name: "Change Skills mode" });
    await chip.click();
    await page.getByRole("menuitemradio", { name: /^Off/ }).click();
    await expect(chip).toHaveText("Skills: Off · 1");
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Keep this draft.");
    await chip.click();
    await page.getByRole("menuitemradio", { name: /^Auto/ }).click();
    await openPins(page);
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; document.documentElement.dataset.colorScheme = theme; }, theme);
      for (const size of sizes) {
        await page.setViewportSize(size);
        await expectWithinViewport(page, picker.getByRole("button", { name: "Close Skills", exact: true }));
        await expectNoHorizontalOverflow(page);
        await page.screenshot({ path: testInfo.outputPath(`skills-progressive-pins-${theme}-${size.width}x${size.height}.png`), animations: "disabled" });
      }
    }
    await picker.getByRole("button", { name: "Close Skills", exact: true }).click();
    await page.setViewportSize(sizes[0]);
    await runAccountMenuAction(page, "Assistants");
    await page.getByTestId(`assistant-card-${assistantId}`).getByRole("button", { name: "Edit", exact: true }).click();
    const editor = page.getByTestId("assistant-editor");
    await editor.locator('button[aria-controls="assistant-setup-skills"]').click();
    await expect(editor.getByText("1 of 32 Always · 1 of 64 On demand")).toBeVisible();
    await editor.getByRole("combobox", { name: `Delivery for ${review!.name}`, exact: true }).selectOption("available");
    await editor.getByRole("combobox", { name: `Delivery for ${charts!.name}`, exact: true }).selectOption("pinned");
    await editor.getByRole("radio", { name: "Off", exact: true }).click();
    await editor.getByTestId("assistant-editor-save").click();
    await expect(editor.getByTestId("assistant-library-notice")).toContainText("Saved.");
    const detail = (await (await page.request.get(`/api/me/assistants/${assistantId}`)).json()).assistant;
    expect(detail.content.skillIds).toEqual([review!.id, charts!.id]);
    expect(detail.content.skillModes).toEqual({ [review!.id]: "available", [charts!.id]: "pinned" });
    expect(detail.content.skills).toEqual({ mode: "off" });
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; document.documentElement.dataset.colorScheme = theme; }, theme);
      for (const size of sizes) {
        await page.setViewportSize(size);
        await editor.locator("#assistant-setup-skills").scrollIntoViewIfNeeded();
        await expectNoHorizontalOverflow(page);
        await page.screenshot({ path: testInfo.outputPath(`skills-progressive-assistant-${theme}-${size.width}x${size.height}.png`), animations: "disabled" });
      }
    }
    await page.setViewportSize(sizes[0]);
    await editor.getByRole("button", { name: "Use in chat", exact: true }).click();
    await expect(chip).toHaveText("Skills: Off · 2");
    await chip.click();
    await expect(page.getByRole("menuitemradio", { name: /Assistant Skills/ })).toBeDisabled();
    await page.keyboard.press("Escape");
    await runAccountMenuAction(page, "Settings");
    await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Chat defaults", exact: true }).click();
    const defaults = page.getByRole("radiogroup", { name: "Skills default" });
    const settingsWrite = page.waitForResponse(response => response.request().method() === "PATCH" && new URL(response.url()).pathname === "/api/me/settings");
    await defaults.getByRole("radio", { name: "Off", exact: true }).click();
    expect((await settingsWrite).ok()).toBe(true);
    expect((await (await page.request.get("/api/me/catalog")).json()).catalog.defaults.skillsMode).toBe("off");
  } catch (error) { errors.push(error); } finally {
    await cleanupFixtures([
      async () => { expect((await page.request.patch("/api/me/settings", { data: { defaultSkillsMode: originalDefault } })).ok()).toBe(true); },
      async () => {
        if (!assistantId) return;
        const response = await page.request.get(`/api/me/assistants/${assistantId}`);
        expect(response.ok()).toBe(true);
        const detail = (await response.json()).assistant;
        expect((await page.request.patch(`/api/me/assistants/${assistantId}`, { data: { archived: true, expectedVersion: detail.version } })).ok()).toBe(true);
      },
      ...skills.map(skill => async () => { expect((await page.request.delete(`/api/me/skills/${skill.id}`)).ok()).toBe(true); })
    ], errors);
  }
});

test("a settled load can pin an authorized Skill for the next turn without changing Off", async ({ page }, testInfo) => {
  await authenticateWithLocalToken(page.request);
  let skillId: string | undefined;
  let createdChatId: string | undefined;
  const errors: unknown[] = [];
  try {
    const skill = await createSkill(page, `Loaded review ${randomUUID().slice(0, 8)}`);
    skillId = skill.id;
    const chatResponse = await page.request.post("/api/chats", { data: { title: "Progressive Skills activity", memoryMode: "EXCLUDED" } });
    expect(chatResponse.ok()).toBe(true);
    const chatId: string = (await chatResponse.json()).chat.id;
    createdChatId = chatId;
    const timestamp = "2026-09-21T00:00:00.000Z";
    const messages = [{ id: "skill-question", role: "user", parentMessageId: null, text: "Review this answer." },
      { id: "skill-answer", role: "assistant", parentMessageId: "skill-question", text: "Here is the reviewed answer." }]
      .map(message => ({ id: message.id, role: message.role, parentMessageId: message.parentMessageId, createdAt: timestamp,
        errorMessage: null, status: "complete", content: { blocks: [{ type: "text", text: message.text }] },
        modelId: message.role === "assistant" ? "gpt-5.5" : null, modelRunId: message.role === "assistant" ? "skills-run" : null,
        provider: message.role === "assistant" ? "openai" : null,
        toolActivity: message.role === "assistant" ? { calls: [
          { origin: "skill", toolName: "load_skill", skillId: skill.id, skillName: skill.name, round: 1, status: "complete" },
          { origin: "skill", toolName: "read_skill_file", skillId: skill.id, skillName: skill.name, skillPath: "references/check.md", round: 2, status: "complete" }
        ] } : null }));
    await page.addInitScript(id => localStorage.setItem("aiqsa.activeChatId", id), chatId);
    await installMatrixCatalogFixture(page, { folders: [], chats: [{ id: chatId, title: "Progressive Skills activity", messages,
      activeLeafMessageId: "skill-answer", createdAt: timestamp, updatedAt: timestamp, defaultModelId: "gpt-5.5",
      defaultProvider: "openai", folderId: null, pinned: false, messageCount: messages.length, usageStats: null }] });
    await page.route("**/api/me/memory/settings", route => route.fulfill({ json: memoryConsumerSettingsFixture() }));
    await page.route("**/api/me/mcp", route => route.fulfill({ json: { servers: [] } }));
    await page.goto("/");
    await page.getByRole("button", { name: "Change Skills mode" }).click();
    await page.getByRole("menuitemradio", { name: /^Off/ }).click();
    await page.getByTestId("tool-activity-disclosure").locator("summary").click();
    await expect(page.getByText(`Read references/check.md · ${skill.name}`, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Pin Skill for next turn", exact: true }).click();
    await expect(page.getByRole("button", { name: "Skill pinned for next turn" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Change Skills mode" })).toHaveText("Skills: Off · 1");
    for (const size of [sizes[0], sizes[2], sizes[4], sizes[5]]) {
      await page.setViewportSize(size!);
      await expectNoHorizontalOverflow(page);
      await page.getByRole("button", { name: "Skill pinned for next turn" }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`skills-loaded-pin-${size!.width}x${size!.height}.png`), animations: "disabled" });
    }
  } catch (error) { errors.push(error); } finally {
    await cleanupFixtures([
      async () => { if (createdChatId) expect((await page.request.delete(`/api/chats/${createdChatId}`)).ok()).toBe(true); },
      async () => { if (skillId) expect((await page.request.delete(`/api/me/skills/${skillId}`)).ok()).toBe(true); }
    ], errors);
  }
});
