import { expect, type Locator, type Page } from "@playwright/test";
import { runAccountMenuAction } from "./page";

export function composerRunSummary(page: Page): Locator {
  return page.getByTestId("header-model-trigger");
}

export async function openModelPicker(page: Page): Promise<Locator> {
  const picker = page.getByRole("dialog", { name: "Choose model" });
  if (await picker.isVisible()) return picker;
  await composerRunSummary(page).click();
  await expect(picker).toBeVisible();
  // A touch screen opens the picker on itself, so no keyboard covers the list.
  const touch = await page.evaluate(() => matchMedia("(hover: none), (pointer: coarse)").matches);
  await expect(touch ? picker : picker.getByRole("searchbox", { name: "Search models" })).toBeFocused();
  return picker;
}

export async function selectModel(
  page: Page,
  provider: string,
  modelQuery: string,
  _providerNameOverride?: string
): Promise<void> {
  const picker = await openModelPicker(page);
  await picker.getByRole("searchbox", { name: "Search models" }).fill(modelQuery);
  const option = picker.locator(`[role="option"][data-provider-id="${provider}"]`)
    .filter({ hasText: modelQuery })
    .first();
  await expect(option).toBeVisible();
  await option.click();
  await expect(picker).toHaveCount(0);
}

export async function openRunSetup(page: Page): Promise<Locator> {
  const setup = page.getByRole("dialog", { name: "Model parameters" });
  if (await setup.isVisible()) return setup;
  // Parameters live in the model picker's footer (PRD §4.6).
  const picker = await openModelPicker(page);
  await picker.getByTestId("composer-v2-model-parameters").click();
  await expect(setup).toBeVisible();
  return setup;
}

export async function closeRunSetup(page: Page): Promise<void> {
  const setup = page.getByRole("dialog", { name: "Model parameters" });
  if (!(await setup.isVisible())) return;
  await setup.getByRole("button", { name: "Close parameters" }).click();
  await expect(setup).toHaveCount(0);
}

export async function reasoningOptionValues(page: Page): Promise<string[]> {
  const setup = await openRunSetup(page);
  const select = setup.getByLabel("Reasoning effort");
  const values = await select.locator("option").evaluateAll(
    (options) => options.map((option) => (option as HTMLOptionElement).value)
  );
  await closeRunSetup(page);
  return values;
}

/**
 * Makes `label` the only web search source, or turns Search off. The chip
 * saves the account's Search default for every chat, and Search is turned off
 * only in Chat defaults after its confirmation (operator decision 2026-10-24).
 */
export async function chooseSearchStrategy(page: Page, label: string): Promise<void> {
  if (/^off$/iu.test(label)) {
    await turnSearchOffInChatDefaults(page);
    return;
  }
  await page.getByRole("button", { name: /^Choose web search/u }).click();
  const search = page.getByRole("dialog", { name: "Web search" });
  const pattern = new RegExp(label, "iu");
  await search.getByRole("checkbox", { name: pattern }).check();
  // The wanted source stays on, so every other one can now be unchecked.
  for (const other of await search.getByRole("checkbox", { checked: true }).all()) {
    if (!pattern.test(await other.evaluate((element) => element.closest("label")?.textContent ?? ""))) await other.uncheck();
  }
  await page.keyboard.press("Escape");
  await expect(search).toHaveCount(0);
}

export async function turnSearchOffInChatDefaults(page: Page): Promise<void> {
  await runAccountMenuAction(page, "Chat defaults");
  const settings = page.getByTestId("library-v2");
  const summary = settings.getByLabel("Web search default");
  if (!/(^|· )Off$/u.test((await summary.innerText()).trim())) {
    await summary.click();
    await settings.getByRole("button", { name: "Turn off web search" }).click();
    await page.getByRole("dialog", { name: "Turn off web search" }).getByRole("button", { name: "Confirm turn off" }).click();
    await expect(summary).toHaveText(/(^|· )Off$/u);
  }
  await settings.getByRole("button", { name: "Back to chat" }).click();
  await expect(settings).toHaveCount(0);
}

export async function chooseReasoningEffort(page: Page, value: string): Promise<void> {
  const setup = await openRunSetup(page);
  await setup.getByLabel("Reasoning effort").selectOption(value);
  await closeRunSetup(page);
}

export async function expectRunSummary(
  page: Page,
  expected: Readonly<{
    model?: string;
    reasoning?: string;
    search?: string;
  }>
): Promise<void> {
  if (expected.model !== undefined) {
    await expect(composerRunSummary(page)).toContainText(expected.model);
  }
  if (expected.reasoning !== undefined) {
    const setup = await openRunSetup(page);
    await expect(setup.getByLabel("Reasoning effort")).toHaveValue(expected.reasoning);
    await closeRunSetup(page);
  }
  if (expected.search !== undefined) {
    if (/off/iu.test(expected.search)) {
      await expect(page.getByRole("button", { name: /^Choose web search/u })).toHaveAccessibleDescription("Search: Off");
    } else {
      await expect(page.getByRole("button", { name: /^Choose web search/u })).not.toHaveAccessibleDescription("Search: Off");
    }
  }
}
