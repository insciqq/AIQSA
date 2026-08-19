import { expect, test, type Page } from "@playwright/test";
import type { AdminDashboard } from "../../lib/contracts/admin";
import type { AdminKnowledgeSettings } from "../../lib/contracts/adminKnowledge";
import {
  adminKnowledgeDestinationFixture,
  adminKnowledgeOperationsFixture,
  adminKnowledgeProfileFixture
} from "../support/knowledgeProfile";
import {
  expectNoHorizontalOverflow,
  expectWithinViewport
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

function knowledgeSettings(): AdminKnowledgeSettings {
  const alternateDestination = {
    ...adminKnowledgeDestinationFixture,
    connectionDisplayName: "Approved provider",
    deploymentId: "embedding-model-2",
    modelDisplayName: "Multilingual production"
  };
  return {
    ingestionLimits: {
      maxChunksPerDocument: 10_000,
      maxFileBytes: 25_000_000,
      maxNormalizedChars: 5_000_000,
      maxPages: 2_000
    },
    operations: adminKnowledgeOperationsFixture(),
    policy: {
      candidateLimit: 40,
      resultLimit: 8,
      scoreThreshold: 0.01,
      updatedAt: "2026-08-18T00:00:00.000Z",
      updatedBy: null,
      version: 1
    },
    profile: adminKnowledgeProfileFixture({
      availableDestinations: [adminKnowledgeDestinationFixture, alternateDestination]
    }),
    retrievalBounds: {
      candidateLimit: { max: 100, min: 1 },
      resultLimit: { max: 8, min: 1 },
      scoreThreshold: { max: 1, min: 0 }
    }
  };
}

async function openKnowledge(page: Page) {
  await signInWithLocalToken(page);
  await page.goto("/admin?section=knowledge");
  const section = page.getByTestId("admin-section-knowledge");
  await expect(section).toBeVisible();
  return section;
}

test("administrator activates a content-safe Knowledge processing route", async ({ page }) => {
  let settings = knowledgeSettings();
  const patchBodies: Array<Record<string, unknown>> = [];

  await page.route("**/api/admin", async (route) => {
    await route.fulfill({ contentType: "application/json", json: emptyAdminDashboard() });
  });
  await page.route("**/api/admin/knowledge", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({ contentType: "application/json", json: { knowledge: settings } });
      return;
    }
    if (request.method() === "PATCH") {
      const body = request.postDataJSON() as Record<string, unknown>;
      patchBodies.push(body);
      const destination = settings.profile.availableDestinations.find(
        ({ deploymentId }) => deploymentId === body.deploymentId
      );
      if (!destination || body.action !== "activate_profile") {
        await route.fulfill({
          contentType: "application/json",
          json: { error: "knowledge_profile_input_invalid" },
          status: 400
        });
        return;
      }
      const activeRevision = {
        activatedAt: "2026-08-18T01:00:00.000Z",
        destination,
        executionAuthority: "installation" as const,
        id: "profile-revision-2",
        revisionNumber: 2,
        visionDestination: null
      };
      settings = {
        ...settings,
        profile: {
          ...settings.profile,
          activeRevision,
          egress: {
            ...settings.profile.egress,
            destination: `${destination.connectionDisplayName} / ${destination.modelDisplayName}`
          },
          migration: {
            ...settings.profile.migration,
            activeProfileBases: 0,
            buildingProfileBases: settings.profile.migration.totalBases
          },
          recentRevisions: [activeRevision, ...settings.profile.recentRevisions],
          updatedAt: activeRevision.activatedAt,
          version: 2
        }
      };
      await route.fulfill({ contentType: "application/json", json: { knowledge: settings } });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      json: { error: "unexpected_admin_knowledge_e2e_request" },
      status: 405
    });
  });

  const section = await openKnowledge(page);
  await expectNoHorizontalOverflow(page);
  await expect(section.getByRole("heading", { name: "Knowledge processing" })).toBeVisible();
  const route = section.getByTestId("knowledge-profile-route");
  await expect(route).toContainText("Documents");
  await expect(route).toContainText("Parser & OCR");
  await expect(route).toContainText("Local embeddings / Multilingual embed");
  await expect(section).toContainText("bounded normalized document text");
  await expect(section).toContainText("never lists private bases, documents, filenames, passages, or retrieval evidence");
  await expect(section).not.toContainText("private-base-name");

  await section.getByRole("combobox", { name: /Embedding destination/u }).selectOption("embedding-model-2");
  const activate = section.getByRole("button", { name: "Activate for future processing" });
  await expect(activate).toBeEnabled();
  await activate.click();

  await expect(section.getByText(
    "Knowledge profile activated. Existing Bases are rebuilding safely in the background."
  )).toBeVisible();
  await expect(section.getByRole("status", { name: "Knowledge profile rollout" })).toContainText(
    "Current snapshots stay online"
  );
  await expect(route).toContainText("Approved provider / Multilingual production");
  expect(patchBodies).toEqual([{
    action: "activate_profile",
    deploymentId: "embedding-model-2",
    expectedVersion: 1,
    visionDeploymentId: null
  }]);

  await page.setViewportSize({ height: 844, width: 390 });
  await expectNoHorizontalOverflow(page);
  await expect(section.getByTestId("knowledge-profile-route")).toBeVisible();
  await expectWithinViewport(page, section.getByRole("button", { name: "Refresh" }));
});
