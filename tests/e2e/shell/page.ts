import { expect, type Locator, type Page } from "@playwright/test";

/** A section of Settings by its visible name. */
export type SettingsSectionName =
  | "General" | "Account" | "Data"
  | "Assistants" | "Instructions" | "Skills" | "Sub-agents" | "Automations" | "Chat defaults"
  | "Memory" | "Files" | "Artifacts"
  | "MCP servers" | "Secrets" | "Proxies"
  | "Computers" | "Telegram" | "Claude Code & Codex";

/**
 * Opens Settings with the gear at the bottom of the chat list and, for a
 * named section, shows that section. "Settings" opens the page as the gear
 * leaves it: the last visited section on a wide screen, the list of sections
 * where they take turns. Returns the gear, which a closed list hides again.
 */
export async function runAccountMenuAction(page: Page, name: "Settings" | SettingsSectionName): Promise<Locator> {
  const navigation = page.getByRole("complementary", { name: "Chat navigation" });
  const gear = navigation.getByRole("button", { name: "Settings", exact: true });
  const settings = page.getByTestId("library-v2");
  if (!(await settings.isVisible())) {
    // The list is hidden while collapsed and behind a drawer below 1024px.
    if (!(await navigation.isVisible())) {
      await page.getByRole("button", { name: "Open sidebar" }).click();
      await expect(navigation).toBeVisible();
    }
    await gear.click();
    await expect(settings).toBeVisible();
  }
  if (name === "Settings") return gear;
  await showSettingsSection(page, name);
  return gear;
}

/** Shows a section of the open Settings page at any width. */
export async function showSettingsSection(page: Page, name: SettingsSectionName): Promise<Locator> {
  const settings = page.getByTestId("library-v2");
  await expect(settings).toBeVisible();
  const tab = settings.getByRole("tab", { name, exact: true });
  // Where the list and a section take turns, another section starts from the list.
  if (!(await tab.isVisible())) {
    await settings.getByRole("button", { name: "Back to Settings" }).click();
  }
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect(settings).toHaveAttribute("data-view", "section");
  return tab;
}
