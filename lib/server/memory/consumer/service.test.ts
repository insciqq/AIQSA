import { describe, expect, it, vi } from "vitest";
import {
  memoryDeletionFixture,
  memoryDetailFixture,
  memorySettingsFixture,
  memorySummaryFixture
} from "@/tests/support/memoryFixtures";
import { createMemoryConsumerService } from "./service";
import type { MemoryConsumerRefService } from "./ref";
import { ExplicitMemoryServiceError } from "../explicit/service";
import { MEMORY_CONSUMER_CATEGORIES } from "../../../contracts/memoryConsumer";

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
  it("projects combined memories with opaque source refs and Forget-only actions", async () => {
    const deps = dependencies();
    const refService = refs();
    vi.mocked(refService.mintItem).mockImplementation((_userId, target) =>
      `opaque-${target.factId}`);
    const summary = memorySummaryFixture({
      combinedSources: [1, 2, 3].map((index) => ({
        category: "habits",
        createdAt: now.toISOString(),
        factId: `internal-source-${index}`,
        sourceMode: "AUTOMATIC" as const,
        statement: `I use a checklist for workflow ${index}.`,
        updatedAt: now.toISOString(),
        versionId: `internal-source-version-${index}`
      })),
      currentVersionId: "internal-pattern-version",
      id: "internal-pattern",
      modality: "PATTERN",
      sourceMode: "AUTOMATIC"
    });
    deps.explicitService.list.mockResolvedValue({ memories: [summary], nextCursor: null });
    deps.explicitService.get.mockResolvedValue(memoryDetailFixture(summary));
    const service = createMemoryConsumerService({
      clock: () => now,
      explicitService: deps.explicitService as never,
      lifecycleService: deps.lifecycleService as never,
      readResetState: deps.readResetState,
      refs: refService,
      settingsService: deps.settingsService as never
    });
    const listed = await service.list("user-1", {});
    expect(listed.items[0]).toMatchObject({
      allowedActions: ["FORGET"],
      combined: {
        sourceCount: 3,
        sources: [
          { memoryRef: "opaque-internal-source-1" },
          { memoryRef: "opaque-internal-source-2" },
          { memoryRef: "opaque-internal-source-3" }
        ]
      },
      memoryRef: "opaque-internal-pattern"
    });
    expect(JSON.stringify(listed)).not.toMatch(/versionId|factId|PATTERN/u);
    expect(refService.mintItem).toHaveBeenCalledWith("user-1", {
      allowedOperations: ["READ", "FORGET"],
      factId: "internal-source-1",
      factVersionId: "internal-source-version-1"
    }, now);
    await expect(service.get("user-1", "opaque-internal-pattern", {
      authority: "DELEGATED_MCP"
    })).rejects.toMatchObject({ code: "memory_not_found" });
    await service.list("user-1", {}, { authority: "DELEGATED_MCP" });
    expect(deps.explicitService.list).toHaveBeenLastCalledWith("user-1",
      expect.objectContaining({ includePatterns: false }));
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
      includePatterns: true,
      pageSize: 7,
      scope: { type: "GLOBAL_USER" },
      sourceMode: "AUTOMATIC",
      state: "ACTIVE"
    });
    expect(deps.explicitService.search).toHaveBeenCalledWith("user-1", {
      category: "about_you",
      cursor: null,
      includePatterns: true,
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
          synthesisEnabled: true,
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
