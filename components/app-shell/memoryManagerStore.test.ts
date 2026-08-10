import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginCreateMemory,
  beginDeleteExplicitMemories,
  confirmDeleteExplicitMemories,
  refreshMemoryDeletionStatus,
  resetMemoryManagerStoreForTest,
  saveMemoryChanges,
  saveNewMemory,
  useMemoryManagerStore
} from "./memoryManagerStore";
import {
  resetMemorySettingsStoreForTest,
  useMemorySettingsStore
} from "./memorySettingsStore";
import {
  memoryDeletionFixture,
  memoryEvidenceFixture,
  memorySettingsFixture,
  memorySummaryFixture
} from "./memoryTestFixtures";

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
      if (path === `/api/me/memories/${original.id}`) return json({ memory: current });
      if (path.includes("/evidence")) return json(memoryEvidenceFixture());
      throw new Error(`unexpected request: ${path}`);
    }));
    useMemoryManagerStore.setState({
      activeMemory: original,
      detailLoadState: "ready",
      draft: {
        category: "preference",
        modality: "PREFERENCE",
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
