import { describe, expect, it, vi } from "vitest";
import type { MemoryRebuildStatus } from "../../../contracts/memory";
import type { MemoryItemEmbeddingPin } from "../embedding/contract";
import type { MemoryRebuildRepository } from "./repository";
import {
  createMemoryRebuildService,
  MemoryRebuildServiceError
} from "./service";

const status: MemoryRebuildStatus = {
  completedUnits: 0,
  createdAt: "2026-08-10T12:00:00.000Z",
  errorCode: null,
  jobId: "job-1",
  operation: "REBUILD_SEARCH_INDEX",
  state: "QUEUED",
  totalUnits: null,
  updatedAt: "2026-08-10T12:00:00.000Z"
};

const pin: MemoryItemEmbeddingPin = {
  configurationFingerprint: "a".repeat(64),
  connectionId: "connection-1",
  dimension: 1_024,
  providerModelId: "embedding-1",
  vectorSpaceFingerprint: "b".repeat(64)
};

function repository(
  overrides: Partial<MemoryRebuildRepository> = {}
): MemoryRebuildRepository {
  return {
    admit: vi.fn(async () => ({ jobId: "job-1", kind: "ok" as const })),
    applyJob: vi.fn(async () => undefined),
    cancel: vi.fn(async () => status),
    inventory: vi.fn(async () => ({
      activeGenerationId: null,
      activeIndexMode: null,
      activePipelineVersion: null,
      compatibleAutomaticFactVersions: 0,
      compatibleExplicitFactVersions: 0,
      compatibleHistoryChunks: 0,
      compatibleHistoryRounds: 0,
      eligibleIdentityFingerprint: "a".repeat(64),
      eligibleItems: 0,
      incompatibleAutomaticFactVersions: 0,
      memoryRevision: 0,
      ready: false,
      settingsRevision: 0
    })),
    promoteCompatibleActiveGeneration: vi.fn(async () => ({
      generationId: null,
      kind: "incompatible" as const
    })),
    rollbackGeneration: vi.fn(async () => ({
      activeGenerationId: null,
      kind: "generation_incompatible" as const
    })),
    status: vi.fn(async () => status),
    wakeShadow: vi.fn(async () => 1),
    ...overrides
  };
}

describe("Memory rebuild service", () => {
  it("admits a local rebuild without probing provider authority", async () => {
    const rebuildRepository = repository();
    const probeEmbeddingPin = vi.fn(async () => pin);
    const kick = vi.fn();
    const service = createMemoryRebuildService({
      kick,
      probeEmbeddingPin,
      repository: rebuildRepository
    });

    await expect(service.start("user-1", {
      expectedMemoryRevision: 7,
      expectedSettingsRevision: 3,
      operation: "REBUILD_SEARCH_INDEX"
    })).resolves.toEqual(status);
    expect(probeEmbeddingPin).not.toHaveBeenCalled();
    expect(rebuildRepository.admit).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ operation: "REBUILD_SEARCH_INDEX", pin: null })
    );
    expect(kick).toHaveBeenCalledTimes(1);
  });

  it("pins re-embedding to the explicitly selected current deployment", async () => {
    const rebuildRepository = repository({
      status: vi.fn(async () => ({
        ...status,
        operation: "REEMBED" as const
      }))
    });
    const service = createMemoryRebuildService({
      probeEmbeddingPin: vi.fn(async () => pin),
      repository: rebuildRepository
    });

    await expect(service.start("user-1", {
      embeddingDeploymentId: "embedding-1",
      expectedMemoryRevision: 7,
      expectedSettingsRevision: 3,
      operation: "REEMBED"
    })).resolves.toMatchObject({ operation: "REEMBED" });
    expect(rebuildRepository.admit).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({
        embeddingDeploymentId: "embedding-1",
        operation: "REEMBED",
        pin
      })
    );
  });

  it("maps admission conflicts and hides foreign job status", async () => {
    const service = createMemoryRebuildService({
      probeEmbeddingPin: vi.fn(async () => pin),
      repository: repository({
        admit: vi.fn(async () => ({ kind: "memory_revision_conflict" as const })),
        status: vi.fn(async () => null)
      })
    });
    await expect(service.start("user-1", {
      expectedMemoryRevision: 6,
      expectedSettingsRevision: 3,
      operation: "REBUILD_SEARCH_INDEX"
    })).rejects.toEqual(new MemoryRebuildServiceError("memory_version_stale"));
    await expect(service.status("user-1", "foreign-job")).rejects.toEqual(
      new MemoryRebuildServiceError("memory_rebuild_not_found")
    );
  });
});
