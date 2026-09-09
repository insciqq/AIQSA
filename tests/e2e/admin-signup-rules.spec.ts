import { expect, test } from "@playwright/test";
import type { AdminDashboard } from "../../lib/contracts/admin";
import { authenticateWithLocalToken } from "./support/localAuth";
import { expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";

for (const theme of ["light", "dark"] as const) {
  test(`Sign-up rules has a direct People page and safe form at every viewport (${theme})`, async ({ page }) => {
    await authenticateWithLocalToken(page.request);
    await page.emulateMedia({ colorScheme: theme });
    const response = await page.request.get("/api/admin");
    expect(response.ok()).toBe(true);
    const dashboard = await response.json() as AdminDashboard;
    dashboard.accessRules = Array.from({ length: 12 }, (_, index) => ({
      id: `synthetic-rule-${index}`, kind: "domain", enabled: index !== 0,
      value: `${"long-domain-label-".repeat(5)}${index}.example.com`,
      defaultGroups: [{ groupId: "synthetic-group", name: "Research and development with a long group name", role: "member" }]
    }));
    await page.route("**/api/admin", (route) => route.fulfill({ json: dashboard }));
    let mutations = 0;
    await page.route("**/api/admin/action", async (route) => {
      mutations += 1;
      await route.fulfill({ status: 409, json: { error: "access_rule_exists" } });
    });
    await page.goto("/admin?section=access-rules&resource=old-user&filter=pending");
    const section = page.getByTestId("admin-section-access-rules");
    await expect(section).toBeVisible();
    await expect(page).toHaveURL(/section=access-rules$/);
    await expect(section.getByText(/Rule changes do not disable active accounts/)).toBeVisible();
    await expect(section.getByRole("list", { name: "Sign-up rules" })).toContainText("Disabled");

    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 900, height: 420 }]) {
      await page.setViewportSize(viewport);
      if (viewport.width < 1024) await page.getByRole("button", { name: "Sections", exact: true }).click();
      await expect(page.getByRole("link", { name: "Sign-up rules", exact: true })).toHaveAttribute("aria-current", "page");
      if (viewport.width < 1024) await page.keyboard.press("Escape");
      const add = page.getByRole("button", { name: "Add rule", exact: true });
      await expectWithinViewport(page, add);
      await expectNoHorizontalOverflow(page);
      await add.click();
      const dialog = page.getByRole("dialog", { name: "Add sign-up rule" });
      await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeFocused();
      await expectWithinViewport(page, dialog);
      await expectWithinViewport(page, dialog.getByRole("button", { name: "Add rule", exact: true }));
      await dialog.getByLabel("Kind").selectOption("domain");
      await dialog.getByLabel("Value").fill(" @Example.COM ");
      await expect(dialog.getByTestId("admin-signup-rule-preview")).toContainText("example.com");
      await dialog.getByRole("button", { name: "Add rule", exact: true }).click();
      await expect(dialog.getByRole("alert")).toBeVisible();
      await expect(dialog.getByLabel("Value")).toHaveValue(" @Example.COM ");
      await expect(dialog.getByLabel("Value")).toBeFocused();
      await page.keyboard.press("Escape");
      const discard = page.getByTestId("admin-signup-rules-discard");
      await expect(discard).toBeVisible();
      await expect(discard.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(discard).toHaveCount(0);
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel("Value")).toBeFocused();
      await page.keyboard.press("Escape");
      await discard.getByRole("button", { name: "Confirm discard changes" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(add).toBeFocused();
      await expectNoHorizontalOverflow(page);
    }
    expect(mutations).toBe(3);
    await page.reload();
    await expect(section).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("link", { name: "Users", exact: true }).click();
    await page.goBack();
    await expect(section).toBeVisible();
    await page.goForward();
    await expect(page.getByTestId("admin-section-users")).toBeVisible();
  });
}
