import { expect, type Locator, type Page } from "@playwright/test";
import { matrixCatalog } from "./catalog";

export async function selectModel(
  page: Page,
  provider: string,
  modelQuery: string,
  providerNameOverride?: string
): Promise<void> {
  const providerName =
    providerNameOverride ?? matrixCatalog.providers.find((candidate) => candidate.id === provider)?.name ?? provider;
  const providerNamePattern = new RegExp(`^${providerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
  const controls = await openRunSetup(page);
  await controls.getByRole("button", { name: "Select model" }).click();
  await expect(page.getByLabel("Search models")).toBeFocused();
  await page.getByLabel("Search models").fill(modelQuery);
  const modelPicker = page.getByTestId("model-picker");
  const providerSection = modelPicker.locator("section").filter({
    has: page.getByRole("heading", { name: providerNamePattern })
  });
  await providerSection.getByRole("button", { name: /^Select model / }).first().click();
  await closeRunSetup(page);
}

export async function reasoningOptionValues(page: Page): Promise<string[]> {
  const controls = await openRunSetup(page);
  await controls.getByRole("button", { name: "Reasoning effort", exact: true }).click();
  const values = await controls
    .getByTestId("composer-reasoning-effort-options")
    .locator("[data-option-value]")
    .evaluateAll((options) => options.map((option) => option.getAttribute("data-option-value") ?? ""));
  await controls.getByRole("button", { name: "Reasoning effort", exact: true }).click();
  await closeRunSetup(page);
  return values;
}

export async function chooseSearchStrategy(page: Page, label: string): Promise<void> {
  const controls = await openRunSetup(page);
  await controls.getByRole("button", { name: "Search strategy" }).click();
  await controls.getByTestId("search-select-options").getByRole("button", { name: new RegExp(label) }).click();
  await closeRunSetup(page);
}

export async function chooseReasoningEffort(page: Page, value: string): Promise<void> {
  const controls = await openRunSetup(page);
  await controls.getByRole("button", { name: "Reasoning effort", exact: true }).click();
  await controls
    .getByTestId("composer-reasoning-effort-options")
    .locator(`[data-option-value="${value}"]`)
    .click();
  await closeRunSetup(page);
}

export function composerRunSummary(page: Page): Locator {
  return page.getByTestId("composer-run-summary");
}

export async function openRunSetup(page: Page): Promise<Locator> {
  const sheet = page.getByTestId("run-setup-sheet");
  if (await sheet.isVisible()) {
    return sheet;
  }

  await composerRunSummary(page).click();
  await expect(sheet).toBeVisible();
  return sheet;
}

export async function closeRunSetup(page: Page): Promise<void> {
  const sheet = page.getByTestId("run-setup-sheet");
  if (!(await sheet.isVisible())) {
    return;
  }

  await sheet.getByRole("button", { name: "Close run setup" }).click();
  await expect(sheet).toHaveCount(0);
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
    await expect(page.getByTestId("run-model-summary")).toHaveText(expected.model);
  }
  if (expected.reasoning !== undefined) {
    await expect(page.getByTestId("run-reasoning-summary")).toHaveText(`Reasoning: ${expected.reasoning}`);
  }
  if (expected.search !== undefined) {
    await expect(page.getByTestId("run-search-summary")).toHaveText(`Search: ${expected.search}`);
  }
}
