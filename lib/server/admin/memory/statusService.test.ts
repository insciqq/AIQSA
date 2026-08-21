import { describe, expect, it, vi } from "vitest";
import {
  ADMIN_MEMORY_REBUILD_BATCH_SIZE,
  ADMIN_MEMORY_WORKER_FRESHNESS_MS,
  AdminMemoryStatusServiceError,
  createAdminMemoryStatusService,
  type AdminMemoryStatusRepository,
  type AdminMemoryStatusSnapshot
} from "./statusService";

const now = new Date("2026-08-21T08:00:00.000Z");

function snapshot(
  overrides: Partial<AdminMemoryStatusSnapshot> = {}
): AdminMemoryStatusSnapshot {
  return {
    admissionTimeout: { seconds: 15, version: 4 },
    activeIssueCode: null,
    configuredTargets: [{ model: "Utility", provider: "Primary" }],
    index: {
      activeGenerations: [3],
      ownerCount: 1,
      preparing: false,
      rebuildCandidates: [],
      rebuilding: false,
      requiresRebuild: false
    },
    oldestQueuedAt: null,
    queueLength: 0,
    workerLastSeenAt: new Date(now.getTime() - 1_000),
    ...overrides
  };
}

function repository(
  rows: readonly AdminMemoryStatusSnapshot[],
  startRebuild = vi.fn().mockResolvedValue(undefined)
): AdminMemoryStatusRepository {
  let index = 0;
  return {
    read: vi.fn(async () => rows[Math.min(index++, rows.length - 1)]!),
    startRebuild,
    updateAdmissionTimeout: vi.fn().mockResolvedValue(true)
  };
}

describe("administrator Memory status service", () => {
  it("projects only exact bounded status and a conservative worker lease", async () => {
    const service = createAdminMemoryStatusService({
      now: () => now,
      repository: repository([snapshot({
        index: {
          activeGenerations: [2, 3],
          ownerCount: 2,
          preparing: false,
          rebuildCandidates: [],
          rebuilding: false,
          requiresRebuild: false
        },
        activeIssueCode: "MEMORY_PROVIDER_FAILED",
        oldestQueuedAt: new Date(now.getTime() - 12_999),
        queueLength: 3,
        workerLastSeenAt: new Date(now.getTime() - ADMIN_MEMORY_WORKER_FRESHNESS_MS - 1)
      })])
    });

    await expect(service.get()).resolves.toEqual({
      admissionTimeout: { seconds: 15, version: 4 },
      activeIssueCode: "memory_provider_failed",
      configuredTargets: [{ model: "Utility", provider: "Primary" }],
      index: { generation: "MIXED", readiness: "READY" },
      queue: { length: 3, oldestAgeSeconds: 12 },
      rebuild: { state: "NOT_REQUIRED" },
      worker: { state: "NOT_RUNNING" }
    });
  });

  it("admits at most one bounded batch and returns fresh rebuilding state", async () => {
    const candidates = Array.from({ length: ADMIN_MEMORY_REBUILD_BATCH_SIZE + 3 }, (_, index) => ({
      embeddingDeploymentId: null,
      expectedMemoryRevision: index,
      expectedSettingsRevision: index,
      operation: "REBUILD_SEARCH_INDEX" as const,
      userId: `owner-${index}`
    }));
    const startRebuild = vi.fn().mockResolvedValue(undefined);
    const service = createAdminMemoryStatusService({
      now: () => now,
      repository: repository([
        snapshot({
          index: {
            activeGenerations: [1],
            ownerCount: candidates.length,
            preparing: false,
            rebuildCandidates: candidates,
            rebuilding: false,
            requiresRebuild: true
          }
        }),
        snapshot({
          index: {
            activeGenerations: [1],
            ownerCount: candidates.length,
            preparing: false,
            rebuildCandidates: candidates.slice(ADMIN_MEMORY_REBUILD_BATCH_SIZE),
            rebuilding: true,
            requiresRebuild: true
          },
          oldestQueuedAt: now,
          queueLength: ADMIN_MEMORY_REBUILD_BATCH_SIZE
        })
      ], startRebuild)
    });

    await expect(service.rebuild()).resolves.toMatchObject({
      index: { readiness: "REBUILDING" },
      rebuild: { state: "IN_PROGRESS" }
    });
    expect(startRebuild).toHaveBeenCalledTimes(ADMIN_MEMORY_REBUILD_BATCH_SIZE);
  });

  it("does not admit a rebuild while preparation or the worker is unavailable", async () => {
    const candidate = {
      embeddingDeploymentId: null,
      expectedMemoryRevision: 1,
      expectedSettingsRevision: 1,
      operation: "REBUILD_SEARCH_INDEX" as const,
      userId: "owner-1"
    };
    const service = createAdminMemoryStatusService({
      now: () => now,
      repository: repository([snapshot({
        index: {
          activeGenerations: [1],
          ownerCount: 1,
          preparing: false,
          rebuildCandidates: [candidate],
          rebuilding: false,
          requiresRebuild: true
        },
        workerLastSeenAt: null
      })])
    });
    await expect(service.rebuild()).rejects.toEqual(
      new AdminMemoryStatusServiceError("memory_admin_rebuild_unavailable")
    );
  });

  it("does not invent an oldest age for an inconsistent non-empty queue", async () => {
    const service = createAdminMemoryStatusService({
      now: () => now,
      repository: repository([snapshot({ queueLength: 1 })])
    });

    await expect(service.get()).rejects.toThrow("memory_admin_status_queue_invalid");
  });

  it("updates the timeout with optimistic installation policy authority", async () => {
    const policyRepository = repository([
      snapshot({ admissionTimeout: { seconds: 30, version: 5 } })
    ]);
    const service = createAdminMemoryStatusService({
      now: () => now,
      repository: policyRepository
    });

    await expect(service.updateAdmissionTimeout({
      expectedVersion: 4,
      seconds: 30,
      userId: "admin-1"
    })).resolves.toMatchObject({
      admissionTimeout: { seconds: 30, version: 5 }
    });
    expect(policyRepository.updateAdmissionTimeout).toHaveBeenCalledWith({
      expectedVersion: 4,
      seconds: 30,
      userId: "admin-1"
    });
  });

  it("fails stale timeout updates without overwriting a newer policy", async () => {
    const policyRepository = repository([snapshot()]);
    vi.mocked(policyRepository.updateAdmissionTimeout).mockResolvedValue(false);
    const service = createAdminMemoryStatusService({
      now: () => now,
      repository: policyRepository
    });

    await expect(service.updateAdmissionTimeout({
      expectedVersion: 3,
      seconds: 30,
      userId: "admin-1"
    })).rejects.toEqual(new AdminMemoryStatusServiceError("memory_admin_timeout_stale"));
  });
});
