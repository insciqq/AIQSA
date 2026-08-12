import { expect, test, type BrowserContext, type Route } from "@playwright/test";
import { MEMORY_CONFIRMATION_COPY_VERSION } from "../../lib/contracts/memory";
import type { UserMemoryHealth } from "../../lib/contracts/memoryHealth";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { runAccountMenuAction } from "./shell/page";
import {
  expectNoHorizontalOverflow,
  expectTouchSafe,
  expectWithinViewport
} from "./support/layoutAssertions";
import { signInWithLocalToken as signIn } from "./support/localAuth";

type MemorySummaryFixture = {
  actionVersionId: string | null;
  category: string;
  createdAt: string;
  currentVersionId: string | null;
  deferredCandidateCount: number;
  displayText: string | null;
  factState: "ACTIVE" | "CONFLICTED" | "FORGOTTEN";
  id: string;
  indexingState: "LEXICAL_READY" | "VECTOR_PENDING";
  lastConfirmedAt: string | null;
  lastUsedAt: string | null;
  modality: "PREFERENCE" | "STATE" | "WORKFLOW";
  pinned: boolean;
  scope: { type: "GLOBAL_USER" };
  sensitivityClass: "NORMAL";
  sourceCount: number;
  sourceMode: "AUTOMATIC" | "EXPLICIT";
  updatedAt: string;
  validFrom: null;
  validTo: null;
  versionState: "ACTIVE" | "CONFLICTING" | "FORGOTTEN";
};

const now = "2026-08-10T10:00:00.000Z";

