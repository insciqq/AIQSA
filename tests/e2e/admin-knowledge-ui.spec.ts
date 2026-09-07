import { expect, test, type Page } from "@playwright/test";
import type { AdminDashboard } from "../../lib/contracts/admin";
import type { AdminKnowledgeSettings } from "../../lib/contracts/adminKnowledge";
import type { AdminMemoryStatusResponse } from "../../lib/contracts/adminMemory";
import {
  adminKnowledgeAnswerPolicyFixture,
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

function memoryResponse(): AdminMemoryStatusResponse {
  return {
    memory: {
      activeIssueCode: null,
      admissionTimeout: { seconds: 30, version: 1 },
      configuredTargets: [],
      index: { generation: 1, readiness: "READY" },
      queue: { length: 0, oldestAgeSeconds: null },
      rebuild: { state: "NOT_REQUIRED" },
      worker: { state: "RUNNING" }
    }
  };
}

function knowledgeSettings(): AdminKnowledgeSettings {
  return {
    answerPolicy: adminKnowledgeAnswerPolicyFixture(),
    ingestionLimits: {
      maxChunksPerDocument: 10_000,
      maxFileBytes: 25_000_000,
      maxNormalizedChars: 5_000_000,
      maxPages: 2_000
    },
    operations: adminKnowledgeOperationsFixture({
      alerts: [{ code: "knowledge_search_projection_backlog", severity: "warning" }],
      search: {
        backendState: "available",
        expectedProjections: 4,
        failedProjections: 0,
        pendingProjections: 1,
        readyProjections: 3,
        workerLastSeenAt: "2026-08-18T00:00:00.000Z",
        workerState: "healthy"
      }
    }),
    profile: adminKnowledgeProfileFixture({
      availableDestinations: [adminKnowledgeDestinationFixture]
    }),
    retrieval: {
      candidateLimit: 40,
      resultLimit: 16
    }
  };
}

async function openKnowledgeAndMemory(page: Page) {
  await signInWithLocalToken(page);
  // The retired `knowledge` section id still lands on Knowledge & Memory.
  await page.goto("/admin?section=knowledge");
  const section = page.getByTestId("admin-section-retrieval");
  await expect(section).toBeVisible();
  await expect(page).toHaveURL(/section=retrieval/u);
  return section;
}

test("administrator reads Knowledge health and saves both limits with one Save", async ({ page }) => {
  let settings = knowledgeSettings();
  const patchBodies: Array<Record<string, unknown>> = [];

  await page.route("**/api/admin", async (route) => {
    await route.fulfill({ contentType: "application/json", json: emptyAdminDashboard() });
  });
  await page.route("**/api/admin/release", async (route) => {
    await route.fulfill({ contentType: "application/json", json: { state: "unavailable" } });
  });
  await page.route("**/api/admin/memory", async (route) => {
    await route.fulfill({ contentType: "application/json", json: memoryResponse() });
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
      if (body.expectedVersion !== settings.answerPolicy.version) {
        await route.fulfill({
          contentType: "application/json",
          json: { error: "knowledge_answer_policy_stale" },
          status: 409
        });
        return;
      }
      settings = {
        ...settings,
        answerPolicy: {
          ...settings.answerPolicy,
          ...(body.action === "update_answer_policy" && typeof body.maximumKnowledgeSearches === "number"
            ? { maximumKnowledgeSearches: body.maximumKnowledgeSearches }
            : {}),
          ...(body.action === "update_ingestion_parallelism" && typeof body.ingestionParallelism === "number"
            ? { ingestionParallelism: body.ingestionParallelism }
            : {}),
          updatedAt: "2026-08-18T01:30:00.000Z",
          version: settings.answerPolicy.version + 1
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

  const section = await openKnowledgeAndMemory(page);
  await expectNoHorizontalOverflow(page);
  const knowledge = section.getByTestId("admin-retrieval-knowledge");
  await expect(knowledge.getByRole("heading", { name: "Knowledge" })).toBeVisible();
  await expect(knowledge.getByTestId("knowledge-processing-state")).toHaveText("Ready");
  await expect(knowledge.getByTestId("knowledge-processing-line")).toContainText(
    "Documents: Local · no model · Embeddings: Local embeddings / Multilingual embed · 1024d"
  );
  await expect(knowledge.getByRole("list", { name: "Knowledge alerts" })).toContainText(
    "Knowledge search projections are waiting to be indexed."
  );
  await expect(knowledge.getByText("3 / 4")).toBeVisible();
  // The old route ribbon and the assignment mirror are gone; one link leads to Defaults & roles.
  await expect(knowledge.getByTestId("knowledge-profile-route")).toHaveCount(0);
  await expect(section.getByText(/Manage assignments in System Models|Normalized text|revision/u)).toHaveCount(0);
  await expect(section.getByTestId("admin-retrieval-memory").getByRole("heading", { name: "Memory" })).toBeVisible();

  const maximumSearches = knowledge.getByRole("spinbutton", { name: "Maximum Knowledge searches per answer" });
  const parallelism = knowledge.getByRole("spinbutton", { name: "Parallel document processing" });
  const save = knowledge.getByRole("button", { name: "Save" });
  await expect(maximumSearches).toHaveValue("12");
  await expect(parallelism).toHaveValue("8");
  await expect(save).toBeDisabled();
  await maximumSearches.fill("18");
  await parallelism.fill("16");
  await save.click();
  await expect(page.getByTestId("admin-feedback")).toContainText("Knowledge limits saved");
  await expect(maximumSearches).toHaveValue("18");
  await expect(parallelism).toHaveValue("16");
  await expect(save).toBeDisabled();
  expect(patchBodies).toEqual([
    { action: "update_answer_policy", expectedVersion: 1, maximumKnowledgeSearches: 18 },
    { action: "update_ingestion_parallelism", expectedVersion: 2, ingestionParallelism: 16 }
  ]);

  await knowledge.getByRole("button", { name: "Processing model and embeddings: Defaults & roles" }).click();
  await expect(page.getByTestId("admin-section-roles")).toBeVisible();
  await expect(page).toHaveURL(/section=roles/u);
  await page.goBack();
  await expect(page.getByTestId("admin-section-retrieval")).toBeVisible();

  await page.setViewportSize({ height: 844, width: 390 });
  await expectNoHorizontalOverflow(page);
  const link = page.getByRole("button", { name: "Processing model and embeddings: Defaults & roles" });
  await link.scrollIntoViewIfNeeded();
  await expectWithinViewport(page, link);
  const mobileSave = page.getByTestId("admin-retrieval-knowledge").getByRole("button", { name: "Save" });
  await mobileSave.scrollIntoViewIfNeeded();
  await expectWithinViewport(page, mobileSave);
});
