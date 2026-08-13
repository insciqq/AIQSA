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

  const navigation = page.getByRole("complementary", { name: "Chat navigation" });
  await expect(navigation.getByRole("button", { exact: true, name: "New chat" })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Library" })).toBeVisible();

  const actionTrigger = navigation.getByRole("button", { name: /^Actions:/u }).first();
  if (await actionTrigger.count()) {
    await actionTrigger.click();
    const menu = page.getByRole("menu").filter({ has: page.getByRole("menuitem", { name: "Rename" }) });
    await expect(menu.getByRole("menuitem", { name: "Move to…" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Share" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Export" })).toBeVisible();
    await page.keyboard.press("Escape");
  }

  const firstChat = navigation.locator(".v2-chat-row").first();
  if (await firstChat.count()) {
    await firstChat.click();
    await page.locator("[data-testid='conversation-loading']").waitFor({ state: "detached" });
    // The header keeps Share plus one "⋯" menu; Branches lives inside it.
    await expect(page.getByRole("button", { name: "Share" })).toBeVisible();
    await page.getByTestId("header-more-trigger").click();
    await page.getByRole("menuitem", { name: "Branches" }).click();
    await expect(page.getByTestId("branch-drawer-scrim")).toBeVisible();
    await page.getByRole("button", { name: "Close branches" }).click();

    const runDetails = page.getByRole("button", { name: /Run details/u }).first();
    if (await runDetails.count()) {
      await runDetails.click();
      await expect(page.getByTestId("run-details-scrim")).toBeVisible();
      await page.getByRole("button", { name: "Close run details" }).click();
    }
  }

  await navigation.getByRole("button", { name: "Library" }).click();
  await expect(page.getByTestId("library-v2")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Assistants" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Memory" })).toBeVisible();
  await page.getByRole("button", { name: "Back to chat" }).click();

  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await expect(page.getByTestId("settings-v2")).toBeVisible();
  await page.getByRole("button", { name: "Close settings" }).click();
});

test("keeps the production workspace usable at the mobile breakpoint", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInToCurrentInstallation(page);

  await expect(page.getByRole("button", { name: "Open sidebar" })).toBeVisible();
  await page.getByRole("button", { name: "Open sidebar" }).click();
  const navigation = page.getByRole("complementary", { name: "Chat navigation" });
  await expect(navigation).toBeVisible();
  await expect(navigation.getByRole("button", { exact: true, name: "New chat" })).toBeVisible();
  await page.getByRole("button", { name: "Close sidebar" }).click();
  await expect(page.getByTestId("composer-v2")).toBeVisible();
});
