import { expect, test } from "@playwright/test";
import type { AdminDashboard } from "../../lib/contracts/admin";
import type { AdminMemoryStatusResponse } from "../../lib/contracts/adminMemory";
import { adminMemoryProcessingCopy } from "../../lib/domain/adminMemoryProcessing";
import { adminKnowledgeSettingsFixture } from "../support/knowledgeProfile";
import {
  expectNoHorizontalOverflow,
  expectTouchSafe
} from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

test.use({ hasTouch: true });

test("Overview observes blocked learning and recovery in the background, retains stale issues and agrees with Memory", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 560 });
  await page.emulateMedia({ colorScheme: "dark" });
  const issue = { stage: "LEARNING", reason: "CAPABILITY_UNAVAILABLE", severity: "bad", count: 3, oldestAgeSeconds: 1865 } as const;
  let blocked = false;
  let unavailable = false;
  let reads = 0;
  const status = (): AdminMemoryStatusResponse => ({ memory: {
    ...memoryResponse({ rebuilding: false, timeoutSeconds: 30, timeoutVersion: 1 }).memory,
    index: { generation: 1, readiness: "READY" }, rebuild: { state: "NOT_REQUIRED" },
    processing: { enabled: true, issues: blocked ? [issue] : [] },
    queue: { length: blocked ? 3 : 0, oldestAgeSeconds: blocked ? 1865 : null }
  } });
  await page.route("**/api/admin", (route) => route.fulfill({ json: emptyAdminDashboard() }));
  await page.route("**/api/admin/knowledge", (route) => route.fulfill({ json: { knowledge: adminKnowledgeSettingsFixture() } }));
  await page.route("**/api/admin/memory", (route) => route.fulfill({ json: status() }));
  await page.route("**/api/admin/attention", (route) => {
    reads += 1;
    const copy = adminMemoryProcessingCopy(issue);
    return route.fulfill({ json: { attention: {
      checkedAt: new Date().toISOString(), unavailable: unavailable ? ["memory"] : [],
      items: blocked && !unavailable ? [{ action: copy.action, code: "memory_processing_blocked",
        count: 3, detail: copy.detail, id: "memory_processing_blocked:LEARNING", severity: "bad",
        target: { section: "roles", resource: "memory" }, title: copy.title }] : []
    } } });
  });
  await signInWithLocalToken(page);
  await page.clock.install();
  await page.goto("/admin?section=overview");
  await expect(page.getByText("No issues found in the latest checks.")).toBeVisible();
  blocked = true;
  await page.clock.fastForward(25_000);
  const row = page.getByTestId("admin-attention-item");
  await expect(row).toContainText("Memory is not learning new facts");
  await expect(row).toContainText("3 affected jobs; oldest 31m");
  await expect(row.getByTestId("admin-attention-status")).toHaveAttribute("data-severity", "bad");
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("memory-overview-blocked-dark.png") });
  await row.getByRole("button", { name: /Open Defaults & roles/ }).click();
  await expect(page).toHaveURL(/section=roles/u);
  const pausedReads = reads;
  await page.clock.fastForward(50_000);
  expect(reads).toBe(pausedReads);
  await page.goto("/admin?section=retrieval");
  const memory = page.getByTestId("admin-retrieval-memory");
  await expect(memory.getByTestId("memory-state")).toHaveText("Processing blocked");
  await expect(memory).toContainText("3 affected jobs; oldest 31m");
  await expect(memory.getByText("Ready", { exact: true })).toBeVisible();
  await memory.getByRole("link", { name: "Open Defaults & roles" }).click();
  await expect(page).toHaveURL(/section=roles/u);
  await page.goto("/admin?section=overview");
  await expect(row).toBeVisible();
  unavailable = true;
  await page.clock.fastForward(25_000);
  await expect(row).toContainText("last confirmed");
  await expect(page.getByText(/Could not check Memory/)).toBeVisible();
  await expect(page.getByText("No issues found in the latest checks.")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "light" });
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("memory-overview-stale-mobile-light.png") });
  unavailable = false;
  blocked = false;
  await page.clock.fastForward(25_000);
  await expect(row).toHaveCount(0);
  await expect(page.getByText("No issues found in the latest checks.")).toBeVisible();
});

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

