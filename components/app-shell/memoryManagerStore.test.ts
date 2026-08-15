import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginCreateMemory, beginDeleteExplicitMemories, beginMoveMemory, confirmDeleteExplicitMemories, forgetCurrentMemory, moveMemoryScope, refreshMemoryDeletionStatus, resolveMemoryConflictChoice, saveMemoryChanges, saveNewMemory, submitMemoryFeedback, undoLastMemoryFeedback, useMemoryManagerStore } from "./memoryManagerStore";
import { useMemorySettingsStore } from "./memorySettingsStore";
import {
  memoryDeletionFixture,
  memoryDetailFixture,
  memoryEvidenceFixture,
  memorySettingsFixture,
  memorySummaryFixture
} from "@/tests/support/memoryFixtures";
import { resetMemoryManagerStoreForTest, resetMemorySettingsStoreForTest } from "@/tests/support/appShellStores";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status
  });
}

describe("Memory manager store", () => {
  beforeEach(() => {
    resetMemoryManagerStoreForTest();
    resetMemorySettingsStoreForTest();
  });
  afterEach(() => {
    resetMemoryManagerStoreForTest();
    resetMemorySettingsStoreForTest();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("creates an exact GLOBAL_USER memory through hash-bound authority and discloses use-off", async () => {
    const created = memorySummaryFixture({
      category: "workflow",
      displayText: "  Всегда начинай с краткого итога.  ",
      modality: "WORKFLOW"
    });
    const calls: Array<{ body: Record<string, unknown>; path: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      calls.push({ body, path });
      if (path === "/api/me/memory/mutation-authorizations") {
        return json({
          expiresAt: "2026-08-10T08:05:00.000Z",
          mutationAuthorizationId: "memory-authorization-save"
        }, 201);
      }
      if (path === "/api/me/memories") return json({ memory: created }, 201);
      if (path.includes("/evidence")) return json(memoryEvidenceFixture());
      throw new Error(`unexpected request: ${path}`);
    }));
    beginCreateMemory();
    useMemoryManagerStore.getState().setDraft({
      category: "workflow",
      modality: "WORKFLOW",
      statement: "  Всегда начинай с краткого итога.  "
    });

    await saveNewMemory(false);

    expect(calls[0]?.body).toMatchObject({
      action: "SAVE",
      exactStatementHash: "2433318f7bca8b4e516d1a24c4d343a1f1848583463209e2a11c50a71480c587"
    });
    expect(calls[1]).toEqual({
      body: {
        category: "workflow",
        modality: "WORKFLOW",
        mutationAuthorizationId: "memory-authorization-save",
        scope: { type: "GLOBAL_USER" },
        statement: "  Всегда начинай с краткого итога.  "
      },
      path: "/api/me/memories"
    });
    expect(useMemoryManagerStore.getState()).toMatchObject({
      activeMemory: created,
      draftDirty: false,
      notice: "saved_use_off",
      screen: "detail"
    });
  });

  it("keeps an exact edit draft while reconciling a stale current version", async () => {
    const original = memorySummaryFixture();
    const current = memorySummaryFixture({
      currentVersionId: "memory-version-2",
      displayText: "Server-side replacement",
      updatedAt: "2026-08-10T09:00:00.000Z"
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/me/memory/mutation-authorizations") {
        return json({
          expiresAt: "2026-08-10T08:05:00.000Z",
          mutationAuthorizationId: "memory-authorization-edit"
        }, 201);
      }
      if (path === `/api/me/memories/${original.id}` && init?.method === "PATCH") {
        return json({ error: "memory_version_stale" }, 409);
      }
      if (path === `/api/me/memories/${original.id}`) return json(memoryDetailFixture(current));
      if (path.includes("/evidence")) return json(memoryEvidenceFixture());
      throw new Error(`unexpected request: ${path}`);
    }));
    useMemoryManagerStore.setState({
      activeMemory: original,
      detailLoadState: "ready",
      draft: {
        category: "preference",
        modality: "PREFERENCE",
        scope: { type: "GLOBAL_USER" },
        statement: "My unsaved exact draft"
      },
      draftDirty: true,
      memories: [original],
      screen: "edit"
    });

    await expect(saveMemoryChanges()).rejects.toThrow("memory_version_stale");

    expect(useMemoryManagerStore.getState()).toMatchObject({
      activeMemory: current,
      draft: { statement: "My unsaved exact draft" },
      draftDirty: true,
      draftStale: true,
      screen: "edit"
    });
  });

  it("moves an ORPHANED fact append-only with its exact action version", async () => {
    const orphaned = memorySummaryFixture({
      actionVersionId: "memory-version-orphaned",
      currentVersionId: null,
      factState: "ORPHANED",
      scope: { targetId: "chat-gone", type: "CHAT" },
      versionState: "ORPHANED"
    });
    const moved = memorySummaryFixture({
      actionVersionId: "memory-version-moved",
      currentVersionId: "memory-version-moved",
      id: "memory-fact-moved",
      scope: { targetId: "folder-live", type: "FOLDER" }
    });
    const calls: Array<{ body: Record<string, unknown>; path: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      calls.push({ body, path });
      if (path === "/api/me/memory/mutation-authorizations") {
        return json({
          expiresAt: "2026-08-10T08:05:00.000Z",
          mutationAuthorizationId: "memory-authorization-move"
        }, 201);
      }
      if (path === `/api/me/memories/${orphaned.id}` && init?.method === "PATCH") {
        return json({ memory: moved });
      }
      if (path.endsWith("/evidence")) return json(memoryEvidenceFixture());
      if (path.startsWith("/api/me/memories?")) return json({ memories: [], nextCursor: null });
      throw new Error(`unexpected request: ${path}`);
    }));
    useMemoryManagerStore.setState({
      activeMemory: orphaned,
      detailLoadState: "ready",
      memories: [orphaned],
      screen: "detail"
    });

    beginMoveMemory();
    useMemoryManagerStore.getState().setDraft({
      scope: { targetId: "folder-live", type: "FOLDER" }
    });
    await moveMemoryScope();

    expect(calls[0]?.body).toMatchObject({
      action: "MOVE_SCOPE",
      expectedTargetVersionId: "memory-version-orphaned",
      targetFactId: orphaned.id
    });
    expect(calls[1]).toEqual({
      body: {
        expectedVersionId: "memory-version-orphaned",
        mutationAuthorizationId: "memory-authorization-move",
        scope: { targetId: "folder-live", type: "FOLDER" }
      },
      path: `/api/me/memories/${orphaned.id}`
    });
    expect(useMemoryManagerStore.getState()).toMatchObject({
      activeMemory: moved,
      draftDirty: false,
      memories: [moved],
      notice: "saved",
      screen: "detail"
    });
  });

  it("forgets an ORPHANED fact with its exact non-current action version", async () => {
    const orphaned = memorySummaryFixture({
      actionVersionId: "memory-version-orphaned",
      currentVersionId: null,
      factState: "ORPHANED",
      scope: { targetId: "assistant-gone", type: "ASSISTANT" },
      versionState: "ORPHANED"
    });
    const forgotten = memorySummaryFixture({
      actionVersionId: null,
      currentVersionId: null,
      factState: "FORGOTTEN",
      versionState: "FORGOTTEN"
    });
    const calls: Array<{ body: Record<string, unknown>; path: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      calls.push({ body, path });
      if (path === "/api/me/memory/mutation-authorizations") {
        return json({
          expiresAt: "2026-08-10T08:05:00.000Z",
          mutationAuthorizationId: "memory-authorization-forget"
        }, 201);
      }
      if (path.endsWith("/forget")) {
        return json({
          memory: forgotten,
          undo: {
            deletionId: "memory-deletion-forget",
            expiresAt: "2026-08-10T08:01:00.000Z",
            versionId: "memory-version-orphaned"
          }
        });
      }
      if (path.startsWith("/api/me/memories?")) return json({ memories: [], nextCursor: null });
      throw new Error(`unexpected request: ${path}`);
    }));
    useMemoryManagerStore.setState({ activeMemory: orphaned, memories: [orphaned], screen: "detail" });

    await forgetCurrentMemory();

    expect(calls[0]?.body).toMatchObject({
      action: "FORGET",
      expectedTargetVersionId: "memory-version-orphaned",
      targetFactId: orphaned.id
    });
    expect(calls[1]?.body).toEqual({
      expectedVersionId: "memory-version-orphaned",
      mutationAuthorizationId: "memory-authorization-forget"
    });
    expect(useMemoryManagerStore.getState()).toMatchObject({
      activeMemory: null,
      lastForgetUndo: {
        factId: orphaned.id,
        statement: orphaned.displayText,
        undo: {
          deletionId: "memory-deletion-forget",
          expiresAt: "2026-08-10T08:01:00.000Z",
          versionId: "memory-version-orphaned"
        }
      },
      memories: [],
      notice: "forgotten",
      screen: "list"
    });
  });

  it("commits private feedback immediately and undoes it with an append-only retraction", async () => {
    const automatic = memorySummaryFixture({ sourceMode: "AUTOMATIC" });
    const calls: Array<{ body: Record<string, unknown>; path: string }> = [];
    let feedbackWrites = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      calls.push({ body, path });
      if (path.endsWith("/feedback")) {
        feedbackWrites += 1;
        return feedbackWrites === 1
          ? json({
              createdAt: "2026-08-11T08:00:00.000Z",
              feedbackId: "feedback-1",
              feedbackType: "INCORRECT",
              retractedFeedbackId: null,
              targetVersionId: "memory-version-1"
            }, 201)
          : json({
              createdAt: "2026-08-11T08:01:00.000Z",
              feedbackId: "feedback-retract-1",
              feedbackType: "RETRACT",
              retractedFeedbackId: "feedback-1",
              targetVersionId: "memory-version-1"
            }, 201);
      }
      if (path === `/api/me/memories/${automatic.id}`) {
        return json({
          ...memoryDetailFixture(automatic),
          feedback: [{
            comment: "Wrong inference",
            createdAt: "2026-08-11T08:00:00.000Z",
            feedbackType: "INCORRECT",
            id: "feedback-1",
            retractedAt: feedbackWrites > 1 ? "2026-08-11T08:01:00.000Z" : null,
            targetVersionId: "memory-version-1"
          }]
        });
      }
      throw new Error(`unexpected request: ${path}`);
    }));
    useMemoryManagerStore.setState({
      activeMemory: automatic,
      detailLoadState: "ready",
      memories: [automatic],
      screen: "detail"
    });

    await submitMemoryFeedback("memory-version-1", "INCORRECT", "  Wrong inference  ");
    expect(useMemoryManagerStore.getState()).toMatchObject({
      lastFeedbackUndo: { feedbackId: "feedback-1", versionId: "memory-version-1" },
      notice: "feedback_recorded"
    });
    await undoLastMemoryFeedback();

    const writes = calls.filter(({ path }) => path.endsWith("/feedback"));
    expect(writes).toHaveLength(2);
    expect(writes[0]?.body).toMatchObject({
      comment: "Wrong inference",
      expectedVersionId: "memory-version-1",
      feedbackType: "INCORRECT"
    });
    expect(writes[1]?.body).toMatchObject({
      expectedVersionId: "memory-version-1",
      feedbackType: "RETRACT",
      retractsFeedbackId: "feedback-1"
    });
    expect(writes[0]?.body.requestId).not.toBe(writes[1]?.body.requestId);
    expect(useMemoryManagerStore.getState()).toMatchObject({
      lastFeedbackUndo: null,
      notice: "feedback_retracted"
    });
  });

  it("does not merge delayed feedback into another open memory", async () => {
    const source = memorySummaryFixture({ id: "memory-source", sourceMode: "AUTOMATIC" });
    const destination = memorySummaryFixture({ id: "memory-destination" });
    let resolveFeedback!: (response: Response) => void;
    const delayedFeedback = new Promise<Response>((resolve) => {
      resolveFeedback = resolve;
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/feedback")) return delayedFeedback;
      if (path.startsWith("/api/me/memories?")) {
        return json({ memories: [destination], nextCursor: null });
      }
      throw new Error(`unexpected request: ${path}`);
    }));
    useMemoryManagerStore.setState({
      activeMemory: source,
      detailLoadState: "ready",
      memories: [source, destination],
      screen: "detail"
    });

    const pending = submitMemoryFeedback("memory-version-1", "INCORRECT");
    useMemoryManagerStore.setState({
      activeMemory: destination,
      feedback: [],
      lastFeedbackUndo: null,
      notice: null
    });
    resolveFeedback(json({
      createdAt: "2026-08-11T08:00:00.000Z",
      feedbackId: "feedback-source",
      feedbackType: "INCORRECT",
      retractedFeedbackId: null,
      targetVersionId: "memory-version-1"
    }, 201));
    await pending;

    expect(useMemoryManagerStore.getState()).toMatchObject({
      activeMemory: destination,
      feedback: [],
      lastFeedbackUndo: null,
      mutationState: null,
      notice: null
    });
  });

  it("resolves an exact conflict choice in one submission", async () => {
    const conflicted = memorySummaryFixture({
      actionVersionId: "version-a",
      currentVersionId: null,
      factState: "CONFLICTED",
      sourceMode: "AUTOMATIC",
      versionState: "CONFLICTING"
    });
    const resolved = memorySummaryFixture({
      actionVersionId: "version-resolved",
      currentVersionId: "version-resolved",
      sourceMode: "EXPLICIT"
    });
    const calls: Array<{ body: Record<string, unknown>; path: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      calls.push({ body, path });
      if (path === "/api/me/memory/mutation-authorizations") {
        return json({
          expiresAt: "2026-08-11T08:05:00.000Z",
          mutationAuthorizationId: "authorization-resolve"
        }, 201);
      }
      if (path.endsWith("/resolve")) return json({ memory: resolved });
      if (path === `/api/me/memories/${conflicted.id}`) {
        return json(memoryDetailFixture(resolved));
      }
      if (path.startsWith("/api/me/memories?")) {
        return json({ memories: [resolved], nextCursor: null });
      }
      throw new Error(`unexpected request: ${path}`);
    }));
    useMemoryManagerStore.setState({
      activeMemory: conflicted,
      detailLoadState: "ready",
      memories: [conflicted],
      screen: "detail",
      versions: [{
        category: "preference",
        createdAt: "2026-08-11T07:00:00.000Z",
        displayText: "Version A",
        id: "version-a",
        modality: "PREFERENCE",
        sensitivityClass: "NORMAL",
        sourceCount: 1,
        sourceMode: "AUTOMATIC",
        state: "CONFLICTING",
        systemFrom: "2026-08-11T07:00:00.000Z",
        systemTo: null,
        validFrom: null,
        validTo: null
      }, {
        category: "preference",
        createdAt: "2026-08-11T07:01:00.000Z",
        displayText: "Version B",
        id: "version-b",
        modality: "PREFERENCE",
        sensitivityClass: "NORMAL",
        sourceCount: 1,
        sourceMode: "AUTOMATIC",
        state: "CONFLICTING",
        systemFrom: "2026-08-11T07:01:00.000Z",
        systemTo: null,
        validFrom: null,
        validTo: null
      }]
    });

    await resolveMemoryConflictChoice("version-b");

    const resolveCall = calls.find(({ path }) => path.endsWith("/resolve"));
    expect(resolveCall?.body).toEqual({
      expectedVersionIds: ["version-a", "version-b"],
      mutationAuthorizationId: "authorization-resolve",
      resolution: { kind: "CHOOSE", versionId: "version-b" }
    });
    expect(useMemoryManagerStore.getState()).toMatchObject({
      activeMemory: resolved,
      mutationState: null,
      notice: "resolved",
      screen: "detail"
    });
  });

  it("refreshes CAS authority at destructive confirmation and keeps blocked purge status actionable", async () => {
    const currentSettings = memorySettingsFixture({
      settings: { memoryRevision: 21, settingsRevision: 34 }
    });
    const pending = memoryDeletionFixture({ memoryRevision: 22, settingsRevision: 35 });
    const blocked = memoryDeletionFixture({
      completedUnits: 3,
      memoryRevision: 22,
      settingsRevision: 35,
      state: "BLOCKED_REQUIRES_ADMIN"
    });
    const calls: Array<{ body: Record<string, unknown>; path: string }> = [];
    let settingsLoads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      calls.push({ body, path });
      if (path === "/api/me/memory/settings") {
        settingsLoads += 1;
        return json(currentSettings);
      }
      if (path === "/api/me/memory/mutation-authorizations") {
        return json({
          expiresAt: "2026-08-10T08:05:00.000Z",
          mutationAuthorizationId: "memory-authorization-delete"
        }, 201);
      }
      if (path === "/api/me/memory/bulk-delete") return json(pending, 202);
      if (path === `/api/me/memory/deletions/${pending.deletionId}`) return json(blocked);
      if (path.startsWith("/api/me/memories?")) return json({ memories: [], nextCursor: null });
      throw new Error(`unexpected request: ${path}`);
    }));
    useMemorySettingsStore.setState({
      data: memorySettingsFixture({ settings: { memoryRevision: 8, settingsRevision: 12 } }),
      error: null,
      loadState: "ready"
    });
    beginDeleteExplicitMemories();

    await confirmDeleteExplicitMemories();
    await refreshMemoryDeletionStatus();

    const authorization = calls.find((call) => call.path === "/api/me/memory/mutation-authorizations")!;
    const admission = calls.find((call) => call.path === "/api/me/memory/bulk-delete")!;
    expect(authorization.body).toMatchObject({
      action: "BULK_DELETE",
      expectedMemoryRevision: 21,
      expectedSettingsRevision: 34,
      operation: "DELETE_EXPLICIT"
    });
    expect(admission.body).toEqual({
      expectedMemoryRevision: 21,
      expectedSettingsRevision: 34,
      mutationAuthorizationId: "memory-authorization-delete",
      operation: "DELETE_EXPLICIT"
    });
    expect(settingsLoads).toBeGreaterThanOrEqual(2);
    expect(useMemoryManagerStore.getState()).toMatchObject({
      deletionLoadState: "ready",
      deletionStatus: blocked,
      screen: "delete"
    });
    expect(sessionStorage.getItem("aiqsa:memory:explicit-deletion-id")).toBe(blocked.deletionId);
  });
});
