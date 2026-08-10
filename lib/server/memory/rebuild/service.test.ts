import { describe, expect, it, vi } from "vitest";
import type { MemoryRebuildStatus } from "../../../contracts/memory";
import { memoryTargetAuthorizationPayloadHash } from "../persistence/authorizations";
import type { MemoryItemEmbeddingPin } from "../embedding/contract";
import type { MemoryRebuildRepository } from "./repository";
import {
  createMemoryRebuildService,
  MemoryRebuildServiceError,
  type MemoryRebuildAuthorizationRepository
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
    status: vi.fn(async () => status),
    wakeShadow: vi.fn(async () => 1),
    ...overrides
  };
}

function authorizations(): MemoryRebuildAuthorizationRepository {
  return {
    resolveForUse: vi.fn(async () => ({
      confirmedAt: new Date("2026-08-10T12:00:00.000Z"),
      requestId: "request-1"
    }))
  };
}

describe("Memory rebuild service", () => {
  it("admits a local rebuild without probing provider authority", async () => {
    const rebuildRepository = repository();
    const probeEmbeddingPin = vi.fn(async () => pin);
    const kick = vi.fn();
    const service = createMemoryRebuildService({
      authorizationRepository: authorizations(),
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
      authorizationRepository: authorizations(),
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

  it("binds redream to exact CAS counters and one resolved authorization", async () => {
    const authorizationRepository = authorizations();
    const rebuildRepository = repository({
      status: vi.fn(async () => ({
        ...status,
        operation: "REDREAM_EXISTING_CHATS" as const
      }))
    });
    const service = createMemoryRebuildService({
      authorizationRepository,
      probeEmbeddingPin: vi.fn(async () => pin),
      repository: rebuildRepository
    });

    await expect(service.start("user-1", {
      expectedMemoryRevision: 7,
      expectedSettingsRevision: 3,
      mutationAuthorizationId: "authorization-1",
      operation: "REDREAM_EXISTING_CHATS"
    })).resolves.toMatchObject({ operation: "REDREAM_EXISTING_CHATS" });
    expect(authorizationRepository.resolveForUse).toHaveBeenCalledWith("user-1", {
      action: "BULK_DELETE",
      authorizationId: "authorization-1",
      authorizedPayloadHash: memoryTargetAuthorizationPayloadHash({
        action: "BULK_DELETE",
        expectedMemoryRevision: 7,
        expectedSettingsRevision: 3,
        operation: "REDREAM_EXISTING_CHATS"
      })
    });
    expect(rebuildRepository.admit).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({
        authorization: expect.objectContaining({
          authorizationId: "authorization-1",
          requestId: "request-1"
        })
      })
    );
  });

  it("maps admission conflicts and hides foreign job status", async () => {
    const service = createMemoryRebuildService({
      authorizationRepository: authorizations(),
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
