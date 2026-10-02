import { Prisma } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  memoryDeletionFixture,
  memoryDetailFixture,
  memorySettingsFixture,
  memorySummaryFixture
} from "@/tests/support/memoryFixtures";
import { createMemoryConsumerService, MemoryConsumerServiceError } from "./service";
import type { MemoryConsumerRefService } from "./ref";
import { ExplicitMemoryServiceError } from "../explicit/service";
import { MemoryForgetCommittedResponseError, MemoryLifecycleServiceError } from "../lifecycle/service";
import { rememberMemoryForgetPeerCascade } from "../lifecycle/sourcePreservation";
import { MemoryPersistenceError, rememberMemoryPersistenceFailure } from "../persistence/errors";
import { MEMORY_CONSUMER_CATEGORIES } from "../../../contracts/memoryConsumer";
import { logEvent, type LifecycleFields } from "../../observability";
import { rememberDatabaseFailure } from "../../observability/databaseFailure";
import { serializeEvent } from "../../observability/runtime.cjs";

vi.mock("../../observability", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../observability")>(),
  logEvent: vi.fn()
}));

const now = new Date("2026-08-21T10:00:00.000Z");

function refs(): MemoryConsumerRefService {
  return {
    mintCursor: vi.fn(() => "opaque-cursor-ref"),
    mintItem: vi.fn(() => "opaque-item-ref"),
    resolveCursor: vi.fn(() => "internal-repository-cursor"),
    resolveItem: vi.fn(() => ({
      factId: "internal-fact-id",
      factVersionId: "internal-version-id"
    }))
  };
}

function dependencies(input: Readonly<{
  resetState?: "CANCELLED" | "PENDING" | "RUNNING" | "SUCCEEDED" | null;
}> = {}) {
  const summary = memorySummaryFixture({
    currentVersionId: "internal-version-id",
    id: "internal-fact-id",
    sensitivityClass: "SENSITIVE",
    sourceMode: "AUTOMATIC"
  });
  const settings = memorySettingsFixture({
    historyIndexing: { state: "READY" },
    settings: {
      learnAutomatically: true,
      referenceChatHistory: true,
      useMemoryFacts: true
    }
  });
  return {
    explicitService: {
      create: vi.fn(async () => ({ memory: summary })),
      get: vi.fn(async () => memoryDetailFixture(summary)),
      list: vi.fn(async () => ({ memories: [summary], nextCursor: "internal-cursor" as string | null })),
      mintAuthorization: vi.fn(async (
        _userId: string,
        _input: unknown,
        _context?: unknown
      ) => ({
        expiresAt: "2026-08-21T10:05:00.000Z",
        mutationAuthorizationId: "internal-authorization-id"
      })),
      search: vi.fn(async () => ({ memories: [summary], nextCursor: null })),
      update: vi.fn(async () => ({ memory: { ...summary, displayText: "Updated statement" } }))
    },
    lifecycleService: {
      deleteExplicit: vi.fn(async () => memoryDeletionFixture({
        deletionId: "internal-deletion-id",
        operation: "DELETE_ALL_REUSABLE",
        state: "PENDING"
      })),
      forget: vi.fn(async () => ({ memory: summary }))
    },
    readResetState: vi.fn(async () => input.resetState ?? null),
    settings,
    settingsService: {
      get: vi.fn(async () => settings),
      patch: vi.fn(async () => settings)
    }
  };
}

