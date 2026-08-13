import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activateMemoryOperationsAccount,
  cancelActiveMemoryRebuild,
  confirmSelectedMemoryOperation,
  deactivateMemoryOperationsAccount,
  resetMemoryOperationsStoreForTest,
  selectMemoryOperation,
  useMemoryOperationsStore
} from "./memoryOperationsStore";
import {
  resetMemoryHistorySearchStoreForTest,
  useMemoryHistorySearchStore
} from "./memoryHistorySearchStore";
import {
  resetMemoryManagerStoreForTest,
  useMemoryManagerStore
} from "./memoryManagerStore";
import { resetMemorySettingsStoreForTest } from "./memorySettingsStore";
import {
  memoryDeletionFixture,
  memoryRebuildFixture,
  memorySettingsFixture,
  memorySummaryFixture
} from "./memoryTestFixtures";
import { MEMORY_CONFIRMATION_COPY_VERSION } from "@/lib/contracts/memory";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status
  });
}

describe("Memory operations store", () => {
  beforeEach(() => {
    resetMemoryOperationsStoreForTest();
    resetMemoryHistorySearchStoreForTest();
    resetMemoryManagerStoreForTest();
    resetMemorySettingsStoreForTest();
  });

  afterEach(() => {
    resetMemoryOperationsStoreForTest();
    resetMemoryHistorySearchStoreForTest();
    resetMemoryManagerStoreForTest();
    resetMemorySettingsStoreForTest();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("admits clear-history with a fresh exact CAS grant, fences cached results, and restores status", async () => {
    const settings = memorySettingsFixture({ settings: { referenceChatHistory: true } });
    const deletion = memoryDeletionFixture({
      deletionId: "history-clear-1",
      operation: "CLEAR_HISTORY_INDEX"
    });
    const calls: Array<{ body: Record<string, unknown> | null; path: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
      calls.push({ body, path });
      if (path === "/api/me/memory/settings") return json(settings);
      if (path === "/api/me/memory/mutation-authorizations") {
        return json({
          expiresAt: "2026-08-10T08:05:00.000Z",
          mutationAuthorizationId: "clear-authorization-1"
        }, 201);
      }
      if (path === "/api/me/memory/bulk-delete") return json(deletion, 202);
      if (path === "/api/me/memory/deletions/history-clear-1") return json({
        ...deletion,
        completedUnits: 4,
        lastAuditAt: "2026-08-10T08:10:00.000Z",
        state: "SUCCEEDED"
      });
      throw new Error(`unexpected request: ${path}`);
    }));

    await activateMemoryOperationsAccount("account-a");
    useMemoryHistorySearchStore.setState({
      accountId: "account-a",
      loadState: "ready",
      nextCursor: "private-cursor",
      results: [{
        indexingState: "LEXICAL_READY",
        itemType: "RECALL_CHUNK",
        occurredAt: "2026-08-10T08:00:00.000Z",
        sourceChatId: "chat-private",
        sourceChatTitle: "Private",
        sourceFolderId: null,
        sourceFolderName: null,
        sourceMessageIds: ["message-private"],
        sourceState: "AVAILABLE",
        snippet: "Private safe projection"
      }]
    });
    selectMemoryOperation("CLEAR_HISTORY_INDEX");
    await confirmSelectedMemoryOperation();

    expect(calls[0]).toEqual({ body: null, path: "/api/me/memory/settings" });
    expect(calls[1]?.body).toMatchObject({
      action: "BULK_DELETE",
      confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
      expectedMemoryRevision: settings.settings.memoryRevision,
      expectedSettingsRevision: settings.settings.settingsRevision,
      operation: "CLEAR_HISTORY_INDEX"
    });
    expect(calls[2]).toEqual({
      body: {
        expectedMemoryRevision: settings.settings.memoryRevision,
        expectedSettingsRevision: settings.settings.settingsRevision,
        mutationAuthorizationId: "clear-authorization-1",
        operation: "CLEAR_HISTORY_INDEX"
      },
      path: "/api/me/memory/bulk-delete"
    });
    expect(useMemoryHistorySearchStore.getState()).toMatchObject({
      accountId: "account-a",
      nextCursor: null,
      results: []
    });
    expect(useMemoryOperationsStore.getState()).toMatchObject({
      confirmation: null,
      clearStatus: deletion
    });

    deactivateMemoryOperationsAccount("account-a");
    await activateMemoryOperationsAccount("account-a");
    expect(useMemoryOperationsStore.getState().clearStatus).toMatchObject({
      deletionId: "history-clear-1",
      state: "SUCCEEDED"
    });
  });

  it("admits learned deletion with its own exact grant and restores its separate status", async () => {
    const settings = memorySettingsFixture();
    const deletion = memoryDeletionFixture({
      deletionId: "learned-delete-1",
      operation: "DELETE_LEARNED"
    });
    const calls: Array<{ body: Record<string, unknown> | null; path: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
      calls.push({ body, path });
      if (path === "/api/me/memory/settings") return json(settings);
      if (path === "/api/me/memory/mutation-authorizations") {
        return json({
          expiresAt: "2026-08-10T08:05:00.000Z",
          mutationAuthorizationId: "learned-authorization-1"
        }, 201);
      }
      if (path === "/api/me/memory/bulk-delete") return json(deletion, 202);
      if (path === "/api/me/memory/deletions/learned-delete-1") return json({
        ...deletion,
        completedUnits: 7,
        lastAuditAt: "2026-08-10T08:10:00.000Z",
        state: "SUCCEEDED",
        totalUnits: 7
      });
      throw new Error(`unexpected request: ${path}`);
    }));

    await activateMemoryOperationsAccount("account-a");
    useMemoryHistorySearchStore.setState({
      accountId: "account-a",
      loadState: "ready",
      nextCursor: null,
      results: [{
        indexingState: "LEXICAL_READY",
        itemType: "RECALL_CHUNK",
        occurredAt: "2026-08-10T08:00:00.000Z",
        sourceChatId: "chat-retained",
        sourceChatTitle: "Retained",
        sourceFolderId: null,
        sourceFolderName: null,
        sourceMessageIds: ["message-retained"],
        sourceState: "AVAILABLE",
        snippet: "Retained history projection"
      }]
    });
    selectMemoryOperation("DELETE_LEARNED");
    await confirmSelectedMemoryOperation();

    expect(calls[1]?.body).toMatchObject({
      action: "BULK_DELETE",
      confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
      expectedMemoryRevision: settings.settings.memoryRevision,
      expectedSettingsRevision: settings.settings.settingsRevision,
      operation: "DELETE_LEARNED"
    });
    expect(calls[2]).toEqual({
      body: {
        expectedMemoryRevision: settings.settings.memoryRevision,
        expectedSettingsRevision: settings.settings.settingsRevision,
        mutationAuthorizationId: "learned-authorization-1",
        operation: "DELETE_LEARNED"
      },
      path: "/api/me/memory/bulk-delete"
    });
    expect(useMemoryHistorySearchStore.getState().results).toHaveLength(1);
    expect(JSON.parse(sessionStorage.getItem("aiqsa:memory:operations:v1:account-a") ?? "null"))
      .toEqual({
        allDeletionId: null,
        clearDeletionId: null,
        learnedDeletionId: "learned-delete-1",
        rebuildJobId: null,
        version: 3
      });
    expect(useMemoryOperationsStore.getState()).toMatchObject({
      confirmation: null,
      learnedStatus: deletion
    });

    deactivateMemoryOperationsAccount("account-a");
    await activateMemoryOperationsAccount("account-a");
    expect(useMemoryOperationsStore.getState().learnedStatus).toMatchObject({
      deletionId: "learned-delete-1",
      state: "SUCCEEDED"
    });
  });

  it("resets every Memory gate, invalidates private caches, and restores all-data status", async () => {
    const before = memorySettingsFixture({
      settings: {
        learnAutomatically: true,
        referenceChatHistory: true,
        useMemoryFacts: true
      }
    });
    const after = memorySettingsFixture({
      settings: {
        learnAutomatically: false,
        memoryGeneration: before.settings.memoryGeneration + 1,
        memoryRevision: before.settings.memoryRevision + 1,
        referenceChatHistory: false,
        settingsRevision: before.settings.settingsRevision + 1,
        useMemoryFacts: false
      }
    });
    const deletion = memoryDeletionFixture({
      deletionId: "all-reusable-delete-1",
      memoryGeneration: after.settings.memoryGeneration,
      memoryRevision: after.settings.memoryRevision,
      operation: "DELETE_ALL_REUSABLE",
      settingsRevision: after.settings.settingsRevision,
      totalUnits: 11
    });
    const calls: Array<{ body: Record<string, unknown> | null; path: string }> = [];
    let settingsLoads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
      calls.push({ body, path });
      if (path === "/api/me/memory/settings") {
        settingsLoads += 1;
        return json(settingsLoads === 1 ? before : after);
      }
      if (path === "/api/me/memory/mutation-authorizations") {
        return json({
          expiresAt: "2026-08-10T08:05:00.000Z",
          mutationAuthorizationId: "all-reusable-authorization-1"
        }, 201);
      }
      if (path === "/api/me/memory/bulk-delete") return json(deletion, 202);
      if (path === "/api/me/memory/deletions/all-reusable-delete-1") {
        return json({
          ...deletion,
          completedUnits: 11,
          lastAuditAt: "2026-08-10T08:10:00.000Z",
          state: "SUCCEEDED"
        });
      }
      throw new Error(`unexpected request: ${path}`);
    }));

    await activateMemoryOperationsAccount("account-a");
    useMemoryHistorySearchStore.setState({
      accountId: "account-a",
      loadState: "ready",
      nextCursor: "private-cursor",
      results: [{
        indexingState: "LEXICAL_READY",
        itemType: "RECALL_CHUNK",
        occurredAt: "2026-08-10T08:00:00.000Z",
        sourceChatId: "chat-retained",
        sourceChatTitle: "Retained",
        sourceFolderId: null,
        sourceFolderName: null,
        sourceMessageIds: ["message-retained"],
        sourceState: "AVAILABLE",
        snippet: "Private projection"
      }]
    });
    useMemoryManagerStore.setState({
      listLoadState: "ready",
      memories: [memorySummaryFixture()]
    });
    selectMemoryOperation("DELETE_ALL_REUSABLE");
    await confirmSelectedMemoryOperation();

    expect(calls[1]?.body).toMatchObject({
      action: "BULK_DELETE",
      expectedMemoryRevision: before.settings.memoryRevision,
      expectedSettingsRevision: before.settings.settingsRevision,
      operation: "DELETE_ALL_REUSABLE"
    });
    expect(calls[2]).toEqual({
      body: {
        expectedMemoryRevision: before.settings.memoryRevision,
        expectedSettingsRevision: before.settings.settingsRevision,
        mutationAuthorizationId: "all-reusable-authorization-1",
        operation: "DELETE_ALL_REUSABLE"
      },
      path: "/api/me/memory/bulk-delete"
    });
    expect(useMemoryHistorySearchStore.getState()).toMatchObject({
      nextCursor: null,
      results: []
    });
    expect(useMemoryManagerStore.getState()).toMatchObject({
      listLoadState: "idle",
      memories: []
    });
    expect(useMemoryOperationsStore.getState()).toMatchObject({
      allStatus: deletion,
      confirmation: null
    });
    expect(JSON.parse(sessionStorage.getItem("aiqsa:memory:operations:v1:account-a") ?? "null"))
      .toEqual({
        allDeletionId: "all-reusable-delete-1",
        clearDeletionId: null,
        learnedDeletionId: null,
        rebuildJobId: null,
        version: 3
      });

    deactivateMemoryOperationsAccount("account-a");
    await activateMemoryOperationsAccount("account-a");
    expect(useMemoryOperationsStore.getState().allStatus).toMatchObject({
      deletionId: "all-reusable-delete-1",
      operation: "DELETE_ALL_REUSABLE",
      state: "SUCCEEDED"
    });
    expect(sessionStorage.getItem("aiqsa:memory:operations:v1:account-a")).toBeNull();
  });

  it("preserves an exact confirmation after a stale CAS and never reports optimistic success", async () => {
    const settings = memorySettingsFixture({ settings: { referenceChatHistory: true } });
    const calls: Record<string, unknown>[] = [];
    let settingsLoads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/me/memory/settings") {
        settingsLoads += 1;
        return json(memorySettingsFixture({
          settings: {
            ...settings.settings,
            memoryRevision: settings.settings.memoryRevision + settingsLoads - 1,
            referenceChatHistory: true
          }
        }));
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push(body);
      if (path === "/api/me/memory/mutation-authorizations") {
        return json({
          expiresAt: "2026-08-10T08:05:00.000Z",
          mutationAuthorizationId: "stale-clear-authorization"
        }, 201);
      }
      if (path === "/api/me/memory/bulk-delete") {
        return json({ error: "memory_version_stale" }, 409);
      }
      throw new Error(`unexpected request: ${path}`);
    }));

    await activateMemoryOperationsAccount("account-a");
    selectMemoryOperation("CLEAR_HISTORY_INDEX");
    await expect(confirmSelectedMemoryOperation()).rejects.toMatchObject({
      code: "memory_version_stale"
    });

    expect(calls[0]).toMatchObject({ operation: "CLEAR_HISTORY_INDEX" });
    expect(calls[1]).toMatchObject({
      mutationAuthorizationId: "stale-clear-authorization",
      operation: "CLEAR_HISTORY_INDEX"
    });
    expect(settingsLoads).toBe(2);
    expect(useMemoryOperationsStore.getState()).toMatchObject({
      busy: null,
      clearStatus: null,
      confirmation: "CLEAR_HISTORY_INDEX",
      confirmationError: "memory_version_stale"
    });
  });

  it("starts exact re-embed without a broad grant, authorizes redream once, and cancels only the shadow", async () => {
    const settings = memorySettingsFixture({ settings: { referenceChatHistory: true } });
    const reembed = memoryRebuildFixture({
      jobId: "reembed-1",
      operation: "REEMBED",
      state: "RUNNING",
      totalUnits: 8
    });
    const redream = memoryRebuildFixture({
      jobId: "redream-1",
      operation: "REDREAM_EXISTING_CHATS"
    });
    const calls: Array<{ body: Record<string, unknown> | null; method: string; path: string }> = [];
    let rebuildStarts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
      calls.push({ body, method, path });
      if (path === "/api/me/memory/settings") return json(settings);
      if (path === "/api/me/memory/mutation-authorizations") {
        return json({
          expiresAt: "2026-08-10T08:05:00.000Z",
          mutationAuthorizationId: "redream-authorization-1"
        }, 201);
      }
      if (path === "/api/me/memory/rebuild") {
        rebuildStarts += 1;
        return json(rebuildStarts === 1 ? reembed : redream, 202);
      }
      if (path === "/api/me/memory/rebuild/reembed-1/cancel") {
        return json({ ...reembed, state: "CANCELLED" });
      }
      throw new Error(`unexpected request: ${path}`);
    }));

    await activateMemoryOperationsAccount("account-a");
    selectMemoryOperation("REEMBED");
    await confirmSelectedMemoryOperation();
    const firstRebuild = calls.find((call) =>
      call.path === "/api/me/memory/rebuild" && call.body?.operation === "REEMBED"
    );
    expect(firstRebuild?.body).toEqual({
      embeddingDeploymentId: "embedding-model-1",
      expectedMemoryRevision: settings.settings.memoryRevision,
      expectedSettingsRevision: settings.settings.settingsRevision,
      operation: "REEMBED"
    });
    expect(calls.filter((call) => call.path === "/api/me/memory/mutation-authorizations"))
      .toHaveLength(0);

    await cancelActiveMemoryRebuild();
    expect(calls.at(-1)).toEqual({
      body: null,
      method: "POST",
      path: "/api/me/memory/rebuild/reembed-1/cancel"
    });
    expect(useMemoryOperationsStore.getState().rebuildStatus?.state).toBe("CANCELLED");

    selectMemoryOperation("REDREAM_EXISTING_CHATS");
    await confirmSelectedMemoryOperation();
    expect(calls.filter((call) => call.path === "/api/me/memory/mutation-authorizations"))
      .toHaveLength(1);
    expect(calls.find((call) => call.path === "/api/me/memory/mutation-authorizations")?.body)
      .toMatchObject({
        action: "BULK_DELETE",
        operation: "REDREAM_EXISTING_CHATS"
      });
    expect(calls.filter((call) => call.path === "/api/me/memory/rebuild").at(-1)?.body)
      .toMatchObject({
        mutationAuthorizationId: "redream-authorization-1",
        operation: "REDREAM_EXISTING_CHATS"
      });
  });

  it("discards a late operation response when the exact account changes", async () => {
    const settings = memorySettingsFixture({ settings: { referenceChatHistory: true } });
    let resolveRebuild!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/me/memory/settings") return json(settings);
      if (path === "/api/me/memory/rebuild") {
        return new Promise<Response>((resolve) => { resolveRebuild = resolve; });
      }
      throw new Error(`unexpected request: ${path}`);
    }));

    await activateMemoryOperationsAccount("account-a");
    selectMemoryOperation("REBUILD_SEARCH_INDEX");
    const pending = confirmSelectedMemoryOperation();
    await vi.waitFor(() => expect(resolveRebuild).toBeTypeOf("function"));
    await activateMemoryOperationsAccount("account-b");
    resolveRebuild(json(memoryRebuildFixture({ jobId: "account-a-job" }), 202));
    await pending;

    expect(useMemoryOperationsStore.getState()).toMatchObject({
      accountId: "account-b",
      busy: null,
      rebuildStatus: null
    });
  });
});
