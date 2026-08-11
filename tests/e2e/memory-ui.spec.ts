import { expect, test, type BrowserContext, type Route } from "@playwright/test";
import { MEMORY_CONFIRMATION_COPY_VERSION } from "../../lib/contracts/memory";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { runAccountMenuAction } from "./shell/page";
import {
  expectNoHorizontalOverflow,
  expectTouchSafe,
  expectWithinViewport
} from "./support/layoutAssertions";
import { signInWithLocalToken as signIn } from "./support/localAuth";

type MemorySummaryFixture = {
  category: string;
  createdAt: string;
  currentVersionId: string | null;
  displayText: string | null;
  factState: "ACTIVE" | "FORGOTTEN";
  id: string;
  indexingState: "LEXICAL_READY";
  lastConfirmedAt: string | null;
  lastUsedAt: string | null;
  modality: "PREFERENCE" | "STATE" | "WORKFLOW";
  pinned: boolean;
  scope: { type: "GLOBAL_USER" };
  sensitivityClass: "NORMAL";
  sourceCount: number;
  sourceMode: "EXPLICIT";
  updatedAt: string;
  validFrom: null;
  validTo: null;
  versionState: "ACTIVE" | "FORGOTTEN";
};

const now = "2026-08-10T10:00:00.000Z";

function summary(
  id: string,
  displayText: string,
  overrides: Partial<MemorySummaryFixture> = {}
): MemorySummaryFixture {
  return {
    category: "preference",
    createdAt: now,
    currentVersionId: `${id}-version-1`,
    displayText,
    factState: "ACTIVE",
    id,
    indexingState: "LEXICAL_READY",
    lastConfirmedAt: now,
    lastUsedAt: null,
    modality: "PREFERENCE",
    pinned: false,
    scope: { type: "GLOBAL_USER" },
    sensitivityClass: "NORMAL",
    sourceCount: 1,
    sourceMode: "EXPLICIT",
    updatedAt: now,
    validFrom: null,
    validTo: null,
    versionState: "ACTIVE",
    ...overrides
  };
}