function summary(
  id: string,
  displayText: string,
  overrides: Partial<MemorySummaryFixture> = {}
): MemorySummaryFixture {
  const versionId = `${id}-version-1`;
  return {
    actionVersionId: versionId,
    category: "preference",
    createdAt: now,
    currentVersionId: versionId,
    deferredCandidateCount: 0,
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

function detail(memory: MemorySummaryFixture) {
  const versionId = memory.currentVersionId ?? memory.actionVersionId;
  return {
    feedback: [],
    history: [],
    memory,
    versions: versionId ? [{
      category: memory.category,
      createdAt: memory.createdAt,
      displayText: memory.displayText,
      id: versionId,
      modality: memory.modality,
      sensitivityClass: memory.sensitivityClass,
      sourceCount: memory.sourceCount,
      sourceMode: memory.sourceMode,
      state: memory.versionState,
      systemFrom: memory.updatedAt,
      systemTo: null,
      validFrom: memory.validFrom,
      validTo: memory.validTo
    }] : []
  };
}

async function installMemoryFixture(
  context: BrowserContext,
  options: Readonly<{
    consentMode?: "ADMIN" | "PER_USER";
    defaultsOn?: boolean;
    historyIndexing?: Readonly<{ completedChats: number; totalChats: number }>;
    operationsEnabled?: boolean;
    permanentChatDeletion?: boolean;
    reviewScenario?: boolean;
    userHealth?: UserMemoryHealth;
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
  const automaticReviewMemory = summary(
    "memory-automatic-review",
    "I prefer concise answers with concrete evidence.",
    {
      deferredCandidateCount: 2,
      indexingState: "VECTOR_PENDING",
      sourceMode: "AUTOMATIC"
    }
  );
  const conflictedReviewMemory = summary(
    "memory-conflicted-review",
    "Keep answers concise.",
    {
      actionVersionId: "conflict-version-a",
      currentVersionId: null,
      factState: "CONFLICTED",
      sourceMode: "AUTOMATIC",
      versionState: "CONFLICTING"
    }
  );
  const conflictVersions = [
    {
      category: "preference",
      createdAt: "2026-08-10T09:00:00.000Z",
      displayText: "Keep answers concise.",
      id: "conflict-version-a",
      modality: "PREFERENCE" as const,
      sensitivityClass: "NORMAL" as const,
      sourceCount: 2,
      sourceMode: "AUTOMATIC" as const,
      state: "CONFLICTING" as const,
      systemFrom: "2026-08-10T09:00:00.000Z",
      systemTo: null,
      validFrom: null,
      validTo: null
    },
    {
      category: "preference",
      createdAt: "2026-08-10T09:05:00.000Z",
      displayText: "Use detailed explanations.",
      id: "conflict-version-b",
      modality: "PREFERENCE" as const,
      sensitivityClass: "NORMAL" as const,
      sourceCount: 1,
      sourceMode: "AUTOMATIC" as const,
      state: "CONFLICTING" as const,
      systemFrom: "2026-08-10T09:05:00.000Z",
      systemTo: null,
      validFrom: null,
      validTo: null
    }
  ];
  let reviewFeedback: Array<{
    comment: string | null;
    createdAt: string;
    feedbackType: "INCORRECT";
    id: string;
    retractedAt: string | null;
    targetVersionId: string;
  }> = [];
  let memories = options.reviewScenario
    ? [automaticReviewMemory, conflictedReviewMemory]
    : [summary("memory-existing", "Любимый цвет — зелёный.")];
  let deletionState: "BLOCKED_REQUIRES_ADMIN" | "PENDING" = "PENDING";
  let allDeletionMayComplete = false;
  let allDeletionState: "BLOCKED_REQUIRES_ADMIN" | "PENDING" | "SUCCEEDED" = "PENDING";
  let learnedDeletionMayComplete = false;
  let learnedDeletionState: "BLOCKED_REQUIRES_ADMIN" | "PENDING" | "SUCCEEDED" = "PENDING";
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
  const feedbackRequests: Record<string, unknown>[] = [];
  const conflictResolutionRequests: Record<string, unknown>[] = [];
  const forgetUndoRequests: Record<string, unknown>[] = [];
  const permanentChatDeletionAuthorizations: Record<string, unknown>[] = [];
  const permanentChatDeletionAdmissions: Record<string, unknown>[] = [];
  let forgottenMemory: ReturnType<typeof summary> | null = null;
  let permanentChatDeleted = false;

  function settingsResponse() {
    return {
      capabilities: {
        automaticLearning: options.operationsEnabled === true,
        explicitMemory: true,
        historyRecall: options.operationsEnabled === true,
        permanentChatDeletion: options.permanentChatDeletion === true,
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

  function healthResponse(): UserMemoryHealth {
    if (options.userHealth) return options.userHealth;
    const historyState = !referenceChatHistory
      ? "DISABLED" as const
      : (options.historyIndexing?.completedChats ?? 0) <
          (options.historyIndexing?.totalChats ?? 0)
        ? "INDEXING" as const
        : "READY" as const;
    const egressReview = (options.consentMode ?? "PER_USER") === "PER_USER" && !accepted
      ? "USER_REQUIRED" as const
      : "NONE" as const;
    return {
      action: egressReview === "USER_REQUIRED" ? "REVIEW_DESTINATIONS" : "NONE",
      deletion: {
        activeCount: 0,
        countTruncated: false,
        retrievalFenced: false,
        state: "CLEAR"
      },
      egressReview,
      indexing: {
        completedChats: options.historyIndexing?.completedChats ?? 0,
        countTruncated: false,
        state: historyState,
        totalChats: options.historyIndexing?.totalChats ?? 0
      },
      learning: learnAutomatically
        ? { reason: "NONE", resumeAt: null, state: "READY" }
        : { reason: "USER_DISABLED", resumeAt: null, state: "DISABLED" },
      observedAt: now,
      rebuild: { state: "IDLE" },
      state: historyState === "INDEXING" ? "INDEXING" : "UP_TO_DATE",
      temporary: { countTruncated: false, overdueCount: 0, state: "CLEAR" }
    };
  }

  function profileResponse() {
    if (!useMemoryFacts) {
      return { memoryRevision, profile: null, state: "DISABLED" };
    }
    const contributors = memories
      .filter((memory) =>
        memory.factState === "ACTIVE" &&
        memory.currentVersionId !== null &&
        memory.displayText !== null
      )
      .slice(0, 6)
      .map((memory, ordinal) => ({
        displayText: memory.displayText!,
        factId: memory.id,
        factVersionId: memory.currentVersionId!,
        ordinal,
        pinned: memory.pinned,
        sourceMode: memory.sourceMode,
        temperatureClass: ordinal === 0 ? "HOT" as const : "WARM" as const
      }));
    if (contributors.length === 0) {
      return { memoryRevision, profile: null, state: "EMPTY" };
    }
    return {
      memoryRevision,
      profile: {
        asOf: now,
        contributors,
        createdAt: now,
        id: `memory-profile-${memoryRevision}`,
        languageCode: locale.toLowerCase(),
        memoryRevision,
        redactionState: "NOT_NEEDED",
        summary: contributors.map(({ displayText }) => displayText).join("\n")
      },
      state: "READY"
    };
  }

  function evidence(memory: MemorySummaryFixture) {
    if (memory.id === automaticReviewMemory.id) {
      return {
        evidence: [{
          factVersionId: memory.currentVersionId,
          id: `${memory.id}-evidence-1`,
          observedAt: now,
          safeExcerpt: "I prefer concise answers with concrete evidence.",
          safetyClass: "NORMAL",
          sourceChatId: "chat-review-source",
          sourceMessageId: "message-review-source",
          sourceRole: "user",
          sourceType: "MESSAGE",
          stance: "SUPPORTS"
        }],
        nextCursor: null
      };
    }
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

  function detailResponse(memory: MemorySummaryFixture) {
    const response = detail(memory);
    if (memory.id === conflictedReviewMemory.id && memory.factState === "CONFLICTED") {
      return {
        ...response,
        history: [{
          actorType: "SYSTEM",
          createdAt: "2026-08-10T09:05:00.000Z",
          factVersionId: "conflict-version-b",
          id: "conflict-event-1",
          operation: "CONFLICT",
          sourceAvailable: true
        }],
        versions: conflictVersions
      };
    }
    if (memory.id === automaticReviewMemory.id) {
      return {
        ...response,
        feedback: reviewFeedback,
        history: [{
          actorType: "SYSTEM",
          createdAt: now,
          factVersionId: memory.currentVersionId,
          id: "automatic-promote-event-1",
          operation: "PROMOTE",
          sourceAvailable: true
        }]
      };
    }
    return response;
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
    if (path === "/api/me/memory/health" && method === "GET") {
      await route.fulfill({
        contentType: "application/json",
        headers: { "cache-control": "private, no-store, max-age=0", vary: "Cookie" },
        json: { health: healthResponse() }
      });
      return;
    }
    if (path === "/api/me/memory/profile" && method === "GET") {
      await route.fulfill({ contentType: "application/json", json: profileResponse() });
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
      const state = url.searchParams.get("state");
      await route.fulfill({
        contentType: "application/json",
        json: {
          memories: state
            ? memories.filter((memory) => memory.factState === state)
            : memories,
          nextCursor: null
        }
      });
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
    const feedbackMatch = path.match(/^\/api\/me\/memories\/([^/]+)\/feedback$/u);
    if (feedbackMatch && method === "POST") {
      const id = decodeURIComponent(feedbackMatch[1]!);
      const memory = memories.find((candidate) => candidate.id === id);
      expect(memory?.id).toBe(automaticReviewMemory.id);
      feedbackRequests.push(body);
      if (body.feedbackType === "RETRACT") {
        reviewFeedback = reviewFeedback.map((entry) => ({
          ...entry,
          retractedAt: "2026-08-10T10:01:00.000Z"
        }));
        await route.fulfill({
          contentType: "application/json",
          json: {
            createdAt: "2026-08-10T10:01:00.000Z",
            feedbackId: "feedback-review-retract-1",
            feedbackType: "RETRACT",
            retractedFeedbackId: "feedback-review-1",
            targetVersionId: automaticReviewMemory.currentVersionId
          },
          status: 201
        });
        return;
      }
      reviewFeedback = [{
        comment: typeof body.comment === "string" ? body.comment : null,
        createdAt: now,
        feedbackType: "INCORRECT",
        id: "feedback-review-1",
        retractedAt: null,
        targetVersionId: automaticReviewMemory.currentVersionId!
      }];
      await route.fulfill({
        contentType: "application/json",
        json: {
          createdAt: now,
          feedbackId: "feedback-review-1",
          feedbackType: "INCORRECT",
          retractedFeedbackId: null,
          targetVersionId: automaticReviewMemory.currentVersionId
        },
        status: 201
      });
      return;
    }
    const resolveMatch = path.match(/^\/api\/me\/memories\/([^/]+)\/resolve$/u);
    if (resolveMatch && method === "POST") {
      const id = decodeURIComponent(resolveMatch[1]!);
      expect(id).toBe(conflictedReviewMemory.id);
      conflictResolutionRequests.push(body);
      const resolution = body.resolution as { kind?: string; statement?: string };
      const resolved = summary(
        conflictedReviewMemory.id,
        resolution.statement ?? "Keep answers concise.",
        {
          actionVersionId: "conflict-resolution-version-1",
          currentVersionId: "conflict-resolution-version-1",
          sourceMode: "EXPLICIT"
        }
      );
      memories = memories.map((memory) => memory.id === id ? resolved : memory);
      await route.fulfill({
        contentType: "application/json",
        json: { memory: resolved }
      });
      return;
    }
    const forgetMatch = path.match(/^\/api\/me\/memories\/([^/]+)\/forget$/u);
    if (forgetMatch && method === "POST") {
      const id = decodeURIComponent(forgetMatch[1]!);
      const memory = memories.find((candidate) => candidate.id === id)!;
      forgottenMemory = memory;
      memories = memories.filter((candidate) => candidate.id !== id);
      memoryRevision += 1;
      await route.fulfill({
        contentType: "application/json",
        json: {
          memory: {
            ...memory,
            actionVersionId: null,
            currentVersionId: null,
            displayText: null,
            factState: "FORGOTTEN",
            versionState: "FORGOTTEN"
          },
          undo: {
            deletionId: `forget-deletion-${id}`,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            versionId: memory.currentVersionId
          }
        }
      });
      return;
    }
    const undoForgetMatch = path.match(/^\/api\/me\/memories\/([^/]+)\/undo-forget$/u);
    if (undoForgetMatch && method === "POST") {
      const id = decodeURIComponent(undoForgetMatch[1]!);
      expect(forgottenMemory?.id).toBe(id);
      forgetUndoRequests.push(body);
      versionOrdinal += 1;
      const restored = {
        ...forgottenMemory!,
        actionVersionId: `memory-version-${versionOrdinal}`,
        currentVersionId: `memory-version-${versionOrdinal}`,
        factState: "ACTIVE" as const,
        sourceMode: "EXPLICIT" as const,
        updatedAt: now,
        versionState: "ACTIVE" as const
      };
      memories = [restored, ...memories];
      forgottenMemory = null;
      memoryRevision += 1;
      await route.fulfill({
        contentType: "application/json",
        json: { memory: restored }
      });
      return;
    }
    const memoryMatch = path.match(/^\/api\/me\/memories\/([^/]+)$/u);
    if (memoryMatch && method === "GET") {
      const memory = memories.find((candidate) => candidate.id === decodeURIComponent(memoryMatch[1]!));
      await route.fulfill({
        contentType: "application/json",
        json: memory ? detailResponse(memory) : { error: "memory_not_found" },
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
        actionVersionId: `${id}-version-${versionOrdinal}`,
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
      if (body.operation === "DELETE_ALL_REUSABLE") {
        expect(body).toMatchObject({
          expectedMemoryRevision: memoryRevision,
          expectedSettingsRevision: settingsRevision,
          mutationAuthorizationId: expect.stringMatching(/^authorization-/u),
          operation: "DELETE_ALL_REUSABLE"
        });
        memories = [];
        useMemoryFacts = false;
        referenceChatHistory = false;
        learnAutomatically = false;
        memoryRevision += 1;
        settingsRevision += 1;
        allDeletionMayComplete = false;
        allDeletionState = "PENDING";
        await route.fulfill({
          contentType: "application/json",
          json: {
            completedUnits: 0,
            deletionId: "memory-all-reusable-e2e",
            lastAuditAt: null,
            memoryGeneration: 4,
            memoryRevision,
            operation: "DELETE_ALL_REUSABLE",
            settingsRevision,
            state: allDeletionState,
            totalUnits: 11,
            updatedAt: now
          },
          status: 202
        });
        return;
      }
      if (body.operation === "DELETE_LEARNED") {
        expect(body).toMatchObject({
          expectedMemoryRevision: memoryRevision,
          expectedSettingsRevision: settingsRevision,
          mutationAuthorizationId: expect.stringMatching(/^authorization-/u),
          operation: "DELETE_LEARNED"
        });
        memoryRevision += 1;
        settingsRevision += 1;
        learnedDeletionMayComplete = false;
        learnedDeletionState = "PENDING";
        await route.fulfill({
          contentType: "application/json",
          json: {
            completedUnits: 0,
            deletionId: "memory-learned-delete-e2e",
            lastAuditAt: null,
            memoryGeneration: 4,
            memoryRevision,
            operation: "DELETE_LEARNED",
            settingsRevision,
            state: learnedDeletionState,
            totalUnits: 7,
            updatedAt: now
          },
          status: 202
        });
        return;
      }
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
    if (path === "/api/me/memory/deletions/memory-all-reusable-e2e" && method === "GET") {
      allDeletionState = allDeletionMayComplete ? "SUCCEEDED" : "BLOCKED_REQUIRES_ADMIN";
      await route.fulfill({
        contentType: "application/json",
        json: {
          completedUnits: allDeletionState === "SUCCEEDED" ? 11 : 8,
          deletionId: "memory-all-reusable-e2e",
          lastAuditAt: allDeletionState === "SUCCEEDED" ? now : null,
          memoryGeneration: 4,
          memoryRevision,
          operation: "DELETE_ALL_REUSABLE",
          settingsRevision,
          state: allDeletionState,
          totalUnits: 11,
          updatedAt: now
        }
      });
      return;
    }
    if (path === "/api/me/memory/deletions/memory-learned-delete-e2e" && method === "GET") {
      learnedDeletionState = learnedDeletionMayComplete ? "SUCCEEDED" : "BLOCKED_REQUIRES_ADMIN";
      await route.fulfill({
        contentType: "application/json",
        json: {
          completedUnits: learnedDeletionState === "SUCCEEDED" ? 7 : 5,
          deletionId: "memory-learned-delete-e2e",
          lastAuditAt: learnedDeletionState === "SUCCEEDED" ? now : null,
          memoryGeneration: 4,
          memoryRevision,
          operation: "DELETE_LEARNED",
          settingsRevision,
          state: learnedDeletionState,
          totalUnits: 7,
          updatedAt: now
        }
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
  if (options.permanentChatDeletion) {
    await context.route("**/api/me/chats/chat-permanent/memory-mode", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        json: {
          chat: {
            archived: false,
            chatId: "chat-permanent",
            mode: "NORMAL",
            sourceRevision: 4,
            temporaryRetentionDeadline: null,
            temporaryRetentionPolicyVersion: null,
            updatedAt: now
          }
        }
      });
    });
    await context.route(
      "**/api/chats/chat-permanent/delete-permanently/authorization",
      async (route) => {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        permanentChatDeletionAuthorizations.push(body);
        if (permanentChatDeletionAuthorizations.length === 1) {
          await route.fulfill({
            contentType: "application/json",
            json: { error: "chat_permanent_delete_stale" },
            status: 409
          });
          return;
        }
        await route.fulfill({
          contentType: "application/json",
          json: {
            expiresAt: "2026-08-10T10:05:00.000Z",
            mutationAuthorizationId: "chat-delete-authorization-e2e"
          },
          status: 201
        });
      }
    );
    await context.route("**/api/chats/chat-permanent/delete-permanently", async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      permanentChatDeletionAdmissions.push(body);
      permanentChatDeleted = true;
      await route.fulfill({
        contentType: "application/json",
        json: {
          deletionId: "chat-permanent-deletion-e2e",
          fencedAt: now,
          state: "PENDING"
        },
        status: 202
      });
    });
    await context.route(
      "**/api/chats/chat-permanent/delete-permanently/status?*",
      async (route) => {
        await route.fulfill({
          contentType: "application/json",
          json: {
            attemptCount: 3,
            cleanupComplete: false,
            deletionId: "chat-permanent-deletion-e2e",
            errorCode: "memory_cleanup_residual",
            fencedAt: now,
            lastAuditAt: null,
            state: "BLOCKED_REQUIRES_ADMIN",
            updatedAt: now
          }
        });
      }
    );
  }
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
    conflictResolutionRequests,
    completeAllDeletion() {
      allDeletionMayComplete = true;
    },
    completeClearDeletion() {
      clearDeletionMayComplete = true;
    },
    completeLearnedDeletion() {
      learnedDeletionMayComplete = true;
    },
    historySearchRequests,
    feedbackRequests,
    forgetUndoRequests,
    mutationAuthorizations,
    permanentChatDeletionAdmissions,
    permanentChatDeletionAuthorizations,
    permanentChatDeleted() {
      return permanentChatDeleted;
    },
    rebuildCancellations,
    rebuildRequests,
    searchRequests
  };
}

test("keeps permanent chat deletion distinct, exact, recoverable, and responsive", async ({ context, page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  const chat = {
    activeLeafMessageId: "message-permanent",
    contextStats: { approximateActiveBranchInputTokens: 8 },
    createdAt: now,
    defaultKnowledgePlan: null,
    defaultModelId: "gpt-5.5",
    defaultProvider: "openai",
    folderId: null,
    id: "chat-permanent",
    messageCount: 1,
    messages: [{
      artifactSummary: null,
      content: { blocks: [{ text: "Private deletion source", type: "text" }] },
      createdAt: now,
      errorMessage: null,
      id: "message-permanent",
      modelId: null,
      modelRunId: null,
      parentMessageId: null,
      provider: null,
      role: "user",
      status: "complete"
    }],
    pageInfo: {
      activeLeafMessageId: "message-permanent",
      beforeCursor: null,
      hasOlder: false,
      snapshotUpdatedAt: now
    },
    pinned: false,
    title: "Deletion source",
    updatedAt: now,
    usageStats: null
  };
  await installMatrixCatalogFixture(page, {
    chats: [chat],
    contentMatches: [],
    folders: []
  });
  const fixture = await installMemoryFixture(context, { permanentChatDeletion: true });
  await page.unroute("**/api/chats");
  await page.unroute("**/api/chats?*");
  await page.route("**/api/chats", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      json: {
        chats: fixture.permanentChatDeleted() ? [] : [chat],
        contentMatches: [],
        folders: []
      }
    });
  });
  await signIn(page);

  await page.getByRole("button", { name: "Open workspace" }).click();
  const workspace = page.getByTestId("workspace-pane-mobile");
  await workspace.getByRole("button", { name: "Chat actions Deletion source" }).click();
  const menu = workspace.getByRole("dialog", { name: "Actions for Deletion source" });
  await expect(menu.getByRole("button", { name: "Архивировать" })).toBeVisible();
  const permanentAction = menu.getByRole("button", { name: "Удалить навсегда" });
  await expectTouchSafe(permanentAction);
  await permanentAction.click();

  let deletion = page.getByRole("dialog", { name: "Удалить этот чат навсегда?" });
  await expect(deletion.getByText(/исчезнет сразу/u)).toBeVisible();
  await expect(deletion.getByLabel(/Также забыть сохранённые воспоминания/u)).not.toBeChecked();
  await expect(deletion.getByText(/AI-провайдеру/u)).not.toBeVisible();
  await deletion.getByText("Расширенные сведения").click();
  await expect(deletion.getByText(/AI-провайдеру/u)).toBeVisible();
  await expect(deletion.getByText(/резервных копиях/u)).toBeVisible();
  await deletion.getByLabel(/Также забыть сохранённые воспоминания/u).check();
  await expectWithinViewport(page, deletion);
  await expectNoHorizontalOverflow(page);

  await deletion.getByRole("button", { name: "Удалить навсегда" }).click();
  await expect(deletion.getByText(/Чат изменился/u)).toBeVisible();
  expect(fixture.permanentChatDeletionAdmissions).toHaveLength(0);
  await deletion.getByRole("button", { name: "Удалить навсегда" }).click();

  deletion = page.getByRole("dialog", { name: "Безвозвратное удаление" });
  await expect(deletion.getByText(/внимание администратора/u)).toBeVisible();
  expect(fixture.permanentChatDeletionAuthorizations).toHaveLength(2);
  expect(fixture.permanentChatDeletionAuthorizations[1]).toMatchObject({
    alsoForgetOriginMemories: true,
    confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
    expectedActiveLeafMessageId: "message-permanent",
    expectedChatRevision: 4
  });
  expect(fixture.permanentChatDeletionAdmissions).toEqual([{
    alsoForgetOriginMemories: true,
    expectedActiveLeafMessageId: "message-permanent",
    expectedChatRevision: 4,
    mutationAuthorizationId: "chat-delete-authorization-e2e"
  }]);
  await deletion.getByRole("button", { name: "Закрыть" }).last().click();
  await expect(page.getByRole("alert").filter({
    hasText: "очистке требуется внимание"
  })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("alert").filter({
    hasText: "очистке требуется внимание"
  })).toBeVisible();
  await expect(page.getByText("Deletion source", { exact: true })).toHaveCount(0);
  await page.setViewportSize({ height: 390, width: 844 });
  await page.getByRole("button", { name: "Посмотреть прогресс" }).click();
  deletion = page.getByRole("dialog", { name: "Безвозвратное удаление" });
  await deletion.getByText("Расширенные сведения").click();
  await expect(deletion.getByText("chat-permanent-deletion-e2e")).toBeVisible();
  await expect(deletion.getByText("memory_cleanup_residual")).toBeVisible();
  await expectWithinViewport(page, deletion);
  await expectNoHorizontalOverflow(page);
});

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

test("keeps Memory health simple, safety-prominent, advanced, and responsive", async ({ context, page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await installMatrixCatalogFixture(page);
  await installMemoryFixture(context, {
    consentMode: "ADMIN",
    operationsEnabled: true,
    userHealth: {
      action: "OPEN_MEMORY_OPERATIONS",
      deletion: {
        activeCount: 2,
        countTruncated: false,
        retrievalFenced: true,
        state: "BLOCKED_REQUIRES_ADMIN"
      },
      egressReview: "NONE",
      indexing: {
        completedChats: 5,
        countTruncated: false,
        state: "READY",
        totalChats: 5
      },
      learning: { reason: "USER_DISABLED", resumeAt: null, state: "DISABLED" },
      observedAt: now,
      rebuild: { state: "IDLE" },
      state: "BLOCKED_REQUIRES_ADMIN",
      temporary: { countTruncated: false, overdueCount: 1, state: "OVERDUE" }
    }
  });
  await signIn(page);

  await runAccountMenuAction(page, "Settings");
  const settings = page.getByTestId("settings-dialog");
  await settings.getByRole("button", { name: "Memory" }).click();
  const pulse = settings.getByTestId("memory-health-pulse");
  await expect(pulse.getByRole("heading", {
    name: "Очистке Памяти требуется внимание администратора"
  })).toBeVisible();
  await expect(pulse.getByText(/ограждены от повторного использования/u)).toBeVisible();
  await expect(pulse.getByText(/истёк срок удаления временного чата/u)).toBeVisible();
  await expect(pulse.getByText("Физическая очистка")).toBeHidden();

  const advanced = pulse.getByText("Расширенный режим", { exact: true });
  await expectTouchSafe(advanced);
  await advanced.focus();
  await advanced.press("Enter");
  await expect(pulse.getByText("Физическая очистка")).toBeVisible();
  await expect(pulse.getByText("Нужно внимание администратора")).toBeVisible();
  await expectWithinViewport(page, advanced);
  await expectNoHorizontalOverflow(page);

  await page.setViewportSize({ height: 390, width: 844 });
  await expect(pulse).toBeVisible();
  await expectNoHorizontalOverflow(page);
  const operations = pulse.getByRole("button", { name: "Открыть операции Памяти" });
  await expectTouchSafe(operations);
  await operations.click();
  await expect(settings.getByRole("heading", { exact: true, name: "Операции Памяти" })).toBeFocused();
  await expectNoHorizontalOverflow(page);
  await settings.getByRole("button", { name: "Назад к настройкам Памяти" }).click();
  await expect(pulse.getByRole("button", { name: "Открыть операции Памяти" })).toBeFocused();
});

test("keeps Memory operations exact, recoverable, cancellable, and responsive", async ({ context, page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await installMatrixCatalogFixture(page);
  const fixture = await installMemoryFixture(context, { operationsEnabled: true });
  await signIn(page);

  await runAccountMenuAction(page, "Settings");
  let settings = page.getByTestId("settings-dialog");
  await settings.getByRole("button", { name: "Memory" }).click();
  await expect(settings.getByRole("button", { name: "Операции Памяти" })).toBeVisible();
  await settings.getByRole("radio", { name: "English" }).click();
  await settings.getByRole("button", { name: "Accept current destinations" }).click();
  await settings.getByRole("switch", { name: "Reference chat history" }).click();

  const entry = settings.getByRole("button", { name: "Memory operations" });
  await expectTouchSafe(entry);
  await entry.click();
  let operations = settings.getByTestId("memory-operations");
  const operationsHeading = operations.getByRole("heading", { name: "Memory operations" });
  await expect(operationsHeading).toBeFocused();
  await expectWithinViewport(page, operationsHeading);
  await expect(operations.getByRole("button", { name: "Review action" })).toHaveCount(6);
  await expectWithinViewport(page, settings);
  await expectNoHorizontalOverflow(page);

  const rebuildRow = operations.getByRole("listitem").filter({
    hasText: "Build or rebuild search index"
  });
  await rebuildRow.getByRole("button", { name: "Review action" }).click();
  await expect(operations.getByRole("heading", { name: "Confirm Memory operation" })).toBeFocused();
  let confirmation = operations.getByRole("region", { name: "Confirm Memory operation" });
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

  const learnedRow = operations.getByRole("listitem").filter({
    hasText: "Delete automatically learned memories"
  });
  await learnedRow.getByRole("button", { name: "Review action" }).click();
  confirmation = operations.getByRole("region", { name: "Confirm Memory operation" });
  await confirmation.getByText("What is and is not deleted").click();
  await expect(confirmation.getByText(/old observed chat content, rebuilds, or delayed work/u)).toBeVisible();
  await expect(confirmation.getByText(/Explicitly saved memories, raw retained chats/u)).toBeVisible();
  await confirmation.getByRole("button", { name: "Confirm and start" }).click();
  await expect(operations.getByText(/Retrieval is fenced.*queued/u)).toBeVisible();
  expect(fixture.mutationAuthorizations.at(-1)).toMatchObject({
    action: "BULK_DELETE",
    expectedMemoryRevision: 9,
    expectedSettingsRevision: 15,
    operation: "DELETE_LEARNED"
  });
  expect(fixture.bulkDeletionRequests.at(-1)).toEqual({
    expectedMemoryRevision: 9,
    expectedSettingsRevision: 15,
    mutationAuthorizationId: "authorization-1",
    operation: "DELETE_LEARNED"
  });
  fixture.completeLearnedDeletion();
  await operations.getByRole("button", { name: "Check status" }).click();
  await expect(operations.getByText(/learned-memory derivatives passed the durable deletion audit/u)).toBeVisible();
  await expect(operations.getByText("7 / 7", { exact: false })).toBeVisible();
  await operations.getByRole("button", { name: "Dismiss completed status" }).click();

  await operations.getByRole("button", { name: "Review action" }).last().click();
  confirmation = operations.getByRole("region", { name: "Confirm Memory operation" });
  await expectWithinViewport(page, confirmation.getByRole("heading", { name: "Confirm Memory operation" }));
  await confirmation.getByText("What is and is not deleted").click();
  await expect(confirmation.getByText(/immediate retrieval fence/u)).toBeVisible();
  await expect(confirmation.getByText(/Raw retained chats/u)).toBeVisible();
  await confirmation.getByRole("button", { name: "Confirm and start" }).click();
  await expect(operations.getByText(/Retrieval is fenced.*queued/u)).toBeVisible();
  expect(fixture.mutationAuthorizations.at(-1)).toMatchObject({
    action: "BULK_DELETE",
    expectedMemoryRevision: 10,
    expectedSettingsRevision: 16,
    operation: "CLEAR_HISTORY_INDEX"
  });
  expect(fixture.bulkDeletionRequests.at(-1)).toEqual({
    expectedMemoryRevision: 10,
    expectedSettingsRevision: 16,
    mutationAuthorizationId: "authorization-2",
    operation: "CLEAR_HISTORY_INDEX"
  });

  await page.reload();
  await runAccountMenuAction(page, "Settings");
  settings = page.getByTestId("settings-dialog");
  await settings.getByRole("button", { name: "Memory" }).click();
  await settings.getByRole("button", { name: "Memory operations" }).click();
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

  await operations.getByRole("button", { name: "Dismiss completed status" }).click();
  const resetRow = operations.getByRole("listitem").filter({
    hasText: "Delete everything Memory remembers"
  });
  await resetRow.getByRole("button", { name: "Review action" }).click();
  confirmation = operations.getByRole("region", { name: "Confirm Memory operation" });
  await expect(confirmation.getByText(/Turn off Memory now/u)).toBeVisible();
  await confirmation.getByText("What is and is not deleted").click();
  await expect(confirmation.getByText(/raw chats remain/u)).toBeVisible();
  await expect(confirmation.getByText(/accepted past answers or runs is not rewritten/u)).toBeVisible();
  await expect(confirmation.getByText(/old chats do not refill it/u)).toBeVisible();
  await confirmation.getByRole("button", { name: "Confirm and start" }).click();
  await expect(operations.getByText("Memory is off. Background deletion is queued.")).toBeVisible();
  expect(fixture.mutationAuthorizations.at(-1)).toMatchObject({
    action: "BULK_DELETE",
    expectedMemoryRevision: 11,
    expectedSettingsRevision: 17,
    operation: "DELETE_ALL_REUSABLE"
  });
  expect(fixture.bulkDeletionRequests.at(-1)).toEqual({
    expectedMemoryRevision: 11,
    expectedSettingsRevision: 17,
    mutationAuthorizationId: "authorization-3",
    operation: "DELETE_ALL_REUSABLE"
  });
  await operations.getByRole("button", { name: "Check status" }).click();
  await expect(operations.getByText(/Memory stays off.*administrator attention/u)).toBeVisible();
  await expect(operations.getByText("8 / 11", { exact: false })).toBeVisible();

  await page.reload();
  await runAccountMenuAction(page, "Settings");
  settings = page.getByTestId("settings-dialog");
  await settings.getByRole("button", { name: "Memory" }).click();
  await settings.getByRole("button", { name: "Memory operations" }).click();
  operations = settings.getByTestId("memory-operations");
  await expect(operations.getByText(/Memory stays off.*administrator attention/u)).toBeVisible();
  fixture.completeAllDeletion();
  await operations.getByRole("button", { name: "Check status" }).click();
  await expect(operations.getByText(/Everything reusable by Memory passed/u)).toBeVisible();
  await expect(operations.getByText("11 / 11", { exact: false })).toBeVisible();

  await operations.getByRole("button", { name: "Back to Memory settings" }).click();
  await expect(settings.getByRole("button", { name: "Memory operations" })).toBeFocused();
  await expect(settings.getByRole("switch", { name: "Use memory facts" }))
    .toHaveAttribute("aria-checked", "false");
  await expect(settings.getByRole("switch", { name: "Reference chat history" }))
    .toHaveAttribute("aria-checked", "false");
  await expect(settings.getByRole("switch", { name: "Learn useful memories automatically" }))
    .toHaveAttribute("aria-checked", "false");
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
  await expect(settings.getByRole("heading", { name: "Память в порядке" })).toBeVisible();
  await expect(settings.getByRole("switch", { name: "Использовать факты из памяти" })).toHaveAttribute("aria-checked", "false");
  await expect(settings.getByText("current-memory-destination-fingerprint-0001")).toBeHidden();
  await settings.getByText("Расширенный режим", { exact: true }).click();
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
  await expect(manager.getByRole("heading", { name: "Forget this memory?" })).toHaveCount(0);
  await expect(manager.getByText("Forgotten.", { exact: true })).toBeVisible();
  expect(fixture.mutationAuthorizations.at(-1)).toMatchObject({ action: "FORGET" });
  await manager.getByRole("button", { name: "Undo" }).click();
  await expect(manager.getByText("Memory restored.", { exact: true })).toBeVisible();
  await expect(manager.getByRole("button", { name: /Always begin with a concise summary/u })).toBeVisible();
  expect(fixture.mutationAuthorizations.at(-1)).toMatchObject({ action: "SAVE" });
  expect(fixture.forgetUndoRequests).toHaveLength(1);

  await page.setViewportSize({ height: 390, width: 844 });
  await expectWithinViewport(page, settings);
  await expectNoHorizontalOverflow(page);
  await manager.getByRole("button", { name: "Delete all saved memories" }).click();
  await expect(manager.getByRole("heading", { name: "Delete all saved memories?" })).toBeVisible();
  await manager.getByText("What is and is not deleted").click();
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

test("reviews automatic Memory and resolves conflicts without confirmation ceremony", async ({ context, page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await installMatrixCatalogFixture(page);
  const fixture = await installMemoryFixture(context, {
    consentMode: "ADMIN",
    defaultsOn: true,
    reviewScenario: true
  });
  await signIn(page);

  await runAccountMenuAction(page, "Settings");
  const settings = page.getByTestId("settings-dialog");
  await settings.getByRole("button", { name: "Memory" }).click();
  await settings.getByRole("radio", { name: "English" }).click();
  await settings.getByRole("button", { name: "Manage Memories" }).click();
  const manager = settings.getByTestId("manage-memories");

  const automatic = manager.getByTestId("memory-list-pane").getByRole("button", {
    name: /I prefer concise answers with concrete evidence/u
  });
  await expect(automatic).toContainText("Learned automatically");
  await expect(automatic).toContainText("2 deferred candidates");
  await automatic.click();

  await expect(manager.getByRole("heading", { name: "Why this was remembered" })).toBeVisible();
  await expect(manager.getByRole("heading", { name: "Evidence history" })).toBeVisible();
  await expect(manager.getByText("Retained chat message")).toBeVisible();
  await manager.getByLabel("Private note (optional)").fill("  Wrong inference from this source.  ");
  await manager.getByRole("button", { name: "This is incorrect" }).click();
  await expect(manager.getByText("Private Memory feedback recorded.")).toBeVisible();
  expect(fixture.feedbackRequests[0]).toMatchObject({
    comment: "Wrong inference from this source.",
    expectedVersionId: "memory-automatic-review-version-1",
    feedbackType: "INCORRECT"
  });
  await expect(manager.getByRole("dialog")).toHaveCount(0);

  await manager.getByRole("button", { name: "Undo" }).click();
  await expect(manager.getByText("Memory feedback undone.")).toBeVisible();
  expect(fixture.feedbackRequests[1]).toMatchObject({
    expectedVersionId: "memory-automatic-review-version-1",
    feedbackType: "RETRACT",
    retractsFeedbackId: "feedback-review-1"
  });

  await manager.getByRole("button", { name: "Back to saved memories" }).click();
  await manager.getByRole("button", { name: "Conflicted" }).click();
  await manager.getByRole("button", { name: /Keep answers concise/u }).click();
  await expect(manager.getByRole("heading", { name: "Needs your choice" })).toBeVisible();
  await expect(manager.getByRole("button", { name: "Move scope" })).toHaveCount(0);
  await manager.getByLabel("Correct value").fill("Use concise answers with evidence on request.");
  await manager.getByRole("button", { name: "Save correction" }).click();

  await expect(manager.getByText("Conflict resolved with an explicit version.")).toBeVisible();
  expect(fixture.conflictResolutionRequests[0]).toMatchObject({
    expectedVersionIds: ["conflict-version-a", "conflict-version-b"],
    resolution: {
      kind: "CORRECT",
      statement: "Use concise answers with evidence on request."
    }
  });
  await expect(manager.getByTestId("memory-detail-pane").getByText(
    "Use concise answers with evidence on request.",
    { exact: true }
  ).first()).toBeVisible();
  await expect(manager.getByRole("dialog")).toHaveCount(0);
  await expectWithinViewport(page, settings);
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

  await settings.getByRole("button", { name: "Manage Memories" }).click();
  const manager = settings.getByTestId("manage-memories");
  const profile = manager.getByTestId("memory-profile-summary");
  await expect(manager.getByRole("heading", { name: "What AIQSA remembers about you" }))
    .toBeVisible();
  await expect(profile.getByText("Любимый цвет — зелёный.", { exact: true })).toBeVisible();
  await expect(profile.getByText(/Source: Saved by you/u)).toHaveCount(0);
  await expect(profile.getByText(/Use priority/u)).toHaveCount(0);

  const advanced = manager.getByRole("button", { name: "Advanced view" });
  await advanced.focus();
  await advanced.press("Enter");
  await expect(advanced).toHaveAttribute("aria-expanded", "true");
  await expect(profile.getByText(/Source: Saved by you/u)).toBeVisible();
  await expect(profile.getByText(/Use priority: Often useful/u)).toBeVisible();

  await manager.getByRole("button", {
    name: "Sources and history: Любимый цвет — зелёный."
  }).click();
  await expect(manager.getByRole("heading", { name: "Memory detail" })).toBeVisible();
  await manager.getByRole("button", { name: "Back to saved memories" }).click();

  await manager.getByRole("button", {
    name: "Edit: Любимый цвет — зелёный."
  }).click();
  await expect(manager.getByLabel("Exact statement")).toHaveValue("Любимый цвет — зелёный.");
  await manager.getByRole("button", { name: "Back to saved memories" }).click();
  await expect(manager.getByRole("heading", { name: "Memory detail" })).toBeVisible();
  await manager.getByRole("button", { name: "Back to saved memories" }).click();

  await manager.getByRole("button", {
    name: "Delete: Любимый цвет — зелёный."
  }).click();
  await expect(manager.getByText("Forgotten.", { exact: true })).toBeVisible();
  await expect(profile.getByText("Любимый цвет — зелёный.", { exact: true })).toHaveCount(0);
  await manager.getByRole("button", { name: "Undo" }).click();
  await expect(manager.getByText("Memory restored.", { exact: true })).toBeVisible();
  await expect(profile.getByText("Любимый цвет — зелёный.", { exact: true })).toBeVisible();
  await expectTouchSafe(manager.getByRole("button", {
    name: "Delete: Любимый цвет — зелёный."
  }));
  await expectWithinViewport(page, settings);
  await expectNoHorizontalOverflow(page);
});
