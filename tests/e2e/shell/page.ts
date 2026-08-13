import { expect, type Locator, type Page } from "@playwright/test";

export async function runAccountMenuAction(
  page: Page,
  name: "Command palette" | "Assistants" | "Knowledge" | "Memory" | "Settings"
): Promise<Locator> {
  if (name === "Command palette") {
    const commandTrigger = page.getByRole("button", { name: "Команды" });
    await commandTrigger.click();
    return commandTrigger;
  }

  const accountTrigger = page.getByRole("button", { name: "Меню аккаунта" });
  await accountTrigger.click();
  const accountMenu = page.getByRole("menu", { name: "Аккаунт" });

  if (name === "Settings") {
    await accountMenu.getByRole("menuitem", { name: "Настройки" }).click();
    return accountTrigger;
  }

  await accountMenu.getByRole("menuitem", { name: "Библиотека" }).click();
  const library = page.getByTestId("library-v2");
  await expect(library).toBeVisible();
  const tab = library.getByRole("tab", { name });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  return accountTrigger;
}