async function installMemoryFixture(
  context: BrowserContext,
  options: Readonly<{
    consentMode?: "ADMIN" | "PER_USER";
    defaultsOn?: boolean;
    historyIndexing?: Readonly<{ completedChats: number; totalChats: number }>;
    operationsEnabled?: boolean;
  }> = {}
) {
  let settingsRevision = 12;
  let memoryRevision = 8;
  let memoryConsentRevision = 4;
  let locale: "EN" | "RU" = "RU";
  let useMemoryFacts = options.defaultsOn === true;
  let referenceChatHistory = options.defaultsOn === true;
  let learnAutomatically = false;
  let accepted = false;
  let versionOrdinal = 1;
  let memories = [summary("memory-existing", "Любимый цвет — зелёный.")];
  let deletionState: "BLOCKED_REQUIRES_ADMIN" | "PENDING" = "PENDING";
  let clearDeletionMayComplete = false;
  let clearDeletionState: "BLOCKED_REQUIRES_ADMIN" | "PENDING" | "SUCCEEDED" = "PENDING";
  let rebuildState: "CANCELLED" | "QUEUED" | "RUNNING" = "QUEUED";
  let rebuildOperation: "REBUILD_SEARCH_INDEX" | "REDREAM_EXISTING_CHATS" | "REEMBED" =
    "REBUILD_SEARCH_INDEX";
  const searchRequests: Array<{ body: Record<string, unknown>; url: string }> = [];
  const historySearchRequests: Array<{ body: Record<string, unknown>; url: string }> = [];
  const bulkDeletionRequests: Record<string, unknown>[] = [];
  const mutationAuthorizations: Record<string, unknown>[] = [];
  const rebuildRequests: Record<string, unknown>[] = [];
  const rebuildCancellations: string[] = [];

  function settingsResponse() {
    return {
      capabilities: {
        automaticLearning: options.operationsEnabled === true,
        explicitMemory: true,
        historyRecall: options.operationsEnabled === true,
        russianQualified: true,
        temporaryChats: true
      },
      egress: {
        acceptedAt: accepted ? now : null,
        acceptedUtilityEgressFingerprint: accepted ? "current-memory-destination-fingerprint-0001" : null,
        acceptedUtilityPolicyVersion: accepted ? "memory-policy-v1" : null,
        consentMode: options.consentMode ?? "PER_USER",
        currentUtilityEgressFingerprint: "current-memory-destination-fingerprint-0001",
        currentUtilityPolicyVersion: "memory-policy-v1",
        embeddingDestination: "Local / multilingual-embed",
        remoteRerankerDestination: null,
        reviewRequired: (options.consentMode ?? "PER_USER") === "PER_USER" && !accepted,
        systemModelDestination: "Local / memory-extract"
      },
      historyIndexing: {
        completedChats: options.historyIndexing?.completedChats ?? 0,
        state: !referenceChatHistory
          ? "DISABLED"
          : (options.historyIndexing?.completedChats ?? 0) <
              (options.historyIndexing?.totalChats ?? 0)
            ? "INDEXING"
            : "READY",
        totalChats: options.historyIndexing?.totalChats ?? 0
      },
      settings: {
        embeddingDeployment: {
          connectionDisplayName: "Local",
          id: "embedding-model-1",
          modelDisplayName: "multilingual-embed"
        },
        learnAutomatically,
        memoryConsentRevision,
        memoryGeneration: 3,
        memoryRevision,
        memoryUiLocale: locale,
        preferredProfileLanguage: "AUTO",
        referenceChatHistory,
        sensitiveAutomaticPolicy: "EXPLICIT_ONLY",
        settingsRevision,
        updatedAt: now,
        useMemoryFacts
      }
    };
  }

  function evidence(memory: MemorySummaryFixture) {
    return {
      evidence: [{
        factVersionId: memory.currentVersionId,
        id: `${memory.id}-evidence-1`,
        observedAt: now,
        safeExcerpt: memory.displayText,
        safetyClass: "NORMAL",
        sourceChatId: null,
        sourceMessageId: null,
        sourceRole: null,
        sourceType: "EXPLICIT_ACTION",
        stance: "SUPPORTS"
      }],
      nextCursor: null
    };
  }

  async function handler(route: Route) {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const body = request.postData() ? request.postDataJSON() as Record<string, unknown> : {};

    if (path === "/api/me/memory/settings" && method === "GET") {
      await route.fulfill({ contentType: "application/json", json: settingsResponse() });
      return;
    }
    if (path === "/api/me/memory/settings" && method === "PATCH") {
      expect(body.expectedSettingsRevision).toBe(settingsRevision);
      if (body.memoryUiLocale === "EN" || body.memoryUiLocale === "RU") {
        expect(body).not.toHaveProperty("expectedMemoryRevision");
        locale = body.memoryUiLocale;
      } else if (typeof body.useMemoryFacts === "boolean") {
        expect(body.expectedMemoryRevision).toBe(memoryRevision);
        useMemoryFacts = body.useMemoryFacts;
        memoryRevision += 1;
      } else if (typeof body.referenceChatHistory === "boolean") {
        expect(body.expectedMemoryRevision).toBe(memoryRevision);
        referenceChatHistory = body.referenceChatHistory;
        memoryRevision += 1;
      } else if (typeof body.learnAutomatically === "boolean") {
        expect(body.expectedMemoryRevision).toBe(memoryRevision);
        learnAutomatically = body.learnAutomatically;
        memoryRevision += 1;
      } else {
        expect(body).toMatchObject({
          confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
          currentUtilityEgressFingerprint: "current-memory-destination-fingerprint-0001",
          expectedMemoryConsentRevision: memoryConsentRevision,
          expectedMemoryRevision: memoryRevision
        });
        accepted = true;
        memoryConsentRevision += 1;
      }
      settingsRevision += 1;
      await route.fulfill({ contentType: "application/json", json: settingsResponse() });
      return;
    }
    if (path === "/api/me/memory/mutation-authorizations" && method === "POST") {
      mutationAuthorizations.push(body);
      expect(body.confirmationCopyVersion).toBe(MEMORY_CONFIRMATION_COPY_VERSION);
      expect(body.requestNonce).toMatch(/^[a-f0-9]{48}$/u);
      await route.fulfill({
        contentType: "application/json",
        json: {
          expiresAt: "2026-08-10T10:05:00.000Z",
          mutationAuthorizationId: `authorization-${mutationAuthorizations.length}`
        },
        status: 201
      });
      return;
    }
    if (path === "/api/me/memory/history/search" && method === "POST") {
      historySearchRequests.push({ body, url: request.url() });
      expect(url.search).toBe("");
      if (String(body.query).includes("cancel")) {
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      await route.fulfill({
        contentType: "application/json",
        json: {
          indexing: {
            degradationCode: "memory_vector_unavailable",
            lexicalState: "READY",
            vectorState: "DEGRADED"
          },
          nextCursor: null,
          results: [{
            indexingState: "LEXICAL_READY",
            itemType: "EPISODE",
            occurredAt: "2026-08-09T08:00:00.000Z",
            sourceChatId: "chat-history-archived",
            sourceChatTitle: "Archived architecture source",
            sourceFolderId: null,
            sourceFolderName: null,
            sourceMessageIds: ["history-user", "history-assistant"],
            sourceState: "ARCHIVED",
            snippet: "Keep the local lexical index as the safe baseline for retained history."
          }]
        }
      }).catch(() => undefined);
      return;
    }
    if (path === "/api/me/memories/search" && method === "POST") {
      searchRequests.push({ body, url: request.url() });
      const query = String(body.query).toLocaleLowerCase("und");
      await route.fulfill({
        contentType: "application/json",
        json: {
          memories: memories.filter((memory) => memory.displayText?.toLocaleLowerCase("und").includes(query)),
          nextCursor: null
        }
      });
      return;
    }
    if (path === "/api/me/memories" && method === "GET") {
      await route.fulfill({ contentType: "application/json", json: { memories, nextCursor: null } });
      return;
    }
    if (path === "/api/me/memories" && method === "POST") {
      versionOrdinal += 1;
      const memory = summary(`memory-created-${versionOrdinal}`, String(body.statement), {
        category: typeof body.category === "string" ? body.category : "custom",
        currentVersionId: `memory-created-${versionOrdinal}-version-1`,
        modality: body.modality as MemorySummaryFixture["modality"]
      });
      memories = [memory, ...memories];
      memoryRevision += 1;
      await route.fulfill({ contentType: "application/json", json: { memory }, status: 201 });
      return;
    }
    const evidenceMatch = path.match(/^\/api\/me\/memories\/([^/]+)\/evidence$/u);
    if (evidenceMatch && method === "GET") {
      const memory = memories.find((candidate) => candidate.id === decodeURIComponent(evidenceMatch[1]!));
      await route.fulfill({ contentType: "application/json", json: memory ? evidence(memory) : { evidence: [], nextCursor: null } });
      return;
    }
    const forgetMatch = path.match(/^\/api\/me\/memories\/([^/]+)\/forget$/u);
    if (forgetMatch && method === "POST") {
      const id = decodeURIComponent(forgetMatch[1]!);
      const memory = memories.find((candidate) => candidate.id === id)!;
      memories = memories.filter((candidate) => candidate.id !== id);
      memoryRevision += 1;
      await route.fulfill({
        contentType: "application/json",
        json: {
          memory: {
            ...memory,
            currentVersionId: null,
            displayText: null,
            factState: "FORGOTTEN",
            versionState: "FORGOTTEN"
          }
        }
      });
      return;
    }
    const memoryMatch = path.match(/^\/api\/me\/memories\/([^/]+)$/u);
    if (memoryMatch && method === "GET") {
      const memory = memories.find((candidate) => candidate.id === decodeURIComponent(memoryMatch[1]!));
      await route.fulfill({
        contentType: "application/json",
        json: memory ? { memory } : { error: "memory_not_found" },
        status: memory ? 200 : 404
      });
      return;
    }
    if (memoryMatch && method === "PATCH") {
      const id = decodeURIComponent(memoryMatch[1]!);
      const current = memories.find((candidate) => candidate.id === id)!;
      versionOrdinal += 1;
      const next = {
        ...current,
        ...(typeof body.category === "string" ? { category: body.category } : {}),
        ...(typeof body.modality === "string" ? { modality: body.modality as MemorySummaryFixture["modality"] } : {}),
        ...(typeof body.pinned === "boolean" ? { pinned: body.pinned } : {}),
        ...(typeof body.statement === "string" ? { displayText: body.statement } : {}),
        currentVersionId: `${id}-version-${versionOrdinal}`,
        updatedAt: now
      };
      memories = memories.map((candidate) => candidate.id === id ? next : candidate);
      memoryRevision += 1;
      await route.fulfill({ contentType: "application/json", json: { memory: next } });
      return;
    }
    if (path === "/api/me/memory/bulk-delete" && method === "POST") {
      bulkDeletionRequests.push(body);
      if (body.operation === "CLEAR_HISTORY_INDEX") {
        expect(body).toMatchObject({
          expectedMemoryRevision: memoryRevision,
          expectedSettingsRevision: settingsRevision,
          mutationAuthorizationId: expect.stringMatching(/^authorization-/u),
          operation: "CLEAR_HISTORY_INDEX"
        });
        memoryRevision += 1;
        settingsRevision += 1;
        clearDeletionMayComplete = false;
        clearDeletionState = "PENDING";
        await route.fulfill({
          contentType: "application/json",
          json: {
            completedUnits: 0,
            deletionId: "memory-clear-e2e",
            lastAuditAt: null,
            memoryGeneration: 4,
            memoryRevision,
            operation: "CLEAR_HISTORY_INDEX",
            settingsRevision,
            state: clearDeletionState,
            totalUnits: 6,
            updatedAt: now
          },
          status: 202
        });
        return;
      }
      expect(body).toMatchObject({
        expectedMemoryRevision: memoryRevision,
        expectedSettingsRevision: settingsRevision,
        operation: "DELETE_EXPLICIT"
      });
      memories = [];
      memoryRevision += 1;
      settingsRevision += 1;
      deletionState = "PENDING";
      await route.fulfill({
        contentType: "application/json",
        json: {
          completedUnits: 0,
          deletionId: "memory-deletion-e2e",
          lastAuditAt: null,
          memoryGeneration: 4,
          memoryRevision,
          operation: "DELETE_EXPLICIT",
          settingsRevision,
          state: deletionState,
          totalUnits: 4,
          updatedAt: now
        },
        status: 202
      });
      return;
    }
    if (path === "/api/me/memory/deletions/memory-clear-e2e" && method === "GET") {
      clearDeletionState = clearDeletionMayComplete ? "SUCCEEDED" : "BLOCKED_REQUIRES_ADMIN";
      await route.fulfill({
        contentType: "application/json",
        json: {
          completedUnits: clearDeletionState === "SUCCEEDED" ? 6 : 4,
          deletionId: "memory-clear-e2e",
          lastAuditAt: clearDeletionState === "SUCCEEDED" ? now : null,
          memoryGeneration: 4,
          memoryRevision,
          operation: "CLEAR_HISTORY_INDEX",
          settingsRevision,
          state: clearDeletionState,
          totalUnits: 6,
          updatedAt: now
        }
      });
      return;
    }
    if (path === "/api/me/memory/deletions/memory-deletion-e2e" && method === "GET") {
      deletionState = "BLOCKED_REQUIRES_ADMIN";
      await route.fulfill({
        contentType: "application/json",
        json: {
          completedUnits: 3,
          deletionId: "memory-deletion-e2e",
          lastAuditAt: null,
          memoryGeneration: 4,
          memoryRevision,
          operation: "DELETE_EXPLICIT",
          settingsRevision,
          state: deletionState,
          totalUnits: 4,
          updatedAt: now
        }
      });
      return;
    }
    if (path === "/api/me/memory/rebuild" && method === "POST") {
      expect(body).toMatchObject({
        expectedMemoryRevision: memoryRevision,
        expectedSettingsRevision: settingsRevision
      });
      rebuildRequests.push(body);
      rebuildOperation = body.operation as typeof rebuildOperation;
      rebuildState = "QUEUED";
      await route.fulfill({
        contentType: "application/json",
        json: {
          completedUnits: 0,
          createdAt: now,
          errorCode: null,
          jobId: "memory-rebuild-e2e",
          operation: rebuildOperation,
          state: rebuildState,
          totalUnits: null,
          updatedAt: now
        },
        status: 202
      });
      return;
    }
    if (path === "/api/me/memory/rebuild/memory-rebuild-e2e" && method === "GET") {
      if (rebuildState !== "CANCELLED") rebuildState = "RUNNING";
      await route.fulfill({
        contentType: "application/json",
        json: {
          completedUnits: rebuildState === "RUNNING" ? 3 : 0,
          createdAt: now,
          errorCode: null,
          jobId: "memory-rebuild-e2e",
          operation: rebuildOperation,
          state: rebuildState,
          totalUnits: 10,
          updatedAt: now
        }
      });
      return;
    }
    if (path === "/api/me/memory/rebuild/memory-rebuild-e2e/cancel" && method === "POST") {
      rebuildCancellations.push(path);
      rebuildState = "CANCELLED";
      await route.fulfill({
        contentType: "application/json",
        json: {
          completedUnits: 3,
          createdAt: now,
          errorCode: null,
          jobId: "memory-rebuild-e2e",
          operation: rebuildOperation,
          state: rebuildState,
          totalUnits: 10,
          updatedAt: now
        }
      });
      return;
    }

    await route.fulfill({
      contentType: "application/json",
      json: { error: "unexpected_memory_e2e_request" },
      status: 400
    });
  }

  await context.route(/\/api\/me\/memor(?:y|ies)(?:\/|\?|$)/u, handler);
  await context.route("**/api/chats/chat-history-archived/source", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        source: {
          chatId: "chat-history-archived",
          location: "ARCHIVED_PREVIEW",
          memoryMode: "NORMAL",
          sourceRevision: 3,
          updatedAt: now
        }
      }
    });
  });
  await context.route("**/api/chats/chat-history-archived/archive", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        chat: {
          activeLeafMessageId: "history-assistant",
          archived: true,
          contextStats: { approximateActiveBranchInputTokens: 18 },
          createdAt: now,
          defaultKnowledgePlan: null,
          defaultModelId: "gpt-5.5",
          defaultProvider: "openai",
          folderId: null,
          id: "chat-history-archived",
          memoryMode: "NORMAL",
          messageCount: 2,
          messages: [{
            artifactSummary: null,
            content: { blocks: [{ text: "Which history index is the safe baseline?", type: "text" }] },
            createdAt: now,
            errorMessage: null,
            id: "history-user",
            modelId: null,
            modelRunId: null,
            parentMessageId: null,
            provider: null,
            role: "user",
            status: "complete"
          }, {
            artifactSummary: null,
            content: { blocks: [{ text: "Keep the local lexical index as the safe baseline.", type: "text" }] },
            createdAt: now,
            errorMessage: null,
            id: "history-assistant",
            modelId: "gpt-5.5",
            modelRunId: "history-run",
            parentMessageId: "history-user",
            provider: "openai",
            role: "assistant",
            status: "complete"
          }],
          pageInfo: {
            activeLeafMessageId: "history-assistant",
            beforeCursor: null,
            hasOlder: false,
            snapshotUpdatedAt: now
          },
          pinned: false,
          sourceRevision: 3,
          title: "Archived architecture source",
          updatedAt: now,
          usageStats: null
        }
      }
    });
  });
  return {
    bulkDeletionRequests,
    completeClearDeletion() {
      clearDeletionMayComplete = true;
    },
    historySearchRequests,
    mutationAuthorizations,
    rebuildCancellations,
    rebuildRequests,
    searchRequests
  };
}

