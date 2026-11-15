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
  await expect(navigation.getByRole("link", { exact: true, name: "New chat" })).toBeVisible();
  // No rail: the list's footer holds the account entry, Announcements and Settings.
  await expect(page.locator("[data-testid='workspace-rail'], .v2-rail")).toHaveCount(0);
  const footer = navigation.getByTestId("navigation-footer");
  const accountMenu = footer.getByRole("button", { name: "Account menu" });
  const gear = footer.getByRole("button", { exact: true, name: "Settings" });
  await expect(accountMenu).toBeVisible();
  await expect(footer.getByRole("button", { name: /^Announcements/u })).toBeVisible();
  await expect(gear).toBeVisible();

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
    await page.getByRole("menuitem", { name: "Export", exact: true }).click();
    await expect(page.getByLabel("Export", { exact: true }).getByRole("menuitem")).toHaveText([
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

  // The gear opens Settings in place of the chat list.
  await gear.click();
  await expect(page.getByTestId("library-v2")).toBeVisible();
  await expect(navigation).toBeHidden();
  await expect(page).toHaveTitle("Settings · AIQSA");
  for (const name of ["General", "Account", "Data", "Assistants", "Memory", "MCP servers", "Claude Code & Codex"]) {
    await expect(page.getByRole("tab", { exact: true, name })).toBeVisible();
  }
  await page.getByRole("button", { name: "Back to chat" }).click();
  await expect(page.getByTestId("library-v2")).toHaveCount(0);
  await expect(navigation).toBeVisible();

  // The account menu keeps who is signed in and Sign out; Settings is the gear beside it.
  await accountMenu.click();
  const menu = page.getByRole("menu", { name: "Account" });
  await expect(menu.getByRole("menuitem", { name: "Sign out" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Settings" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
});

test("keeps the production workspace usable at the mobile breakpoint", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInToCurrentInstallation(page);

  await expect(page.getByRole("button", { name: "Open sidebar" })).toBeVisible();
  await page.getByRole("button", { name: "Open sidebar" }).click();
  const navigation = page.getByRole("complementary", { name: "Chat navigation" });
  await expect(navigation).toBeVisible();
  await expect(navigation.getByRole("link", { exact: true, name: "New chat" })).toBeVisible();
  await page.getByRole("button", { name: "Close sidebar" }).click();
  await expect(page.getByTestId("composer-v2")).toBeVisible();

  // The drawer's gear shows the list of Settings sections; Back to chat returns.
  await page.getByRole("button", { name: "Open sidebar" }).click();
  await navigation.getByTestId("navigation-footer").getByRole("button", { exact: true, name: "Settings" }).click();
  const settings = page.getByTestId("library-v2");
  await expect(settings).toHaveAttribute("data-view", "list");
  await expect(page.getByRole("button", { name: "Open sidebar" })).toHaveCount(0);
  await settings.getByRole("button", { exact: true, name: "Back to chat" }).click();
  await expect(settings).toHaveCount(0);
  await expect(page.getByTestId("composer-v2")).toBeVisible();
});
