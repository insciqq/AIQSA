import { expect, type Locator, type Page } from "@playwright/test";

export async function runAccountMenuAction(
  page: Page,
  name: "Assistants" | "Knowledge" | "Memory" | "Settings"
): Promise<Locator> {
  // Library and the account menu live on the rail (desktop/compact) or in
  // the mobile drawer's footer, which has to be opened first.
  const rail = page.getByRole("navigation", { name: "Workspace" });
  let owner = rail;
  if (!(await rail.isVisible())) {
    const navigation = page.getByRole("complementary", { name: "Chat navigation" });
    if (!(await navigation.isVisible())) {
      await page.getByRole("button", { name: "Open sidebar" }).click();
      await expect(navigation).toBeVisible();
    }
    owner = navigation;
  }
  if (name === "Settings") {
    const accountTrigger = owner.getByRole("button", { name: "Account menu" });
    await accountTrigger.click();
    const accountMenu = page.getByRole("menu", { name: "Account" });
    await accountMenu.getByRole("menuitem", { name: "Settings" }).click();
    return accountTrigger;
  }

  const libraryTrigger = owner.getByRole("button", { name: "Library" });
  await libraryTrigger.click();
  const library = page.getByTestId("library-v2");
  await expect(library).toBeVisible();
  const tab = library.getByRole("tab", { name });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  return libraryTrigger;
}