describe("Memory consumer service", () => {
  it("lists every memory with Edit and Forget and never a combination block", async () => {
    const deps = dependencies();
    const service = createMemoryConsumerService({
      clock: () => now,
      explicitService: deps.explicitService as never,
      lifecycleService: deps.lifecycleService as never,
      readResetState: deps.readResetState,
      refs: refs(),
      settingsService: deps.settingsService as never
    });
    const listed = await service.list("user-1", {});
    expect(listed.items[0]).toMatchObject({ allowedActions: ["EDIT", "FORGET"] });
    expect(listed.items[0]).not.toHaveProperty("combined");
    await service.list("user-1", {}, { authority: "DELEGATED_MCP" });
    await service.search("user-1", { query: "workflow" }, { authority: "DELEGATED_MCP" });
    const withoutPatternOptIn = expect.not.objectContaining({ includePatterns: expect.anything() });
    expect(deps.explicitService.list).toHaveBeenLastCalledWith("user-1", withoutPatternOptIn);
    expect(deps.explicitService.search).toHaveBeenLastCalledWith("user-1", withoutPatternOptIn);
  });

  it("resolves equivalent references before reading or minting exact mutation authority", async () => {
    const deps = dependencies();
    const refService = refs();
    vi.mocked(refService.resolveItem).mockReturnValue({ factId: "alias", factVersionId: "alias-version" });
    const resolveEquivalentTarget = vi.fn(async () => ({
      factId: "internal-fact-id", factVersionId: "internal-version-id"
    }));
    const service = createMemoryConsumerService({
      clock: () => now, explicitService: deps.explicitService as never,
      lifecycleService: deps.lifecycleService as never, readResetState: deps.readResetState,
      refs: refService, resolveEquivalentTarget, settingsService: deps.settingsService as never
    });
    await service.get("user-1", "opaque-alias");
    await service.edit("user-1", "opaque-alias", { requestId: "edit-alias", statement: "Nuevo dato" });
    await service.forget("user-1", "opaque-alias", { requestId: "forget-alias" });
    expect(resolveEquivalentTarget).toHaveBeenCalledWith("user-1", { factId: "alias", factVersionId: "alias-version" }, now);
    expect(deps.explicitService.get).toHaveBeenCalledWith("user-1", "internal-fact-id");
    for (const action of ["EDIT", "FORGET"]) {
      expect(deps.explicitService.mintAuthorization).toHaveBeenCalledWith("user-1", expect.objectContaining({
        action, targetFactId: "internal-fact-id", expectedTargetVersionId: "internal-version-id"
      }), expect.anything());
    }
    expect(deps.explicitService.update).toHaveBeenCalledWith("user-1", "internal-fact-id", expect.objectContaining({ expectedVersionId: "internal-version-id" }));
    expect(deps.lifecycleService.forget).toHaveBeenCalledWith("user-1", "internal-fact-id", expect.objectContaining({ expectedVersionId: "internal-version-id" }));
    vi.mocked(refService.resolveItem).mockReturnValue(null);
    resolveEquivalentTarget.mockClear();
    await expect(service.get("user-1", "invalid-ref")).rejects.toMatchObject({ code: "memory_not_found" });
    expect(resolveEquivalentTarget).not.toHaveBeenCalled();
  });

  it("still rejects a changed canonical version after equivalent-reference resolution", async () => {
    const deps = dependencies();
    const service = createMemoryConsumerService({
      clock: () => now, explicitService: deps.explicitService as never,
      lifecycleService: deps.lifecycleService as never, readResetState: deps.readResetState,
      refs: refs(), settingsService: deps.settingsService as never,
      resolveEquivalentTarget: async () => ({ factId: "internal-fact-id", factVersionId: "older-canonical-version" })
    });
    await expect(service.get("user-1", "old-ref")).rejects.toMatchObject({ code: "memory_changed" });
  });

  it("projects settings and items without persistence or control-plane fields", async () => {
    const deps = dependencies();
    const refService = refs();
    const service = createMemoryConsumerService({
      clock: () => now,
      explicitService: deps.explicitService as never,
      lifecycleService: deps.lifecycleService as never,
      readResetState: deps.readResetState,
      refs: refService,
      settingsService: deps.settingsService as never
    });

    const [settings, item, list, search] = await Promise.all([
      service.settings("user-1"),
      service.get("user-1", "opaque-item-ref"),
      service.list("user-1", { pageSize: 20 }),
      service.search("user-1", { pageSize: 20, query: "concise" })
    ]);

    expect(settings).toEqual({
      capabilities: {
        automaticLearningAvailable: true,
        decayAvailable: true,
        managementAvailable: true,
        naturalLanguageActionsAvailable: true,
        permanentChatDeletion: false,
        pastChatIndexingAvailable: true,
        retrievalAvailable: true,
        synthesisAvailable: true,
        temporaryChats: true
      },
      resetState: "IDLE",
      settings: {
        decayEnabled: false,
        learnAutomatically: true,
        referenceChatHistory: true,
        synthesisEnabled: false,
        useMemoryFacts: true
      },
      status: "ON"
    });
    expect(list).toEqual({
      items: [expect.objectContaining({
        allowedActions: ["EDIT", "FORGET"],
        memoryRef: "opaque-item-ref",
        provenance: "LEARNED"
      })],
      nextCursor: "opaque-cursor-ref"
    });
    expect(search.items[0]?.memoryRef).toBe("opaque-item-ref");
    expect(item.item).toMatchObject({
      memoryRef: "opaque-item-ref",
      statement: expect.any(String)
    });
    expect(refService.mintItem).toHaveBeenCalledWith("user-1", expect.objectContaining({
      allowedOperations: ["READ", "EDIT", "FORGET"]
    }), now);

    const browserJson = JSON.stringify({ item, list, search, settings });
    expect(browserJson).not.toMatch(
      /internal-|memoryRevision|settingsRevision|generation|deployment|fingerprint|score|hash/iu
    );
  });

  it("keeps decay policy authority server-side while projecting its safe toggle", async () => {
    const deps = dependencies();
    deps.settingsService.patch.mockResolvedValue(memorySettingsFixture({
      settings: {
        decayEnabled: true,
        learnAutomatically: true,
        referenceChatHistory: true,
        useMemoryFacts: true
      }
    }));
    const service = createMemoryConsumerService({
      clock: () => now,
      explicitService: deps.explicitService as never,
      lifecycleService: deps.lifecycleService as never,
      readResetState: deps.readResetState,
      refs: refs(),
      settingsService: deps.settingsService as never
    });

    await expect(service.patchSettings("user-1", { decayEnabled: true }))
      .resolves.toMatchObject({ settings: { decayEnabled: true } });
    expect(deps.settingsService.patch).toHaveBeenCalledWith("user-1", {
      decayEnabled: true,
      expectedMemoryRevision: 8,
      expectedSettingsRevision: 12
    });
    expect(JSON.stringify(await service.settings("user-1")))
      .not.toMatch(/decayPolicyVersion|memoryRevision|settingsRevision/iu);
  });

  it("applies category and provenance before repository pagination", async () => {
    const deps = dependencies();
    const service = createMemoryConsumerService({
      clock: () => now,
      explicitService: deps.explicitService as never,
      lifecycleService: deps.lifecycleService as never,
      readResetState: deps.readResetState,
      refs: refs(),
      settingsService: deps.settingsService as never
    });

    await service.list("user-1", {
      category: "CONSTRAINTS_AND_ROUTINES",
      pageSize: 7,
      provenance: "LEARNED"
    });
    await service.search("user-1", {
      category: "ABOUT_YOU",
      provenance: "SAVED",
      query: "medical accommodation"
    });

    expect(deps.explicitService.list).toHaveBeenCalledWith("user-1", {
      category: "constraints_routines",
      cursor: null,
      pageSize: 7,
      scope: { type: "GLOBAL_USER" },
      sourceMode: "AUTOMATIC",
      state: "ACTIVE"
    });
    expect(deps.explicitService.search).toHaveBeenCalledWith("user-1", {
      category: "about_you",
      cursor: null,
      pageSize: undefined,
      query: "medical accommodation",
      scope: { type: "GLOBAL_USER" },
      sourceMode: "EXPLICIT",
      state: "ACTIVE"
    });
  });

  it("round-trips every canonical category through filters and item projection", async () => {
    const deps = dependencies();
    const service = createMemoryConsumerService({
      clock: () => now,
      explicitService: deps.explicitService as never,
      lifecycleService: deps.lifecycleService as never,
      readResetState: deps.readResetState,
      refs: refs(),
      settingsService: deps.settingsService as never
    });
    const storageCategories = [
      "about_you", "preferences", "work", "goals", "constraints_routines", "other"
    ] as const;

    for (const [index, stored] of storageCategories.entries()) {
      const category = MEMORY_CONSUMER_CATEGORIES[index]!;
      const summary = memorySummaryFixture({
        category: stored,
        sourceMode: index % 2 === 0 ? "AUTOMATIC" : "EXPLICIT"
      });
      deps.explicitService.list.mockResolvedValueOnce({ memories: [summary], nextCursor: null });
      const result = await service.list("user-1", { category });

      expect(deps.explicitService.list).toHaveBeenLastCalledWith("user-1", expect.objectContaining({
        category: stored
      }));
      expect(result.items).toEqual([expect.objectContaining({
        category,
        provenance: index % 2 === 0 ? "LEARNED" : "SAVED"
      })]);
    }
  });

  it("projects the legacy constraints alias without changing provenance", async () => {
    const deps = dependencies();
    deps.explicitService.list.mockResolvedValueOnce({
      memories: [memorySummaryFixture({
        category: "constraints_and_routines",
        sourceMode: "EXPLICIT"
      })],
      nextCursor: null
    });
    const service = createMemoryConsumerService({
      clock: () => now,
      explicitService: deps.explicitService as never,
      lifecycleService: deps.lifecycleService as never,
      readResetState: deps.readResetState,
      refs: refs(),
      settingsService: deps.settingsService as never
    });

    expect((await service.list("user-1", {})).items).toEqual([
      expect.objectContaining({ category: "CONSTRAINTS_AND_ROUTINES", provenance: "SAVED" })
    ]);
  });

  it("keeps available Memory on while history indexing runs in the background", async () => {
    const deps = dependencies();
    const indexing = memorySettingsFixture({
      historyIndexing: { state: "INDEXING" },
      settings: {
        learnAutomatically: true,
        referenceChatHistory: true,
        useMemoryFacts: true
      }
    });
    deps.settingsService.get.mockResolvedValue(indexing);
    deps.settingsService.patch.mockResolvedValue(indexing);
    const service = createMemoryConsumerService({
      clock: () => now,
      explicitService: deps.explicitService as never,
      lifecycleService: deps.lifecycleService as never,
      readResetState: deps.readResetState,
      refs: refs(),
      settingsService: deps.settingsService as never
    });

    await expect(service.settings("user-1")).resolves.toMatchObject({ status: "ON" });
    await expect(service.patchSettings("user-1", {
      referenceChatHistory: true
    })).resolves.toMatchObject({ status: "ON" });
    deps.settingsService.get.mockResolvedValue(memorySettingsFixture({
      historyIndexing: { state: "INDEXING" },
      settings: { useMemoryFacts: false }
    }));
    await expect(service.settings("user-1")).resolves.toMatchObject({ status: "PAUSED" });
  });

  it("projects unavailable System Model capabilities to a friendly unavailable status", async () => {
    const deps = dependencies();
    deps.settingsService.get.mockResolvedValue(memorySettingsFixture({
      capabilities: { administratorSetupRequired: true, retrievalAvailable: false },
      historyIndexing: { state: "INDEXING" },
      settings: { useMemoryFacts: true }
    }));
    const service = createMemoryConsumerService({
      clock: () => now,
      explicitService: deps.explicitService as never,
      lifecycleService: deps.lifecycleService as never,
      readResetState: deps.readResetState,
      refs: refs(),
      settingsService: deps.settingsService as never
    });

    const settings = await service.settings("user-1");

    expect(settings.status).toBe("NEEDS_ADMIN_SETUP");
    expect(JSON.stringify(settings)).not.toMatch(/egress|fingerprint|destination|deployment/iu);
  });

  it("projects each v1 capability independently while manual management stays usable", async () => {
    for (const capability of [
      "naturalLanguageActionsAvailable",
      "retrievalAvailable",
      "automaticLearningAvailable",
      "pastChatIndexingAvailable",
      "synthesisAvailable",
      "decayAvailable"
    ] as const) {
      const deps = dependencies();
      deps.settingsService.get.mockResolvedValue(memorySettingsFixture({
        capabilities: { [capability]: false },
        historyIndexing: { state: "INDEXING" },
        settings: {
          decayEnabled: true,
          learnAutomatically: true,
          referenceChatHistory: true,
          useMemoryFacts: true
        }
      }));
      const service = createMemoryConsumerService({
        clock: () => now,
        explicitService: deps.explicitService as never,
        lifecycleService: deps.lifecycleService as never,
        readResetState: deps.readResetState,
        refs: refs(),
        settingsService: deps.settingsService as never
      });

      await expect(service.settings("user-1")).resolves.toMatchObject({
        capabilities: {
          [capability]: false,
          managementAvailable: true
        },
        status: "UNAVAILABLE"
      });
    }

    const deps = dependencies();
    deps.settingsService.get.mockResolvedValue(memorySettingsFixture({
      capabilities: {
        administratorSetupRequired: true,
        retrievalAvailable: false
      },
      settings: { useMemoryFacts: true }
    }));
    const service = createMemoryConsumerService({
      clock: () => now,
      explicitService: deps.explicitService as never,
      lifecycleService: deps.lifecycleService as never,
      readResetState: deps.readResetState,
      refs: refs(),
      settingsService: deps.settingsService as never
    });
    await expect(service.settings("user-1")).resolves.toMatchObject({
      capabilities: {
        managementAvailable: true,
        retrievalAvailable: false
      },
      status: "NEEDS_ADMIN_SETUP"
    });
  });

  it("reports unavailable maintenance only while automatic learning is on", async () => {
    for (const [learnAutomatically, status] of [[true, "UNAVAILABLE"], [false, "ON"]] as const) {
      const deps = dependencies();
      deps.settingsService.get.mockResolvedValue(memorySettingsFixture({
        capabilities: { synthesisAvailable: false },
        historyIndexing: { state: "READY" },
        settings: { learnAutomatically, referenceChatHistory: true, useMemoryFacts: true }
      }));
      const service = createMemoryConsumerService({
        clock: () => now,
        explicitService: deps.explicitService as never,
        lifecycleService: deps.lifecycleService as never,
        readResetState: deps.readResetState,
        refs: refs(),
        settingsService: deps.settingsService as never
      });
      await expect(service.settings("user-1")).resolves.toMatchObject({
        capabilities: { synthesisAvailable: false },
        settings: { synthesisEnabled: false },
        status
      });
    }
  });

  it("preserves classifier outages as a consumer-safe unavailable failure", async () => {
    const deps = dependencies();
    deps.explicitService.create.mockRejectedValueOnce(
      new ExplicitMemoryServiceError("memory_unavailable")
    );
    const service = createMemoryConsumerService({
      clock: () => now,
      explicitService: deps.explicitService as never,
      lifecycleService: deps.lifecycleService as never,
      readResetState: deps.readResetState,
      refs: refs(),
      settingsService: deps.settingsService as never
    });

    await expect(service.create("user-1", {
      requestId: "request-id-classifier-unavailable",
      statement: "Remember this statement"
    })).rejects.toMatchObject({ code: "memory_unavailable" });
  });

  it("keeps mutation authority server-side and returns only opaque action results", async () => {
    const deps = dependencies();
    const service = createMemoryConsumerService({
      clock: () => now,
      explicitService: deps.explicitService as never,
      lifecycleService: deps.lifecycleService as never,
      readResetState: deps.readResetState,
      refs: refs(),
      settingsService: deps.settingsService as never
    });

    const created = await service.create("user-1", {
      requestId: "request-id-0000000001",
      statement: "Remember this statement"
    });
    const edited = await service.edit("user-1", "opaque-item-ref", {
      requestId: "request-id-0000000002",
      statement: "Updated statement"
    });
    const forgotten = await service.forget("user-1", "opaque-item-ref", {
      requestId: "request-id-0000000003"
    });

    expect(created.item.memoryRef).toBe("opaque-item-ref");
    expect(edited.item).toMatchObject({
      memoryRef: "opaque-item-ref",
      statement: "Updated statement"
    });
    expect(forgotten).toEqual({ status: "FORGOTTEN" });
    expect(deps.explicitService.mintAuthorization).toHaveBeenCalledTimes(3);
    expect(deps.explicitService.mintAuthorization.mock.calls.map((call) => call[2]))
      .toEqual([
        { origin: "DIRECT_API" },
        { origin: "DIRECT_API" },
        { origin: "DIRECT_API" }
      ]);
    expect(deps.explicitService.update).toHaveBeenCalledWith(
      "user-1",
      "internal-fact-id",
      expect.objectContaining({
        expectedVersionId: "internal-version-id",
        mutationAuthorizationId: "internal-authorization-id"
      })
    );
    expect(JSON.stringify({ created, edited, forgotten })).not.toContain("internal-");
  });

  it("uses delegated mutation authority only when the server supplies that context", async () => {
    const deps = dependencies();
    const service = createMemoryConsumerService({
      clock: () => now,
      explicitService: deps.explicitService as never,
      lifecycleService: deps.lifecycleService as never,
      readResetState: deps.readResetState,
      refs: refs(),
      settingsService: deps.settingsService as never
    });

    await service.create("user-1", {
      requestId: "request-id-delegated-0001",
      statement: "Remember this from an OAuth-authorized MCP call"
    }, { authority: "DELEGATED_MCP" });

    expect(deps.explicitService.mintAuthorization).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ action: "SAVE" }),
      { origin: "DELEGATED_MCP" }
    );
    await expect(service.create("user-1", {
      requestId: "request-id-invalid-context",
      statement: "This must not be authorized"
    }, { authority: "MODEL_PROPOSAL" } as never)).rejects.toMatchObject({
      code: "memory_contract_invalid"
    });
    expect(deps.explicitService.mintAuthorization).toHaveBeenCalledTimes(1);
  });

  it("revalidates exact current fact state for get", async () => {
    const deps = dependencies();
    const refService = refs();
    const service = createMemoryConsumerService({
      clock: () => now,
      explicitService: deps.explicitService as never,
      lifecycleService: deps.lifecycleService as never,
      readResetState: deps.readResetState,
      refs: refService,
      settingsService: deps.settingsService as never
    });

    await expect(service.get("user-1", "opaque-item-ref")).resolves.toMatchObject({
      item: { memoryRef: "opaque-item-ref" }
    });
    deps.explicitService.get.mockResolvedValueOnce(memoryDetailFixture(memorySummaryFixture({
      currentVersionId: "new-version-id",
      id: "internal-fact-id"
    })));
    await expect(service.get("user-1", "opaque-item-ref")).rejects.toMatchObject({
      code: "memory_changed"
    });
    vi.mocked(refService.resolveItem).mockReturnValueOnce(null);
    await expect(service.get("other-user", "opaque-item-ref")).rejects.toMatchObject({
      code: "memory_not_found"
    });
  });

  it("reports only active reset work and does not persist a misleading Complete badge", async () => {
    const completeDeps = dependencies({ resetState: "SUCCEEDED" });
    const completeService = createMemoryConsumerService({
      clock: () => now,
      explicitService: completeDeps.explicitService as never,
      lifecycleService: completeDeps.lifecycleService as never,
      readResetState: completeDeps.readResetState,
      refs: refs(),
      settingsService: completeDeps.settingsService as never
    });
    await expect(completeService.settings("user-1")).resolves.toMatchObject({
      resetState: "IDLE"
    });

    const activeDeps = dependencies({ resetState: "RUNNING" });
    const activeService = createMemoryConsumerService({
      clock: () => now,
      explicitService: activeDeps.explicitService as never,
      lifecycleService: activeDeps.lifecycleService as never,
      readResetState: activeDeps.readResetState,
      refs: refs(),
      settingsService: activeDeps.settingsService as never
    });
    await expect(activeService.settings("user-1")).resolves.toMatchObject({
      resetState: "IN_PROGRESS"
    });
    await expect(activeService.reset("user-1", {
      confirmationCopyVersion: "memory-confirmation-v1",
      requestId: "request-id-0000000004"
    })).resolves.toEqual({ status: "IN_PROGRESS" });
    expect(activeDeps.explicitService.mintAuthorization).not.toHaveBeenCalled();
  });
});

