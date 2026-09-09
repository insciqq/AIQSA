import { expect, test } from "@playwright/test";
import type { WorkspaceOverviewRow, WorkspaceOverviewWire } from "../../lib/contracts/workspaceOverview";
import { authenticateWithLocalToken } from "./support/localAuth";
import { expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";

const observedAt = "2026-09-09T12:00:00.000Z";
const rows: WorkspaceOverviewRow[] = Array.from({ length: 22 }, (_, index) => ({
  context: index === 1 ? "project" : "personal",
  id: `ws-${(index + 1).toString(16).padStart(16, "0")}`,
  lastActiveAt: observedAt,
  state: index === 21 ? "stopped" : index % 2 ? "running" : "ready",
  user: index === 0 ? "LongSyntheticWorkspaceUser".repeat(5) : `Synthetic workspace user ${index + 1}`
}));

for (const theme of ["light", "dark"] as const) {
  test(`administrator sees safe Workspace counts, pages and stale states across viewports (${theme})`, async ({ page }) => {
    await authenticateWithLocalToken(page.request);
    await page.emulateMedia({ colorScheme: theme });
    await page.route("**/api/admin/workspace", async (route) => {
      if (route.request().method() === "PATCH") {
        await route.fulfill({ status: 409, json: { error: "workspace_policy_action_failed" } });
      } else await route.fulfill({ json: { workspace: {
        enabled: true, internetEnabled: true, runtime: { state: "ready", imageReady: true,
          virtualizationReady: true, runtimeVersion: "0.6.16", mcpVersion: "0.6.16" }, version: 1
      } } });
    });
    let mode: "fresh" | "stale" | "unavailable" | "empty" | "error" = "fresh";
    let releaseInitial!: () => void;
    const initialGate = new Promise<void>((resolve) => { releaseInitial = resolve; });
    await page.route("**/api/admin/workspace/overview?**", async (route) => {
      // React's development remount can issue another initial read after abort.
      await initialGate;
      if (mode === "error") {
        await route.fulfill({ status: 503, json: { error: "workspace_overview_unavailable" } });
        return;
      }
      const params = new URL(route.request().url()).searchParams;
      const filter = params.get("filter") === "all" ? "all" : "active";
      const selected = mode === "empty" ? [] : filter === "all" ? rows : rows.filter((row) => row.state !== "stopped");
      const currentPage = Math.min(Number(params.get("page") ?? 1), Math.max(1, Math.ceil(selected.length / 20)));
      const overview: WorkspaceOverviewWire = {
        activeCount: mode === "unavailable" ? null : mode === "empty" ? 0 : 21,
        filter, observedAt: mode === "unavailable" ? null : observedAt, page: currentPage, pageSize: 20,
        rows: selected.slice((currentPage - 1) * 20, currentPage * 20).map((row) => mode === "unavailable" ? { ...row, state: "unknown" } : row),
        state: mode === "empty" ? "fresh" : mode,
        stoppedCount: mode === "unavailable" ? null : mode === "empty" ? 0 : 1,
        totalCount: selected.length, transitioningCount: 0, unknownCount: mode === "unavailable" ? selected.length : 0,
        updatedAt: observedAt
      };
      await route.fulfill({ json: { overview } });
    });
    await page.goto("/admin?section=workspace");
    const activity = page.getByRole("region", { name: "Workspace activity" });
    await expect(activity.getByRole("status")).toContainText("Loading Workspace activity");
    await expect.poll(() => typeof releaseInitial === "function").toBe(true);
    releaseInitial();
    await expect(activity.getByText("21 active environments", { exact: true })).toBeVisible();
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 900, height: 420 }]) {
      await page.setViewportSize(viewport);
      const refresh = activity.getByRole("button", { name: "Refresh activity" });
      await refresh.scrollIntoViewIfNeeded();
      await expectWithinViewport(page, refresh);
      await expectNoHorizontalOverflow(page);
      await activity.getByRole("button", { name: "Next environments" }).click();
      await expect(activity.getByText("Page 2 of 2 · 21 environments")).toBeVisible();
      await expect(activity.getByText("Synthetic workspace user 21", { exact: true })).toBeVisible();
      await expect(activity.getByText("21 active environments", { exact: true })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await activity.getByRole("button", { name: "Previous environments" }).click();
      await expect(activity.getByText("Page 1 of 2 · 21 environments")).toBeVisible();
    }
    await page.getByRole("switch", { name: "Enable Workspace" }).click();
    await expect(page.getByText("Workspace policy could not be updated.", { exact: true })).toBeVisible();
    mode = "stale";
    await activity.getByRole("button", { name: "Refresh activity" }).click();
    await expect(activity.getByText("21 last known active environments", { exact: true })).toBeVisible();
    await expect(activity.getByText(/Activity is stale/)).toBeVisible();
    await expect(page.getByText("Workspace policy could not be updated.", { exact: true })).toBeVisible();
    mode = "unavailable";
    await activity.getByRole("button", { name: "Refresh activity" }).click();
    await expect(activity.getByText("Live environment count is unknown.")).toBeVisible();
    await expect(activity.getByText("No active environments.")).toHaveCount(0);
    mode = "empty";
    await activity.getByRole("button", { name: "Refresh activity" }).click();
    await expect(activity.getByText("No active environments.")).toBeVisible();
    mode = "error";
    await activity.getByRole("button", { name: "Refresh activity" }).click();
    await expect(activity.getByRole("alert")).toContainText("could not be refreshed");
    await expect(activity.getByText("No active environments.")).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  });
}
