import { expect, test, type Page } from "@playwright/test";

async function signInToCurrentInstallation(page: Page): Promise<void> {
  await page.goto("/");
  if (/\/login(?:\?|$)/u.test(page.url())) {
    await page.getByLabel("Email").fill("operator@aiqsa.local");
    await page.getByRole("textbox", { name: "Password" }).fill("AIQSA-local-2026!");
    await Promise.all([
      page.waitForURL((url) => url.pathname === "/"),
      page.getByRole("button", { name: "Sign in" }).click()
    ]);
  }
  await expect(page.getByTestId("app-shell")).toHaveAttribute("data-ui-version", "v2");
}

test.describe.configure({ mode: "serial" });

test("uses the v2 workspace as the sole authenticated renderer", async ({ page }) => {
  await signInToCurrentInstallation(page);

  await expect(page.getByTestId("conversation-v2")).toBeVisible();
  await expect(page.getByTestId("composer-v2")).toBeVisible();
  await expect(page.locator("[data-testid='workspace-icon-rail']")).toHaveCount(0);
  await expect(page.locator("[data-testid='main-thread-pane']")).toHaveCount(0);

  const navigation = page.getByRole("complementary", { name: "Навигация по чатам" });
  await expect(navigation.getByRole("button", { name: "Новый чат" })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Библиотека" })).toBeVisible();

  const actionTrigger = navigation.getByRole("button", { name: /^Действия:/u }).first();
  if (await actionTrigger.count()) {
    await actionTrigger.click();
    const menu = page.getByRole("menu").filter({ has: page.getByRole("menuitem", { name: "Переименовать" }) });
    await expect(menu.getByRole("menuitem", { name: "Переместить" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Поделиться" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Экспортировать" })).toBeVisible();
    await page.keyboard.press("Escape");
  }

  const firstChat = navigation.locator(".v2-chat-row").first();
  if (await firstChat.count()) {
    await firstChat.click();
    await page.locator("[data-testid='conversation-loading']").waitFor({ state: "detached" });
    await expect(page.getByRole("button", { name: "Ветви" })).toBeVisible();
    await page.getByRole("button", { name: "Ветви" }).click();
    await expect(page.getByTestId("branch-drawer-scrim")).toBeVisible();
    await page.getByRole("button", { name: "Закрыть ветви" }).click();

    const runDetails = page.getByRole("button", { name: /Run details/u }).first();
    if (await runDetails.count()) {
      await runDetails.click();
      await expect(page.getByTestId("run-details-scrim")).toBeVisible();
      await page.getByRole("button", { name: "Закрыть детали run" }).click();
    }
  }

  await navigation.getByRole("button", { name: "Библиотека" }).click();
  await expect(page.getByTestId("library-v2")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Assistants" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Memory" })).toBeVisible();
  await page.getByRole("button", { name: "Назад к чату" }).click();

  await page.getByRole("button", { name: "Меню аккаунта" }).click();
  await page.getByRole("menuitem", { name: "Настройки" }).click();
  await expect(page.getByTestId("settings-v2")).toBeVisible();
  await page.getByRole("button", { name: "Закрыть настройки" }).click();
});

test("keeps the production workspace usable at the mobile breakpoint", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInToCurrentInstallation(page);

  await expect(page.getByRole("button", { name: "Открыть панель" })).toBeVisible();
  await page.getByRole("button", { name: "Открыть панель" }).click();
  const navigation = page.getByRole("complementary", { name: "Навигация по чатам" });
  await expect(navigation).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Новый чат" })).toBeVisible();
  await page.getByRole("button", { name: "Закрыть панель" }).click();
  await expect(page.getByTestId("composer-v2")).toBeVisible();
});
