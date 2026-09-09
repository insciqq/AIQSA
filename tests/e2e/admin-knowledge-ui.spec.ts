import { expect, test, type Page } from "@playwright/test";
import type { AdminDashboard } from "../../lib/contracts/admin";
import type { AdminKnowledgeSettings } from "../../lib/contracts/adminKnowledge";
import type { AdminModelPolicyCatalog } from "../../lib/contracts/adminModelPolicy";
import type { AdminSystemModelPolicyCatalog } from "../../lib/contracts/adminSystemModelPolicy";
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

test("Documents reasoning keeps the draft, confirmation and saved revision across responsive navigation", async ({ page }) => {
  const destination = { connectionDisplayName: "Synthetic document provider", defaultReasoningEffort: "high",
    deploymentId: "reader-1", directPdf: true, modelDisplayName: "Page reader", provider: "openai",
    reasoningEfforts: ["none", "low", "high"], upstreamModelId: "reader", vision: true };
  let settings = knowledgeSettings();
  const initial = { ...settings.profile.activeRevision!, pdfProcessing: { destination,
    mode: "system_model_vision" as const, parserProfileVersion: 19, reasoningEffort: null } };
  settings = { ...settings, profile: { ...settings.profile, activeRevision: initial,
    availablePdfDestinations: [destination], recentRevisions: [initial] } };
  const roles: AdminSystemModelPolicyCatalog = { candidates: [], documentCandidates: [], verificationCandidates: [],
    ineligible: { direct_pdf: [], memory: [], vision: [] }, rerankerCandidates: [], policy: {
      chatPdfModel: null, chatPdfReasoningEffort: null, reasoningEffort: null, rerankerModel: null,
      systemModel: null, updatedAt: "2026-09-09T00:00:00.000Z", updatedBy: null, version: 1
    } };
  const defaults: AdminModelPolicyCatalog = { candidates: [], policy: { defaultModel: null, reasoningEffort: null,
    maxMcpToolsPerDiscovery: 12, maxToolCalls: 24, maxToolRounds: 8, mcpAutoDiscoveryTimeoutSeconds: 20,
    mcpAutoDiscoveryMaxOutputTokens: 8192, updatedAt: "2026-09-09T00:00:00.000Z", updatedBy: null, version: 1 } };
  const mutations: Record<string, unknown>[] = [];
  await page.route("**/api/admin", async (route) => route.fulfill({ json: emptyAdminDashboard() }));
  await page.route("**/api/admin/release", async (route) => route.fulfill({ json: { state: "unavailable" } }));
  await page.route("**/api/admin/memory", async (route) => route.fulfill({ json: memoryResponse() }));
  await page.route("**/api/admin/providers/system-model-policy", async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({ json: { systemModelPolicy: roles } });
  });
  await page.route("**/api/admin/providers/model-policy", async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({ json: { modelPolicy: defaults } });
  });
  await page.route("**/api/admin/knowledge", async (route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      expect(body.expectedVersion).toBe(settings.profile.version);
      mutations.push(body);
      const activeRevision = body.action === "rollback_profile"
        ? settings.profile.recentRevisions.find((revision) => revision.id === body.revisionId)!
        : { ...settings.profile.activeRevision!, id: `revision-${settings.profile.version + 1}`,
            revisionNumber: settings.profile.version + 1, activatedAt: "2026-09-09T00:00:00.000Z",
            pdfProcessing: { ...settings.profile.activeRevision!.pdfProcessing,
              reasoningEffort: body.documentReasoningEffort as string | null } };
      settings = { ...settings, profile: { ...settings.profile, activeRevision,
        recentRevisions: [activeRevision, ...settings.profile.recentRevisions.filter((item) => item.id !== activeRevision.id)],
        version: settings.profile.version + 1 } };
    }
    await route.fulfill({ json: { knowledge: settings } });
  });
  await signInWithLocalToken(page);
  const openReasoning = async () => {
    const documents = page.getByTestId("admin-role-documents");
    const advanced = documents.getByText("Advanced", { exact: true });
    await advanced.focus();
    await advanced.press("Enter");
    return documents.getByRole("combobox", { name: "Documents reasoning" });
  };
  await page.goto("/admin?section=roles");
  let reasoning = await openReasoning();
  await expect(reasoning).toHaveValue("");
  await reasoning.focus();
  await reasoning.press("ArrowDown");
  await reasoning.press("Enter");
  await expect(reasoning).toHaveValue("none");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  const confirmation = page.getByTestId("admin-knowledge-apply-confirmation");
  await expect(confirmation).toBeVisible();
  expect(mutations).toEqual([]);
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(reasoning).toHaveValue("none");
  await page.getByTestId("admin-role-knowledge").getByRole("button", { name: "Discard", exact: true }).click();
  await expect(reasoning).toHaveValue("");
  await reasoning.selectOption("low");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await confirmation.getByRole("button", { name: "Confirm apply", exact: true }).click();
  await expect(page.getByRole("button", { name: "Apply", exact: true })).toHaveCount(0);
  expect(mutations).toEqual([expect.objectContaining({ action: "activate_profile",
    documentDeploymentId: "reader-1", documentReasoningEffort: "low", pdfProcessingMode: "system_model_vision" })]);

  for (const theme of ["light", "dark"] as const) {
    await page.setViewportSize(theme === "light" ? { width: 1440, height: 900 } : { width: 390, height: 620 });
    await page.goto("/admin?section=retrieval");
    await page.goto("/admin?section=roles");
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
    reasoning = await openReasoning();
    await expect(reasoning).toHaveValue("low");
    await reasoning.scrollIntoViewIfNeeded();
    await expectWithinViewport(page, reasoning);
    await expectNoHorizontalOverflow(page);
  }
  await page.reload();
  reasoning = await openReasoning();
  await expect(reasoning).toHaveValue("low");
  await page.getByRole("button", { name: "Knowledge processing actions" }).click();
  await page.getByRole("menuitem", { name: "Earlier configurations" }).click();
  const earlier = page.getByRole("dialog", { name: "Earlier configurations" });
  await expect(earlier).toContainText("Reasoning: Default");
  await earlier.getByRole("button", { name: /^Restore configuration applied/ }).click();
  await page.getByTestId("admin-knowledge-restore-confirmation").getByRole("button", { name: "Confirm restore", exact: true }).click();
  await expect(earlier).toHaveCount(0);
  await expect(reasoning).toHaveValue("");
  expect(mutations.at(-1)).toMatchObject({ action: "rollback_profile", revisionId: initial.id });
});