describe("Memory consumer Forget diagnostics", () => {
  const CANARY = "PRIVATE_CANARY_6f1c";

  afterEach(() => {
    vi.mocked(logEvent).mockReset();
  });

  function forgetService(failure?: unknown, resolved?: unknown) {
    const deps = dependencies();
    if (failure !== undefined) deps.lifecycleService.forget.mockRejectedValueOnce(failure);
    if (resolved !== undefined) deps.lifecycleService.forget.mockResolvedValueOnce(resolved as never);
    const service = createMemoryConsumerService({
      clock: () => now,
      explicitService: deps.explicitService as never,
      lifecycleService: deps.lifecycleService as never,
      readResetState: deps.readResetState,
      refs: refs(),
      settingsService: deps.settingsService as never
    });
    return { deps, service };
  }

  function events() {
    return vi.mocked(logEvent).mock.calls.filter(([event]) => event === "service_operation")
      .map(([, fields]) => fields as LifecycleFields);
  }

  function hostile(error: Error): Error {
    return Object.assign(error, { cause: CANARY, code: CANARY, meta: { statement: CANARY }, name: CANARY, stack: CANARY });
  }

  it.each([
    ["a retained persistence reason", () => {
      const error = new MemoryLifecycleServiceError("memory_action_failed");
      rememberMemoryPersistenceFailure(error, "memory_forget_peer_retrieval_inexact");
      return error;
    }, "memory_forget_peer_retrieval_inexact", "unknown"],
    ["a lifecycle failure without a retained reason", () =>
      new MemoryLifecycleServiceError("memory_action_failed"), "memory_forget_failed", "unknown"],
    ["a forged lifecycle code", () =>
      hostile(new MemoryLifecycleServiceError(CANARY as never)), "memory_forget_failed", "unknown"],
    ["a forged persistence code", () =>
      hostile(new MemoryPersistenceError(CANARY as never)), "memory_forget_failed", "unknown"],
    ["a raw Prisma timeout", () => new Prisma.PrismaClientKnownRequestError(CANARY, {
      clientVersion: "test", code: "P2028", meta: { statement: CANARY }
    }), "memory_forget_database_failed", "P2028"],
    ["a Prisma error with a forged code", () => new Prisma.PrismaClientKnownRequestError(CANARY, {
      clientVersion: "test", code: CANARY, meta: { statement: CANARY }
    }), "memory_forget_failed", "unknown"],
    ["a database failure retained at the transaction boundary", () => {
      const error = hostile(new Error(CANARY));
      rememberDatabaseFailure(error, "P2034");
      return error;
    }, "memory_forget_database_failed", "P2034"],
    ["a generic exception", () => hostile(new TypeError(CANARY)), "memory_forget_failed", "unknown"]
  ])("records %s as one content-free failure and returns the safe code", async (_label, make, code, prismaCode) => {
    const { deps, service } = forgetService(make());
    const error = await service.forget("user-1", "opaque-item-ref", { requestId: "request-id-forget-0001" })
      .catch((caught: unknown) => caught);
    expect(error).toEqual(new MemoryConsumerServiceError("memory_action_failed"));
    expect(JSON.stringify(error)).not.toContain(CANARY);
    expect(events()).toEqual([{ action: "fail", code, outcome: "failed", prisma_code: prismaCode,
      stage: "delete", subsystem: "memory" }]);
    const line = serializeEvent("service_operation", events()[0]!);
    expect(JSON.parse(line!)).toMatchObject({ code, event: "service_operation", level: "error", prisma_code: prismaCode });
    expect(line).not.toContain(CANARY);
    expect(line).not.toContain("internal-");
    expect(deps.lifecycleService.forget).toHaveBeenCalledOnce();
  });

  it("records expected conflicts and missing targets below the failure class", async () => {
    const stale = forgetService(new MemoryLifecycleServiceError("memory_version_stale"));
    await expect(stale.service.forget("user-1", "opaque-item-ref", { requestId: "request-id-forget-0002" }))
      .rejects.toEqual(new MemoryConsumerServiceError("memory_changed"));
    const staleRef = refs();
    vi.mocked(staleRef.resolveItem).mockReturnValueOnce(null);
    const missing = createMemoryConsumerService({
      clock: () => now,
      explicitService: stale.deps.explicitService as never,
      lifecycleService: stale.deps.lifecycleService as never,
      readResetState: stale.deps.readResetState,
      refs: staleRef,
      settingsService: stale.deps.settingsService as never
    });
    await expect(missing.forget("user-1", "unknown-ref", { requestId: "request-id-forget-0003" }))
      .rejects.toEqual(new MemoryConsumerServiceError("memory_not_found"));
    expect(events()).toEqual([
      { action: "skip", code: "memory_version_stale", outcome: "stale", prisma_code: "unknown", stage: "delete", subsystem: "memory" },
      { action: "skip", code: "memory_not_found", outcome: "skipped", prisma_code: "unknown", stage: "delete", subsystem: "memory" }
    ]);
    expect(JSON.parse(serializeEvent("service_operation", events()[0]!)!)).toMatchObject({ level: "info" });
  });

  it("returns FORGOTTEN with a degraded event when only the committed response projection failed", async () => {
    const { deps, service } = forgetService(new MemoryForgetCommittedResponseError());
    await expect(service.forget("user-1", "opaque-item-ref", { requestId: "request-id-forget-0004" }))
      .resolves.toEqual({ status: "FORGOTTEN" });
    expect(events()).toEqual([{ action: "complete", code: "memory_forget_post_commit_degraded",
      outcome: "degraded", stage: "complete", subsystem: "memory" }]);
    expect(JSON.parse(serializeEvent("service_operation", events()[0]!)!)).toMatchObject({
      code: "memory_forget_post_commit_degraded", level: "warn", stage: "complete"
    });
    expect(deps.lifecycleService.forget).toHaveBeenCalledOnce();
  });

  it("reports a legitimate dependency cascade as degraded success", async () => {
    const response = { memory: memorySummaryFixture({ factState: "FORGOTTEN" }) };
    rememberMemoryForgetPeerCascade(response, 2);
    const { service } = forgetService(undefined, response);
    await expect(service.forget("user-1", "opaque-item-ref", { requestId: "request-id-forget-0005" }))
      .resolves.toEqual({ status: "FORGOTTEN" });
    expect(events()).toEqual([{ action: "complete", code: "memory_forget_peer_dependency_cascade", count: 2,
      outcome: "degraded", stage: "delete", subsystem: "memory" }]);
  });

  it("keeps the delegated MCP path on the same single diagnostic", async () => {
    const error = new MemoryLifecycleServiceError("memory_action_failed");
    rememberMemoryPersistenceFailure(error, "memory_forget_source_limit");
    const { service } = forgetService(error);
    await expect(service.forget("user-1", "opaque-item-ref", { requestId: "request-id-forget-0006" },
      { authority: "DELEGATED_MCP" })).rejects.toEqual(new MemoryConsumerServiceError("memory_action_failed"));
    expect(events()).toEqual([expect.objectContaining({ code: "memory_forget_source_limit", outcome: "failed" })]);
  });

  it("does not let a failing sink change the outcome or repeat the mutation", async () => {
    vi.mocked(logEvent).mockImplementation(() => { throw new Error(CANARY); });
    const failed = forgetService(new MemoryLifecycleServiceError("memory_action_failed"));
    await expect(failed.service.forget("user-1", "opaque-item-ref", { requestId: "request-id-forget-0007" }))
      .rejects.toEqual(new MemoryConsumerServiceError("memory_action_failed"));
    expect(failed.deps.lifecycleService.forget).toHaveBeenCalledOnce();
    const committed = forgetService(new MemoryForgetCommittedResponseError());
    await expect(committed.service.forget("user-1", "opaque-item-ref", { requestId: "request-id-forget-0008" }))
      .resolves.toEqual({ status: "FORGOTTEN" });
    expect(committed.deps.lifecycleService.forget).toHaveBeenCalledOnce();
  });

  it("leaves other consumer operations without Forget diagnostics", async () => {
    const deps = dependencies();
    deps.explicitService.update.mockRejectedValueOnce(new ExplicitMemoryServiceError("memory_action_failed"));
    const service = createMemoryConsumerService({
      clock: () => now,
      explicitService: deps.explicitService as never,
      lifecycleService: deps.lifecycleService as never,
      readResetState: deps.readResetState,
      refs: refs(),
      settingsService: deps.settingsService as never
    });
    await expect(service.edit("user-1", "opaque-item-ref", { requestId: "request-id-edit-0001", statement: "Updated" }))
      .rejects.toEqual(new MemoryConsumerServiceError("memory_action_failed"));
    await expect(service.forget("user-1", "opaque-item-ref", { requestId: "request-id-forget-0009" }))
      .resolves.toEqual({ status: "FORGOTTEN" });
    expect(logEvent).not.toHaveBeenCalled();
  });
});
