import { describe, expect, it, vi } from "vitest";
import {
  memoryDeletionFixture,
  memorySettingsFixture,
  memorySummaryFixture
} from "@/tests/support/memoryFixtures";
import { createMemoryConsumerService } from "./service";
import type { MemoryConsumerRefService } from "./ref";
import { ExplicitMemoryServiceError } from "../explicit/service";

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
      list: vi.fn(async () => ({ memories: [summary], nextCursor: "internal-cursor" })),
      mintAuthorization: vi.fn(async () => ({
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
  it("projects settings and items without persistence or control-plane fields", async () => {
    const deps = dependencies();
    const service = createMemoryConsumerService({
      clock: () => now,
      explicitService: deps.explicitService as never,
      lifecycleService: deps.lifecycleService as never,
      readResetState: deps.readResetState,
      refs: refs(),
      settingsService: deps.settingsService as never
    });

    const [settings, list, search] = await Promise.all([
      service.settings("user-1"),
      service.list("user-1", { pageSize: 20 }),
      service.search("user-1", { pageSize: 20, query: "concise" })
    ]);

    expect(settings).toEqual({
      capabilities: {
        automaticLearningAvailable: true,
        managementAvailable: true,
        naturalLanguageActionsAvailable: true,
        permanentChatDeletion: false,
        pastChatIndexingAvailable: true,
        retrievalAvailable: true,
        temporaryChats: true
      },
      resetState: "IDLE",
      settings: {
        learnAutomatically: true,
        referenceChatHistory: true,
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

    const browserJson = JSON.stringify({ list, search, settings });
    expect(browserJson).not.toMatch(
      /internal-|memoryRevision|settingsRevision|generation|deployment|fingerprint|score|hash/iu
    );
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

  it("collapses provider review requirements to a friendly unavailable status", async () => {
    const deps = dependencies();
    deps.settingsService.get.mockResolvedValue(memorySettingsFixture({
      egress: {
        acceptedAt: null,
        acceptedUtilityEgressFingerprint: null,
        acceptedUtilityPolicyVersion: null,
        consentMode: "PER_USER",
        reviewRequired: true
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

    const settings = await service.settings("user-1");

    expect(settings.status).toBe("UNAVAILABLE");
    expect(JSON.stringify(settings)).not.toMatch(/egress|fingerprint|destination|deployment/iu);
  });

  it("projects each v1 capability independently while manual management stays usable", async () => {
    for (const capability of [
      "naturalLanguageActionsAvailable",
      "retrievalAvailable",
      "automaticLearningAvailable",
      "pastChatIndexingAvailable"
    ] as const) {
      const deps = dependencies();
      deps.settingsService.get.mockResolvedValue(memorySettingsFixture({
        capabilities: { [capability]: false },
        settings: {
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
