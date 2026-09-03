import type { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readKnowledgeSearchHealth } from "./searchHealth";
import { KNOWLEDGE_SEARCH_WORKER_HEARTBEAT_FRESHNESS_MS } from
  "./searchWorkerHeartbeat";

const NOW = new Date("2026-09-03T18:00:00.000Z");

afterEach(() => {
  vi.unstubAllEnvs();
});

type HealthRow = Readonly<{
  expectedProjections: number;
  failedProjections: number;
  pendingProjections: number;
  readyProjections: number;
  workerLastSeenAt: Date | null;
}>;

function healthRow(overrides: Partial<HealthRow> = {}): HealthRow {
  return {
    expectedProjections: 3,
    failedProjections: 0,
    pendingProjections: 0,
    readyProjections: 3,
    workerLastSeenAt: NOW,
    ...overrides
  };
}

function clientWith(row: HealthRow) {
  return {
    $queryRaw: vi.fn().mockResolvedValue([row])
  } as unknown as Pick<PrismaClient, "$queryRaw">;
}

function availableSearch() {
  return { checkKnowledgeIndex: vi.fn().mockResolvedValue(undefined) };
}

describe("Knowledge search health", () => {
  it("projects aggregate projection, backend, and fresh worker evidence", async () => {
    const client = clientWith(healthRow());
    const search = availableSearch();

    await expect(readKnowledgeSearchHealth(client, { now: NOW, search })).resolves.toEqual({
      backendState: "available",
      expectedProjections: 3,
      failedProjections: 0,
      pendingProjections: 0,
      readyProjections: 3,
      workerLastSeenAt: NOW.toISOString(),
      workerState: "healthy"
    });

    expect(client.$queryRaw).toHaveBeenCalledOnce();
    expect(search.checkKnowledgeIndex).toHaveBeenCalledOnce();
  });

  it("reduces private backend failures and stale worker evidence to stable states", async () => {
    const lastSeenAt = new Date(
      NOW.getTime() - KNOWLEDGE_SEARCH_WORKER_HEARTBEAT_FRESHNESS_MS - 1
    );
    const client = clientWith(healthRow({
      expectedProjections: 4,
      failedProjections: 1,
      pendingProjections: 1,
      readyProjections: 2,
      workerLastSeenAt: lastSeenAt
    }));
    const search = {
      checkKnowledgeIndex: vi.fn().mockRejectedValue(
        new Error("https://private-search.example.test/index")
      )
    };

    await expect(readKnowledgeSearchHealth(client, { now: NOW, search })).resolves.toEqual({
      backendState: "unavailable",
      expectedProjections: 4,
      failedProjections: 1,
      pendingProjections: 1,
      readyProjections: 2,
      workerLastSeenAt: lastSeenAt.toISOString(),
      workerState: "stale"
    });
  });

  it("reduces an invalid default backend configuration without failing the health read", async () => {
    vi.stubEnv("AIQSA_OPENSEARCH_URL", "not a URL");

    await expect(readKnowledgeSearchHealth(clientWith(healthRow()), {
      now: NOW
    })).resolves.toMatchObject({
      backendState: "unavailable",
      workerState: "healthy"
    });
  });

  it("distinguishes a missing heartbeat and keeps the freshness boundary healthy", async () => {
    const boundary = new Date(
      NOW.getTime() - KNOWLEDGE_SEARCH_WORKER_HEARTBEAT_FRESHNESS_MS
    );

    await expect(readKnowledgeSearchHealth(
      clientWith(healthRow({ workerLastSeenAt: null })),
      { now: NOW, search: availableSearch() }
    )).resolves.toMatchObject({
      workerLastSeenAt: null,
      workerState: "missing"
    });
    await expect(readKnowledgeSearchHealth(
      clientWith(healthRow({ workerLastSeenAt: boundary })),
      { now: NOW, search: availableSearch() }
    )).resolves.toMatchObject({
      workerLastSeenAt: boundary.toISOString(),
      workerState: "healthy"
    });
  });

  it("rejects malformed aggregate evidence and an invalid health clock", async () => {
    await expect(readKnowledgeSearchHealth(clientWith(healthRow({
      pendingProjections: 1
    })), {
      now: NOW,
      search: availableSearch()
    })).rejects.toThrow("knowledge_search_health_invalid");
    await expect(readKnowledgeSearchHealth(clientWith(healthRow()), {
      now: new Date(Number.NaN),
      search: availableSearch()
    })).rejects.toThrow("knowledge_search_health_clock_invalid");
  });
});
