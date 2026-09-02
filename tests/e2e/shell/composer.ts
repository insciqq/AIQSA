import { expect, type Locator, type Page } from "@playwright/test";

export function composerRunSummary(page: Page): Locator {
  return page.getByTestId("header-model-trigger");
}

export async function openModelPicker(page: Page): Promise<Locator> {
  const picker = page.getByRole("dialog", { name: "Choose model" });
  if (await picker.isVisible()) return picker;
  await composerRunSummary(page).click();
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("searchbox", { name: "Search models" })).toBeFocused();
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

export async function chooseSearchStrategy(page: Page, label: string): Promise<void> {
  if (/off/iu.test(label)) {
    const indicator = page.getByRole("button", { name: "Turn off Search" });
    if (await indicator.isVisible()) await indicator.click();
    await expect(indicator).toHaveCount(0);
    return;
  }

  // The Search chip owns its engine menu; choosing an engine closes it.
  await page.getByRole("button", { name: "Choose web search" }).click();
  const search = page.getByRole("menu", { name: "Web search" });
  await search.getByRole("menuitemradio", { name: new RegExp(label, "iu") }).click();
  await expect(search).toHaveCount(0);
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
      await expect(page.getByRole("button", { name: "Turn off Search" })).toHaveCount(0);
    } else {
      await expect(page.getByRole("button", { name: "Turn off Search" })).toBeVisible();
    }
  }
}
