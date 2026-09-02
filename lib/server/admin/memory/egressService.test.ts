import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type {
  ResolvedMemoryExecutionTarget,
  ResolvedMemoryUtilityPolicy
} from "../../memory/execution/policy";
import {
  AdminMemoryEgressServiceError,
  createAdminMemoryEgressService
} from "./egressService";

function target(
  destinationFingerprint: string,
  connectionDisplayName: string,
  modelDisplayName: string
): ResolvedMemoryExecutionTarget {
  return {
    destinationFingerprint,
    snapshot: { connectionDisplayName, modelDisplayName }
  } as ResolvedMemoryExecutionTarget;
}

function policy(suffix = "a"): ResolvedMemoryUtilityPolicy {
  const system = target(suffix.repeat(64), "System connection", "System model");
  const embedding = target("b".repeat(64), "Embedding connection", "Embedding model");
  const reranker = target("c".repeat(64), "Reranker connection", "Reranker model");
  const destinations = [
    { kind: "AVAILABLE" as const, role: "MEMORY_FACT_EXTRACT" as const, target: system },
    { kind: "AVAILABLE" as const, role: "MEMORY_DOCUMENT_EMBED" as const, target: embedding },
    { kind: "AVAILABLE" as const, role: "MEMORY_RERANK" as const, target: reranker }
  ];
  return {
    destinations,
    fingerprint: "f".repeat(64),
    policyVersion: "memory-utility-egress-v5",
    targets: new Map(destinations.map((entry) => [entry.role, entry.target]))
  };
}

function fixture() {
  const row = {
    acceptedAt: null as Date | null,
    acceptedBy: null as { displayName: string; id: string } | null,
    acceptedByUserId: null as string | null,
    acceptedDestinations: [] as unknown[],
    acceptedFingerprint: null as string | null,
    acceptedPolicyVersion: null as string | null,
    version: 1
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "installation" }]),
    memoryEgressAdminPolicy: {
      findUnique: vi.fn(async (args: Record<string, unknown>) => {
        const select = args.select as Record<string, unknown> | undefined;
        return select?.version ? { version: row.version } : row;
      }),
      updateMany: vi.fn(async (args: {
        data: Record<string, unknown>;
        where: { version: number };
      }) => {
        if (args.where.version !== row.version) return { count: 0 };
        row.acceptedAt = args.data.acceptedAt as Date;
        row.acceptedByUserId = args.data.acceptedByUserId as string;
        row.acceptedBy = { displayName: "Admin", id: row.acceptedByUserId };
        row.acceptedDestinations = args.data.acceptedDestinations as unknown[];
        row.acceptedFingerprint = args.data.acceptedFingerprint as string;
        row.acceptedPolicyVersion = args.data.acceptedPolicyVersion as string;
        row.version += 1;
        return { count: 1 };
      })
    },
    memoryJob: { count: vi.fn().mockResolvedValue(2) },
    user: { findMany: vi.fn().mockResolvedValue([{ id: "owner-1" }]) },
    userMemorySettings: {
      findMany: vi.fn().mockResolvedValue([{
        embeddingProviderModelId: "embedding-1",
        userId: "owner-1"
      }])
    }
  };
  const client = {
    $transaction: vi.fn(async (operation: (value: typeof tx) => Promise<unknown>) =>
      operation(tx))
  } as unknown as PrismaClient;
  return { client, row, tx };
}

describe("administrator Memory egress service", () => {
  it("projects four least-data destination rows and atomically acknowledges them", async () => {
    const { client, row } = fixture();
    const onAcknowledged = vi.fn();
    const service = createAdminMemoryEgressService(client, {
      consentMode: "ADMIN",
      onAcknowledged,
      resolveOwnerPolicy: async () => policy()
    });

    const before = await service.get();
    expect(before.reviewRequired).toBe(true);
    expect(before.waitingJobCount).toBe(2);
    expect(before.destinations.map(({ id }) => id)).toEqual([
      "answer_provider",
      "system_model",
      "embedding",
      "remote_reranker"
    ]);
    expect(before.destinations[1]).toMatchObject({
      destinations: ["System connection / System model"],
      reviewRequired: true,
      state: "AVAILABLE"
    });
    expect(before.destinations[3]).toMatchObject({
      destinations: ["Reranker connection / Reranker model"],
      reviewRequired: true,
      state: "AVAILABLE"
    });
    expect(JSON.stringify(before)).not.toContain("MEMORY_VERIFY");
    expect(JSON.stringify(before)).not.toMatch(/owner-1|embedding-1|https?:\/\//u);

    const after = await service.acknowledge("admin-1", {
      currentFingerprint: before.currentFingerprint,
      expectedVersion: before.version
    });

    expect(after.reviewRequired).toBe(false);
    expect(after.acceptedFingerprint).toBe(after.currentFingerprint);
    expect(after.acceptedBy).toEqual({ displayName: "Admin", id: "admin-1" });
    expect(after.version).toBe(2);
    expect(onAcknowledged).toHaveBeenCalledOnce();
    expect(row.acceptedDestinations).toHaveLength(3);
    expect(row.acceptedDestinations).not.toContainEqual(expect.objectContaining({
      role: "MEMORY_QUERY_RESOLVE"
    }));
    expect(JSON.stringify(row.acceptedDestinations)).not.toMatch(/System|Embedding|Reranker|owner/u);
  });

  it("detects destination drift without invalidating the prior accepted snapshot", async () => {
    const { client } = fixture();
    let current = policy();
    const service = createAdminMemoryEgressService(client, {
      consentMode: "ADMIN",
      resolveOwnerPolicy: async () => current
    });
    const initial = await service.get();
    await service.acknowledge("admin-1", {
      currentFingerprint: initial.currentFingerprint,
      expectedVersion: initial.version
    });
    current = policy("d");

    const drifted = await service.get();
    expect(drifted.reviewRequired).toBe(true);
    expect(drifted.destinations.find(({ id }) => id === "system_model")?.reviewRequired)
      .toBe(true);
    expect(drifted.destinations.find(({ id }) => id === "embedding")?.reviewRequired)
      .toBe(false);
    expect(drifted.acceptedFingerprint).not.toBe(drifted.currentFingerprint);
  });

  it("preserves PER_USER ownership and optimistic review fencing", async () => {
    const perUserFixture = fixture();
    const perUser = createAdminMemoryEgressService(perUserFixture.client, {
      consentMode: "PER_USER",
      resolveOwnerPolicy: async () => policy()
    });
    await expect(perUser.get()).resolves.toMatchObject({
      consentMode: "PER_USER",
      reviewRequired: false
    });
    await expect(perUser.acknowledge("admin-1", {
      currentFingerprint: "a".repeat(64),
      expectedVersion: 1
    })).rejects.toEqual(
      new AdminMemoryEgressServiceError("memory_admin_egress_per_user_mode")
    );

    const adminFixture = fixture();
    const admin = createAdminMemoryEgressService(adminFixture.client, {
      consentMode: "ADMIN",
      resolveOwnerPolicy: async () => policy()
    });
    const current = await admin.get();
    await expect(admin.acknowledge("admin-1", {
      currentFingerprint: current.currentFingerprint,
      expectedVersion: current.version + 1
    })).rejects.toEqual(
      new AdminMemoryEgressServiceError("memory_admin_egress_stale")
    );
  });
});
