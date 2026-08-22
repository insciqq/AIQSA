import { expect, type Locator, type Page } from "@playwright/test";

export async function runAccountMenuAction(
  page: Page,
  name: "Assistants" | "Knowledge" | "Memory" | "Settings"
): Promise<Locator> {
  // The account menu lives in the sidebar footer; Library is the sidebar row.
  // Compact and mobile compositions keep the sidebar closed, so open it first.
  const navigation = page.getByRole("complementary", { name: "Chat navigation" });
  if (!(await navigation.isVisible())) {
    await page.getByRole("button", { name: "Open sidebar" }).click();
    await expect(navigation).toBeVisible();
  }
  if (name === "Settings") {
    const accountTrigger = navigation.getByRole("button", { name: "Account menu" });
    await accountTrigger.click();
    const accountMenu = page.getByRole("menu", { name: "Account" });
    await accountMenu.getByRole("menuitem", { name: "Settings" }).click();
    return accountTrigger;
  }

  const libraryTrigger = navigation.getByRole("button", { name: "Library" });
  await libraryTrigger.click();
  const library = page.getByTestId("library-v2");
  await expect(library).toBeVisible();
  const tab = library.getByRole("tab", { name });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  return libraryTrigger;
}