function memoryResponse(input: Readonly<{
  rebuilding: boolean;
  timeoutSeconds: number;
  timeoutVersion: number;
}>): AdminMemoryStatusResponse {
  return {
    memory: {
      configuredTargets: [
        { model: "System model", provider: "Primary provider" },
        { model: "Embedding model", provider: "Vector provider" }
      ],
      index: {
        generation: input.rebuilding ? 5 : 4,
        readiness: input.rebuilding ? "REBUILDING" : "REBUILD_REQUIRED"
      },
      admissionTimeout: {
        seconds: input.timeoutSeconds,
        version: input.timeoutVersion
      },
      processing: { enabled: true, issues: [] },
      queue: {
        length: input.rebuilding ? 1 : 0,
        oldestAgeSeconds: input.rebuilding ? 0 : null
      },
      rebuild: { state: input.rebuilding ? "IN_PROGRESS" : "AVAILABLE" },
      worker: { state: "RUNNING" }
    }
  };
}

test("administrator sees minimal Memory runtime status and starts a bounded rebuild after confirming", async ({ page }) => {
  let rebuilding = false;
  let timeoutSeconds = 15;
  let timeoutVersion = 4;
  const rebuildBodies: unknown[] = [];
  const timeoutBodies: unknown[] = [];
  await page.route("**/api/admin", async (route) => {
    await route.fulfill({ contentType: "application/json", json: emptyAdminDashboard() });
  });
  await page.route("**/api/admin/release", async (route) => {
    await route.fulfill({ contentType: "application/json", json: { state: "unavailable" } });
  });
  await page.route("**/api/admin/knowledge", async (route) => {
    await route.fulfill({ contentType: "application/json", json: { knowledge: adminKnowledgeSettingsFixture() } });
  });
  await page.route("**/api/admin/memory", async (route) => {
    if (route.request().method() === "POST") {
      rebuildBodies.push(route.request().postDataJSON());
      rebuilding = true;
    } else if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as Readonly<{
        expectedVersion: number;
        timeoutSeconds: number;
      }>;
      timeoutBodies.push(body);
      timeoutSeconds = body.timeoutSeconds;
      timeoutVersion += 1;
    }
    await route.fulfill({
      contentType: "application/json",
      json: memoryResponse({ rebuilding, timeoutSeconds, timeoutVersion })
    });
  });

  await signInWithLocalToken(page);
  // The retired `memory` section id still lands on Knowledge & Memory.
  await page.goto("/admin?section=memory");
  await expect(page).toHaveURL(/section=retrieval/u);

  const section = page.getByTestId("admin-retrieval-memory");
  await expect(section.getByRole("heading", { name: "Memory" })).toBeVisible();
  await expect(section.getByTestId("memory-state")).toHaveText("Rebuild required");
  const configuredTargets = section.getByRole("list", { name: "Models in use" });
  await expect(configuredTargets.getByRole("listitem")
    .filter({ hasText: "System model · Primary provider" })).toBeVisible();
  await expect(configuredTargets.getByRole("listitem")
    .filter({ hasText: "Embedding model · Vector provider" })).toBeVisible();
  await expect(section.getByText("Running", { exact: true })).toBeVisible();
  await expect(section.getByText("None", { exact: true })).toBeVisible();
  await expect(section.getByText(/fingerprint|policy revision|destination matrix|Generation|System Models/iu)).toHaveCount(0);

  const timeout = section.getByRole("spinbutton", { name: "Admission timeout (seconds)" });
  await expect(timeout).toHaveValue("15");
  await timeout.fill("30");
  await section.getByRole("button", { name: "Save" }).click();
  await expect(timeout).toHaveValue("30");
  await expect(page.getByTestId("admin-feedback")).toContainText(/timeout saved.*New messages/u);
  expect(timeoutBodies).toEqual([{ expectedVersion: 4, timeoutSeconds: 30 }]);

  const rebuild = section.getByRole("button", { name: "Rebuild" });
  await expectTouchSafe(rebuild);
  await rebuild.click();
  // Rebuilding is expensive work: it asks first and does nothing until confirmed.
  const confirmation = page.getByTestId("admin-memory-rebuild-confirmation");
  await expect(confirmation.getByRole("heading", { name: "Rebuild the Memory index?" })).toBeVisible();
  expect(rebuildBodies).toEqual([]);
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  await expect(confirmation).toHaveCount(0);
  expect(rebuildBodies).toEqual([]);
  await rebuild.click();
  await page.getByTestId("admin-memory-rebuild-confirmation").getByRole("button", { name: "Rebuild" }).click();

  await expect(page.getByTestId("admin-feedback")).toContainText(/bounded Memory index rebuild was queued/u);
  await expect(section.getByText(/rebuild is in progress/u)).toBeVisible();
  await expect(section.getByTestId("memory-state")).toHaveText("Rebuilding");
  await expect(rebuild).toHaveCount(0);
  expect(rebuildBodies).toEqual([{ action: "REBUILD_REQUIRED" }]);
  await expectNoHorizontalOverflow(page);

  await page.setViewportSize({ height: 844, width: 390 });
  await expect(section).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.setViewportSize({ height: 390, width: 844 });
  await expect(section).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
