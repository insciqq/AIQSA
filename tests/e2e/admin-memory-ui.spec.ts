import { expect, test } from "@playwright/test";
import type { AdminDashboard } from "../../lib/contracts/admin";
import type { AdminMemoryEgressResponse } from "../../lib/contracts/adminMemory";
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

function memoryResponse(acknowledged: boolean): AdminMemoryEgressResponse {
  const fingerprint = "a".repeat(64);
  return {
    memoryEgress: {
      acceptedAt: acknowledged ? "2026-08-11T10:00:00.000Z" : null,
      acceptedBy: acknowledged ? { displayName: "Administrator", id: "admin-1" } : null,
      acceptedFingerprint: acknowledged ? fingerprint : null,
      acceptedPolicyVersion: acknowledged ? "memory-utility-egress-v1" : null,
      consentMode: "ADMIN",
      currentFingerprint: fingerprint,
      currentPolicyVersion: "memory-utility-egress-v1",
      destinations: [
        {
          destinations: ["Selected and bound for each accepted run"],
          id: "answer_provider",
          reviewRequired: false,
          state: "BOUND_PER_RUN"
        },
        {
          destinations: ["System connection / System model"],
          id: "system_model",
          reviewRequired: !acknowledged,
          state: "AVAILABLE"
        },
        {
          destinations: ["Embedding connection / Embedding model"],
          id: "embedding",
          reviewRequired: !acknowledged,
          state: "AVAILABLE"
        },
        {
          destinations: [],
          id: "remote_reranker",
          reviewRequired: false,
          state: "UNAVAILABLE"
        }
      ],
      reviewRequired: !acknowledged,
      version: acknowledged ? 2 : 1,
      waitingJobCount: acknowledged ? 0 : 2
    }
  };
}

test("administrator reviews and acknowledges exact Memory destinations", async ({ page }) => {
  let acknowledged = false;
  const bodies: unknown[] = [];
  await page.route("**/api/admin", async (route) => {
    await route.fulfill({ contentType: "application/json", json: emptyAdminDashboard() });
  });
  await page.route("**/api/admin/release", async (route) => {
    await route.fulfill({ contentType: "application/json", json: { state: "unavailable" } });
  });
  await page.route("**/api/admin/memory", async (route) => {
    if (route.request().method() === "PATCH") {
      bodies.push(route.request().postDataJSON());
      acknowledged = true;
    }
    await route.fulfill({ contentType: "application/json", json: memoryResponse(acknowledged) });
  });

  await signInWithLocalToken(page);
  await page.goto("/admin?section=memory");

  const section = page.getByTestId("admin-section-memory");
  await expect(section.getByRole("heading", { name: "Memory destinations" })).toBeVisible();
  const matrix = section.getByRole("list", { name: "Memory destination matrix" });
  await expect(matrix.getByText("Selected answer model", { exact: true })).toBeVisible();
  await expect(matrix.getByText("System Memory model", { exact: true })).toBeVisible();
  await expect(matrix.getByText("Embedding deployment", { exact: true })).toBeVisible();
  await expect(matrix.getByText("Remote reranker", { exact: true })).toBeVisible();
  await expect(section.getByText("Review required.")).toBeVisible();
  await expect(section.getByText("2", { exact: true })).toBeVisible();
  const acknowledge = section.getByRole("button", { name: "Acknowledge current destinations" });
  await expectTouchSafe(acknowledge);
  await acknowledge.click();

  await expect(section.getByText(/Waiting work will resume automatically/u)).toBeVisible();
  await expect(acknowledge).toHaveCount(0);
  expect(bodies).toEqual([{ currentFingerprint: "a".repeat(64), expectedVersion: 1 }]);
  await expectNoHorizontalOverflow(page);

  await page.setViewportSize({ height: 844, width: 390 });
  await expect(section).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
