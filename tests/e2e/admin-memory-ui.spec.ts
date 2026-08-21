import { expect, test } from "@playwright/test";
import type { AdminDashboard } from "../../lib/contracts/admin";
import type { AdminMemoryStatusResponse } from "../../lib/contracts/adminMemory";
import {
  expectNoHorizontalOverflow,
  expectTouchSafe
} from "./support/layoutAssertions";
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
      activeIssueCode: input.rebuilding ? "memory_provider_unavailable" : null,
      queue: {
        length: input.rebuilding ? 1 : 0,
        oldestAgeSeconds: input.rebuilding ? 0 : null
      },
      rebuild: { state: input.rebuilding ? "IN_PROGRESS" : "AVAILABLE" },
      worker: { state: "RUNNING" }
    }
  };
}

test("administrator sees minimal Memory runtime status and starts a bounded rebuild", async ({ page }) => {
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
  await page.goto("/admin?section=memory");

  const section = page.getByTestId("admin-section-memory");
  await expect(section.getByRole("heading", { name: "Memory status" })).toBeVisible();
  const configuredTargets = section.getByRole("list", {
    name: "Configured models and providers"
  });
  await expect(configuredTargets.getByRole("listitem")
    .filter({ hasText: "System model · Primary provider" })).toBeVisible();
  await expect(configuredTargets.getByRole("listitem")
    .filter({ hasText: "Embedding model · Vector provider" })).toBeVisible();
  await expect(section.getByText("Running", { exact: true })).toBeVisible();
  await expect(section.getByText("Generation 4 · Rebuild required")).toBeVisible();
  await expect(section.getByText("None", { exact: true })).toBeVisible();
  await expect(section.getByText(/fingerprint|policy revision|destination matrix/iu)).toHaveCount(0);
  const timeout = section.getByRole("spinbutton", {
    name: "Memory admission timeout (seconds)"
  });
  await expect(timeout).toHaveValue("15");
  await timeout.fill("30");
  await section.getByRole("button", { name: "Save timeout" }).click();
  await expect(timeout).toHaveValue("30");
  await expect(section.getByText(/timeout saved.*New messages/u)).toBeVisible();
  expect(timeoutBodies).toEqual([{ expectedVersion: 4, timeoutSeconds: 30 }]);

  const rebuild = section.getByRole("button", { name: "Rebuild index" });
  await expectTouchSafe(rebuild);
  await rebuild.click();

  await expect(section.getByText(/bounded Memory index rebuild was queued/u)).toBeVisible();
  await expect(section.getByText(/generation-safe rebuild is in progress/u)).toBeVisible();
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
