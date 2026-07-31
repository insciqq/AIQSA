import { expect, test } from "@playwright/test";
import type { AdminDashboard } from "../../lib/contracts/admin";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

function emptyAdminDashboard(): AdminDashboard {
  return {
    accessRules: [],
    catalog: { models: [], providers: [], searchStrategies: [] },
    groups: [],
    invites: [],
    navigation: {
      advancedConfigured: false,
      attention: {
        activeUsersWithoutModelAccess: 0,
        openInvites: 0,
        pendingUsers: 0
      },
      teamConfigured: false
    },
    usage: {
      byGroup: [],
      byUser: [],
      totals: {
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        inputTokens: 0,
        lastUsedAt: null,
        outputTokens: 0,
        reasoningTokens: 0,
        runCount: 0,
        totalTokens: 0
      }
    },
    users: []
  };
}

test("shows administrators a bounded update notice at desktop and compact widths", async ({ page }) => {
  let releaseRequests = 0;
  await page.route("**/api/admin", async (route) => {
    await route.fulfill({ contentType: "application/json", json: emptyAdminDashboard() });
  });
  await page.route("**/api/admin/release", async (route) => {
    releaseRequests += 1;
    await route.fulfill({
      contentType: "application/json",
      json: {
        checkedAt: "2026-07-31T13:00:00.000Z",
        currentVersion: "0.1.12",
        latestVersion: "0.2.0",
        publishedAt: "2026-07-31T12:00:00.000Z",
        releaseUrl: "https://github.com/insciqq/AIQSA/releases/tag/v0.2.0",
        state: "update_available"
      }
    });
  });

  await signInWithLocalToken(page);
  await page.goto("/admin");

  const update = page.getByText("Update available · v0.2.0", { exact: true });
  await expect(update).toBeVisible();
  await expect.poll(() => releaseRequests).toBe(1);
  await update.click();
  const detail = page.getByTestId("admin-release-update-details");
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("Installed");
  await expect(detail).toContainText("v0.1.12");
  await expect(detail).toContainText("Latest");
  await expect(detail).toContainText("v0.2.0");
  await expect(detail.getByRole("link", { name: "View release notes" })).toHaveAttribute(
    "href",
    "https://github.com/insciqq/AIQSA/releases/tag/v0.2.0"
  );
  await expectNoHorizontalOverflow(page);

  await page.setViewportSize({ height: 844, width: 390 });
  await expect(update).toBeVisible();
  await expect(detail).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