test("keeps manual Memory history search private, cancellable, reversible, and archive-safe", async ({ context, page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await installMatrixCatalogFixture(page);
  const fixture = await installMemoryFixture(context);
  await signIn(page);

  await runAccountMenuAction(page, "Settings");
  const settings = page.getByTestId("settings-dialog");
  await settings.getByRole("button", { name: "Memory" }).click();
  await settings.getByRole("radio", { name: "English" }).click();
  await settings.getByRole("switch", { name: "Reference chat history" }).click();
  await settings.getByRole("button", { name: "Manage Memories" }).click();
  const manager = settings.getByTestId("manage-memories");
  const entry = manager.getByRole("button", { name: "Search chat history" });
  await expectTouchSafe(entry);
  await entry.click();

  const history = settings.getByTestId("memory-history-search");
  await expect(history.getByRole("heading", { name: "Search chat history" })).toBeFocused();
  await expectWithinViewport(page, settings);
  await expectNoHorizontalOverflow(page);

  const query = history.getByLabel("History search");
  await query.fill("cancel this private query");
  await history.getByRole("button", { name: "Search history" }).click();
  await history.getByRole("button", { name: "Cancel search" }).click();
  await expect(history.getByText("Search cancelled. Your query and filters are still here.")).toBeVisible();
  await expect(query).toHaveValue("cancel this private query");

  await query.fill("architecture decision");
  await history.getByRole("button", { name: "Search history" }).click();
  await expect(history.getByText(/local lexical index as the safe baseline/u)).toBeVisible();
  await expect(history.getByText(/semantic matching is temporarily unavailable/u)).toBeVisible();
  expect(fixture.historySearchRequests.at(-1)?.url).not.toContain("architecture");
  expect(fixture.historySearchRequests.at(-1)?.body.query).toBe("architecture decision");

  await history.getByRole("button", { name: "Back to saved memories" }).click();
  await expect(manager.getByRole("button", { name: "Search chat history" })).toBeFocused();

  await page.setViewportSize({ height: 390, width: 844 });
  await manager.getByRole("button", { name: "Search chat history" }).click();
  await expect(history.getByText(/local lexical index as the safe baseline/u)).toBeVisible();
  await expectWithinViewport(page, settings);
  await expectNoHorizontalOverflow(page);
  await history.getByRole("button", { name: "Open archived preview" }).click();

  await expect(settings).toHaveCount(0);
  const archived = page.getByRole("dialog", { name: "Archived architecture source" });
  await expect(archived.getByText("Keep the local lexical index as the safe baseline.")).toBeVisible();
  await expect(archived.getByRole("list", { name: "Archived chat messages" })).toBeVisible();
  await expect(archived.getByRole("textbox")).toHaveCount(0);
  await expectWithinViewport(page, archived);
  await expectNoHorizontalOverflow(page);
});

test("keeps Memory history operations exact, recoverable, cancellable, and responsive", async ({ context, page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await installMatrixCatalogFixture(page);
  const fixture = await installMemoryFixture(context, { operationsEnabled: true });
  await signIn(page);

  await runAccountMenuAction(page, "Settings");
  let settings = page.getByTestId("settings-dialog");
  await settings.getByRole("button", { name: "Memory" }).click();
  await expect(settings.getByRole("button", { name: "Операции с историей" })).toBeVisible();
  await settings.getByRole("radio", { name: "English" }).click();
  await settings.getByRole("button", { name: "Accept current destinations" }).click();
  await settings.getByRole("switch", { name: "Reference chat history" }).click();

  const entry = settings.getByRole("button", { name: "History operations" });
  await expectTouchSafe(entry);
  await entry.click();
  let operations = settings.getByTestId("memory-operations");
  const operationsHeading = operations.getByRole("heading", { name: "History operations" });
  await expect(operationsHeading).toBeFocused();
  await expectWithinViewport(page, operationsHeading);
  await expect(operations.getByRole("button", { name: "Review action" })).toHaveCount(4);
  await expectWithinViewport(page, settings);
  await expectNoHorizontalOverflow(page);

  const rebuildRow = operations.getByRole("listitem").filter({
    hasText: "Build or rebuild search index"
  });
  await rebuildRow.getByRole("button", { name: "Review action" }).click();
  await expect(operations.getByRole("heading", { name: "Confirm history operation" })).toBeFocused();
  let confirmation = operations.getByRole("region", { name: "Confirm history operation" });
  await expect(confirmation.getByText(/current active index/u)).toBeVisible();
  await confirmation.getByRole("button", { name: "Confirm and start" }).click();
  await expect(operations.getByText("The shadow job is queued.")).toBeVisible();
  expect(fixture.rebuildRequests.at(-1)).toEqual({
    expectedMemoryRevision: 9,
    expectedSettingsRevision: 15,
    operation: "REBUILD_SEARCH_INDEX"
  });
  await expect(operations.getByText(/shadow operation is running/u)).toBeVisible();
  await operations.getByRole("button", { name: "Cancel shadow job" }).click();
  await expect(operations.getByText(/shadow operation was cancelled/u)).toBeVisible();
  expect(fixture.rebuildCancellations).toEqual([
    "/api/me/memory/rebuild/memory-rebuild-e2e/cancel"
  ]);
  await operations.getByRole("button", { name: "Dismiss completed status" }).click();

  await operations.getByRole("button", { name: "Review action" }).last().click();
  confirmation = operations.getByRole("region", { name: "Confirm history operation" });
  await expectWithinViewport(page, confirmation.getByRole("heading", { name: "Confirm history operation" }));
  await expect(confirmation.getByText(/immediate retrieval fence/u)).toBeVisible();
  await expect(confirmation.getByText(/Raw retained chats/u)).toBeVisible();
  await confirmation.getByRole("button", { name: "Confirm and start" }).click();
  await expect(operations.getByText(/Retrieval is fenced.*queued/u)).toBeVisible();
  expect(fixture.mutationAuthorizations.at(-1)).toMatchObject({
    action: "BULK_DELETE",
    expectedMemoryRevision: 9,
    expectedSettingsRevision: 15,
    operation: "CLEAR_HISTORY_INDEX"
  });
  expect(fixture.bulkDeletionRequests.at(-1)).toEqual({
    expectedMemoryRevision: 9,
    expectedSettingsRevision: 15,
    mutationAuthorizationId: "authorization-1",
    operation: "CLEAR_HISTORY_INDEX"
  });

  await page.reload();
  await runAccountMenuAction(page, "Settings");
  settings = page.getByTestId("settings-dialog");
  await settings.getByRole("button", { name: "Memory" }).click();
  await settings.getByRole("button", { name: "History operations" }).click();
  operations = settings.getByTestId("memory-operations");
  await expect(operations.getByText(/administrator attention is required/u)).toBeVisible();
  await expect(operations.getByText("4 / 6", { exact: false })).toBeVisible();
  await expect(operations.getByRole("button", { name: "Cancel shadow job" })).toHaveCount(0);

  fixture.completeClearDeletion();
  await page.setViewportSize({ height: 390, width: 844 });
  await operations.getByRole("button", { name: "Check status" }).click();
  await expect(operations.getByText(/passed the durable deletion audit/u)).toBeVisible();
  await expect(operations.getByText("6 / 6", { exact: false })).toBeVisible();
  await expect(
    operations.getByText("Last deletion audit").locator("..").getByText("Aug 10, 2026", { exact: false })
  ).toBeVisible();
  await expectWithinViewport(page, settings);
  await expectNoHorizontalOverflow(page);

  await operations.getByRole("button", { name: "Back to Memory settings" }).click();
  await expect(settings.getByRole("button", { name: "History operations" })).toBeFocused();
});

test("keeps RU/EN Memory settings, exact CRUD, and durable deletion usable across responsive sessions", async ({ context, page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await installMatrixCatalogFixture(page);
  const fixture = await installMemoryFixture(context);
  await signIn(page);

  await runAccountMenuAction(page, "Settings");
  let settings = page.getByTestId("settings-dialog");
  await settings.getByRole("button", { name: "Memory" }).click();
  await expect(settings.getByRole("heading", { exact: true, name: "Память" })).toBeVisible();
  await expect(settings.getByRole("switch", { name: "Использовать факты из памяти" })).toHaveAttribute("aria-checked", "false");
  await expect(settings.getByText("current-memory-destination-fingerprint-0001")).toBeVisible();
  await expectWithinViewport(page, settings);
  await expectNoHorizontalOverflow(page);

  await settings.getByRole("radio", { name: "English" }).click();
  await expect(settings.getByRole("heading", { exact: true, name: "Memory" })).toBeVisible();
  await settings.getByRole("button", { name: "Accept current destinations" }).click();
  await expect(settings.getByText("Current Memory destinations accepted.")).toBeVisible();

  const secondPage = await context.newPage();
  await installMatrixCatalogFixture(secondPage);
  await secondPage.goto("/");
  await runAccountMenuAction(secondPage, "Settings");
  const secondSettings = secondPage.getByTestId("settings-dialog");
  await secondSettings.getByRole("button", { name: "Memory" }).click();
  await expect(secondSettings.getByRole("heading", { exact: true, name: "Memory" })).toBeVisible();
  await secondPage.close();

  await settings.getByRole("button", { name: "Manage Memories" }).click();
  const manager = settings.getByTestId("manage-memories");
  await expect(manager.getByRole("heading", { exact: true, name: "Manage Memories" })).toBeVisible();
  await expectTouchSafe(manager.getByRole("button", { name: "New memory" }));
  await expectNoHorizontalOverflow(page);

  const search = manager.getByLabel("Search saved memories");
  await search.fill("зелёный");
  await manager.getByRole("button", { exact: true, name: "Search" }).click();
  await expect(manager.getByRole("button", { name: /Любимый цвет/u })).toBeVisible();
  expect(fixture.searchRequests).toHaveLength(1);
  expect(fixture.searchRequests[0]?.url).not.toContain(encodeURIComponent("зелёный"));
  expect(fixture.searchRequests[0]?.body.query).toBe("зелёный");
  await manager.getByRole("button", { name: "Clear search" }).click();

  await manager.getByRole("button", { name: "New memory" }).click();
  await expect(manager.getByLabel("Scope")).toHaveValue("GLOBAL_USER");
  await manager.getByLabel("Exact statement").fill("  Всегда начинай с краткого итога.  ");
  await manager.getByLabel("Category").fill("workflow");
  await manager.getByLabel("Kind").selectOption("WORKFLOW");
  await manager.getByRole("button", { name: "Save memory" }).click();
  await expect(manager.getByText(/Saved; memory use is off/u)).toBeVisible();
  await expect(manager.getByRole("heading", { name: "Memory detail" })).toBeVisible();
  expect(fixture.mutationAuthorizations.at(-1)).toMatchObject({ action: "SAVE" });

  await manager.getByRole("button", { name: "Pin" }).click();
  await expect(manager.getByRole("button", { name: "Unpin" })).toBeVisible();
  await manager.getByRole("button", { name: "Edit" }).click();
  await manager.getByLabel("Exact statement").fill("Always begin with a concise summary.");
  await manager.getByRole("button", { name: "Save changes" }).click();
  await expect(manager.getByTestId("memory-detail-pane").getByText(
    "Always begin with a concise summary.",
    { exact: true }
  )).toBeVisible();

  await manager.getByRole("button", { name: "Forget" }).click();
  await expect(manager.getByRole("heading", { name: "Forget this memory?" })).toBeVisible();
  await manager.getByRole("button", { name: "Forget this memory" }).click();
  await expect(manager.getByText(/Memory fenced from future use/u)).toBeVisible();
  expect(fixture.mutationAuthorizations.at(-1)).toMatchObject({ action: "FORGET" });

  await page.setViewportSize({ height: 390, width: 844 });
  await expectWithinViewport(page, settings);
  await expectNoHorizontalOverflow(page);
  await manager.getByRole("button", { name: "Delete all saved memories" }).click();
  await expect(manager.getByRole("heading", { name: "Delete all saved memories?" })).toBeVisible();
  await expect(manager.getByText(/Retained raw chats are not deleted/u)).toBeVisible();
  await manager.getByRole("button", { name: "Delete all saved memories" }).click();
  await expect(manager.getByRole("heading", { name: "Durable deletion progress" })).toBeVisible();
  await manager.getByRole("button", { name: "Check deletion status" }).click();
  await expect(manager.getByText(/physical deletion needs administrator attention/u)).toBeVisible();
  await expect(manager.getByText("3 / 4", { exact: false })).toBeVisible();
  await expect(manager.getByText("Любимый цвет — зелёный.")).toHaveCount(0);
  expect(fixture.mutationAuthorizations.at(-1)).toMatchObject({
    action: "BULK_DELETE",
    operation: "DELETE_EXPLICIT"
  });
  await expectNoHorizontalOverflow(page);
});

test("shows default-on Memory information without user consent in ADMIN mode", async ({ context, page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await installMatrixCatalogFixture(page);
  await installMemoryFixture(context, {
    consentMode: "ADMIN",
    defaultsOn: true,
    historyIndexing: { completedChats: 2, totalChats: 5 }
  });
  await signIn(page);

  await runAccountMenuAction(page, "Settings");
  const settings = page.getByTestId("settings-dialog");
  await settings.getByRole("button", { name: "Memory" }).click();

  await expect(settings.getByRole("heading", { exact: true, name: "Память" })).toBeVisible();
  await expect(settings.getByRole("switch", { name: "Использовать факты из памяти" }))
    .toHaveAttribute("aria-checked", "true");
  await expect(settings.getByRole("switch", { name: "Ссылаться на историю чатов" }))
    .toHaveAttribute("aria-checked", "true");
  await expect(settings.getByRole("heading", { name: "Как Память использует ваши данные" }))
    .toBeVisible();
  await expect(settings.getByText(/Временные чаты не используют Память/u)).toBeVisible();
  await expect(settings.getByText(/От вас ничего не требуется/u)).toBeVisible();
  await expect(settings.getByText("Индексируется 2 из 5 чатов")).toBeVisible();
  await expect(settings.getByRole("button", { name: /принять текущие назначения/i })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);

  await settings.getByRole("radio", { name: "English" }).click();
  await expect(settings.getByRole("heading", { name: "How Memory uses your data" })).toBeVisible();
  await expect(settings.getByText(/Temporary chats do not use Memory/u)).toBeVisible();
  await expect(settings.getByText(/No action is required from you/u)).toBeVisible();
  await expect(settings.getByText("Indexing 2 of 5 chats")).toBeVisible();
  await expect(settings.getByRole("button", { name: "Accept current destinations" })).toHaveCount(0);
  await expectWithinViewport(page, settings);
  await expectNoHorizontalOverflow(page);
});
