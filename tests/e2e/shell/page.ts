import { expect, type Locator, type Page } from "@playwright/test";

export async function runAccountMenuAction(
  page: Page,
  name: "Assistants" | "Knowledge" | "Memory" | "Settings"
): Promise<Locator> {
  const accountTrigger = page.getByRole("button", { name: "Account menu" });
  await accountTrigger.click();
  const accountMenu = page.getByRole("menu", { name: "Account" });

  if (name === "Settings") {
    await accountMenu.getByRole("menuitem", { name: "Settings" }).click();
    return accountTrigger;
  }

  await accountMenu.getByRole("menuitem", { name: "Library" }).click();
  const library = page.getByTestId("library-v2");
  await expect(library).toBeVisible();
  const tab = library.getByRole("tab", { name });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  return accountTrigger;
}
