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
  await closeRunSettings(page);
  const compact = await composerRunSummary(page).isVisible();
  const controls = compact ? await openRunSetup(page) : composerRestingControls(page);
  await controls.getByRole("button", { name: "Select model" }).click();
  await expect(page.getByLabel("Search models")).toBeFocused();
  await page.getByLabel("Search models").fill(modelQuery);
  const modelPicker = page.getByTestId("model-picker");
  const providerSection = modelPicker.locator("section").filter({
    has: page.getByRole("heading", { name: providerNamePattern })
  });
  await providerSection.getByRole("button", { name: /^Select model / }).first().click();
  if (compact) {
    await closeRunSetup(page);
  }
}

export async function reasoningOptionValues(page: Page): Promise<string[]> {
  await closeRunSettings(page);
  const compact = await composerRunSummary(page).isVisible();
  const controls = compact ? await openRunSetup(page) : composerRestingControls(page);
  await controls.getByRole("button", { name: "Reasoning effort", exact: true }).click();
  const values = await controls
    .getByTestId("composer-reasoning-effort-options")
    .locator("[data-option-value]")
    .evaluateAll((options) => options.map((option) => option.getAttribute("data-option-value") ?? ""));
  await controls.getByRole("button", { name: "Reasoning effort", exact: true }).click();
  if (compact) {
    await closeRunSetup(page);
  }
  return values;
}

export async function chooseSearchStrategy(page: Page, label: string): Promise<void> {
  await closeRunSettings(page);
  const compact = await composerRunSummary(page).isVisible();
  const controls = compact ? await openRunSetup(page) : composerRestingControls(page);
  await controls.getByRole("button", { name: "Search strategy" }).click();
  await controls.getByTestId("search-select-options").getByRole("button", { name: new RegExp(label) }).click();
  if (compact) {
    await closeRunSetup(page);
  }
}

export async function chooseReasoningEffort(page: Page, value: string): Promise<void> {
  await closeRunSettings(page);
  const compact = await composerRunSummary(page).isVisible();
  const controls = compact ? await openRunSetup(page) : composerRestingControls(page);
  await controls.getByRole("button", { name: "Reasoning effort", exact: true }).click();
  await controls
    .getByTestId("composer-reasoning-effort-options")
    .locator(`[data-option-value="${value}"]`)
    .click();
  if (compact) {
    await closeRunSetup(page);
  }
}

export function composerRestingControls(page: Page): Locator {
  return page.getByTestId("composer-control-bar");
}

export function composerRestingButton(page: Page, name: string): Locator {
  return composerRestingControls(page).getByRole("button", { name });
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

export async function openRunSettings(page: Page): Promise<Locator> {
  const settings = page.getByTestId("run-settings-menu");
  if (await settings.isVisible()) {
    return settings;
  }

  await composerRestingButton(page, "Run settings").click();
  await expect(settings).toBeVisible();
  return settings;
}

export async function closeRunSettings(page: Page): Promise<void> {
  const settings = page.getByTestId("run-settings-menu");
  if (!(await settings.isVisible())) {
    return;
  }

  await settings.getByRole("button", { name: "Close run settings" }).click();
  await expect(settings).toHaveCount(0);
}

export async function runSettingsButton(page: Page, name: string): Promise<Locator> {
  return (await openRunSettings(page)).getByRole("button", { name });
}
