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
  await expect(page.getByTestId("app-shell")).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test("uses the current workspace as the authenticated renderer", async ({ page }) => {
  await signInToCurrentInstallation(page);

  await expect(page.getByTestId("conversation-v2")).toBeVisible();
  await expect(page.getByTestId("composer-v2")).toBeVisible();
  const navigation = page.getByRole("complementary", { name: "Chat navigation" });
  await expect(navigation.getByRole("button", { exact: true, name: "New chat" })).toBeVisible();
  // Permanent destinations live on the rail beside the list.
  const rail = page.getByRole("navigation", { name: "Workspace" });
  await expect(rail.getByRole("button", { name: "Library" })).toBeVisible();
  await expect(rail.getByRole("button", { exact: true, name: "Chats" })).toHaveAttribute("aria-current", "page");

  const actionTrigger = navigation.getByRole("button", { name: /^Actions:/u }).first();
  if (await actionTrigger.count()) {
    await actionTrigger.click();
    const menu = page.getByRole("menu").filter({ has: page.getByRole("menuitem", { name: "Rename" }) });
    await expect(menu.getByRole("menuitem")).toHaveText([
      "Rename",
      "Move to…",
      "Favorite",
      "Archive",
      "Delete…"
    ]);
    await page.keyboard.press("Escape");
  }

  const firstChat = navigation.locator(".v2-chat-row").first();
  if (await firstChat.count()) {
    await firstChat.click();
    await page.locator("[data-testid='conversation-loading']").waitFor({ state: "detached" });
    // The header keeps Share plus one "⋯" menu; Branches lives inside it.
    await expect(page.getByRole("button", { name: "Share" })).toBeVisible();
    await page.getByTestId("header-more-trigger").click();
    await page.getByRole("menuitem", { name: "Export" }).click();
    await expect(page.getByLabel("Export").getByRole("menuitem")).toHaveText([
      "Markdown",
      "JSON",
      "Copy entire thread"
    ]);
    await page.keyboard.press("Escape");
    await page.getByTestId("header-more-trigger").click();
    await page.getByRole("menuitem", { name: "Branches" }).click();
    await expect(page.getByTestId("branch-drawer-scrim")).toBeVisible();
    await page.getByRole("button", { name: "Close branches" }).click();

    await expect(page.getByRole("button", { name: /Run details/u })).toHaveCount(0);
    await expect(page.getByText("Answer evidence", { exact: true })).toHaveCount(0);
  }

  await rail.getByRole("button", { name: "Library" }).click();
  await expect(page.getByTestId("library-v2")).toBeVisible();
  await expect(rail.getByRole("button", { name: "Library" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("tab", { name: "Assistants" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Memory" })).toBeVisible();
  await page.getByRole("button", { name: "Back to chat" }).click();
  await expect(page.getByTestId("library-v2")).toHaveCount(0);

  await rail.getByRole("button", { name: "Account menu" }).click();
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
