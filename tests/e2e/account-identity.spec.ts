import { expect, test, type Page } from "@playwright/test";
import { authenticateWithLocalToken } from "./support/localAuth";
import { expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";
import { runAccountMenuAction } from "./shell/page";

async function accountTrigger(page: Page) {
  const rail = page.getByRole("navigation", { name: "Workspace", exact: true });
  if (await rail.isVisible()) return rail.getByRole("button", { name: "Account menu" });
  const drawer = page.getByRole("complementary", { name: "Chat navigation", exact: true });
  if (!(await drawer.isVisible())) await page.getByRole("button", { name: "Open sidebar" }).click();
  return drawer.getByRole("button", { name: "Account menu" });
}

async function expectIdentity(page: Page, name: string, initials: string) {
  const trigger = await accountTrigger(page);
  await expect(trigger.locator(".v2-navigation-account-avatar")).toHaveText(initials);
  if (await trigger.getAttribute("data-tooltip")) {
    await expect(trigger).toHaveAttribute("data-tooltip", name);
  } else {
    await expect(trigger).toContainText(name);
  }
  await trigger.click();
  const identity = page.getByTestId("account-menu-identity");
  await expect(identity).toContainText(name);
  await expect(identity.locator(".v2-navigation-account-avatar")).toHaveText(initials);
  await expectWithinViewport(page, page.getByRole("menu", { name: "Account", exact: true }));
  return trigger;
}

test("saved account identity survives reload and updates immediately across navigation layouts", async ({ page }, info) => {
  test.setTimeout(180_000);
  await authenticateWithLocalToken(page.request);
  const original = (await (await page.request.get("/api/me")).json()).user;
  try {
    expect((await page.request.patch("/api/me", { data: { displayName: "Ada Lovelace" } })).ok()).toBe(true);
    await page.goto("/");
    await expect(page.getByTestId("app-shell")).toBeVisible();
    const initialTrigger = await expectIdentity(page, "Ada Lovelace", "AL");
    await page.getByRole("menu", { name: "Account", exact: true }).press("Escape");
    await expect(initialTrigger).toBeFocused();

    await runAccountMenuAction(page, "Settings");
    const settings = page.getByTestId("settings-v2");
    await settings.getByRole("button", { name: "Account", exact: true }).click();
    const name = settings.getByRole("textbox", { name: "Display name" });
    const backgroundAccount = page.getByRole("navigation", { name: "Workspace", exact: true, includeHidden: true })
      .getByRole("button", { name: "Account menu", includeHidden: true });
    await expect(name).toHaveValue("Ada Lovelace", { timeout: 15_000 });
    await name.fill("  Grace   Hopper  ");
    await expect(backgroundAccount).toHaveAttribute("data-tooltip", "Ada Lovelace");
    await name.press("Enter");
    await expect(name).toHaveValue("Grace Hopper");
    await expect(backgroundAccount).toHaveAttribute("data-tooltip", "Grace Hopper");
    await expect(settings.getByTestId("settings-account-identity")).toContainText(original.email);
    await page.screenshot({ path: info.outputPath("account-saved-desktop.png") });

    await name.fill("   ");
    await settings.getByRole("button", { name: "Save", exact: true }).click();
    await expect(settings.getByRole("alert")).toBeVisible();
    await expect(backgroundAccount).toHaveAttribute("data-tooltip", "Grace Hopper");
    await name.fill("Grace Hopper");
    await settings.getByRole("button", { name: "Close settings" }).click();

    for (const [width, height, colorScheme] of [
      [1440, 900, "light"], [768, 1024, "dark"], [1024, 768, "light"],
      [390, 844, "dark"], [844, 390, "light"]
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme });
      await page.reload();
      const trigger = await expectIdentity(page, "Grace Hopper", "GH");
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: info.outputPath(`account-menu-${width}x${height}-${colorScheme}.png`) });
      await page.getByRole("menu", { name: "Account", exact: true }).press("Escape");
      await expect(trigger).toBeFocused();
    }

    // A save through the narrow drawer uses the same committed shell identity.
    await page.setViewportSize({ width: 390, height: 844 });
    await runAccountMenuAction(page, "Settings");
    await settings.getByRole("button", { name: "Account", exact: true }).click();
    await expect(name).toHaveValue("Grace Hopper");
    await name.fill("Мария Склодовская");
    await settings.getByRole("button", { name: "Save", exact: true }).click();
    await expect(name).toHaveValue("Мария Склодовская");
    await expect(settings.getByText("Saved", { exact: true })).toBeVisible();
    await settings.getByRole("button", { name: "Close settings" }).click();
    await expectIdentity(page, "Мария Склодовская", "МС");
    await page.screenshot({ path: info.outputPath("account-saved-phone.png") });
  } finally {
    expect((await page.request.patch("/api/me", { data: { displayName: original.displayName } })).ok()).toBe(true);
  }
});

test("a nameless loaded profile uses the account email in navigation", async ({ page }) => {
  await authenticateWithLocalToken(page.request);
  await page.route("**/api/me", route => route.fulfill({ json: { user: {
    displayName: "", email: "operator@example.test", hasPassword: false, role: "user"
  } } }));
  await page.goto("/");
  await runAccountMenuAction(page, "Settings");
  const settings = page.getByTestId("settings-v2");
  await settings.getByRole("button", { name: "Account", exact: true }).click();
  await expect(settings.getByRole("textbox", { name: "Display name" })).toBeEnabled();
  await settings.getByRole("button", { name: "Close settings" }).click();
  // Email remains the authenticated shell email, not an identity copied from a form response.
  const profile = (await (await page.request.get("/api/me")).json()).user;
  const trigger = await accountTrigger(page);
  await expect(trigger).toHaveAttribute("data-tooltip", profile.email);
});
