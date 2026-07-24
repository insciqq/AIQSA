import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { createPrismaAdminRunProfileRepository } from "./prismaRepository";

const NOW = new Date("2026-07-24T17:00:00.000Z");

function activeModel() {
  return {
    activeConfig: {
      adapterKind: "openai_responses_native",
      capabilities: {
        nativePdfInput: true,
        nativeSearch: true,
        pdf: true,
        reasoning: true,
        streaming: true,
        vision: true
      },
      defaultParams: { reasoning: { effort: "medium", mode: "standard" } },
      upstreamModelId: "gpt-5.6-sol"
    },
    activeVersion: 2,
    activatedAt: NOW,
    connection: {
      activeConfig: { allowPrivateNetwork: false, apiRoot: "https://api.openai.com/v1" },
      activeVersion: 3,
      activatedAt: NOW,
      displayName: "OpenAI",
      enabled: true,
      family: "openai"
    },
    displayName: "GPT-5.6 Sol",
    enabled: true,
    id: "deployment-sol"
  };
}

function storedRows(version = 4) {
  return ["balanced", "deep", "fast"].map((id) => ({
    createdAt: NOW,
    description: `${id} questions`,
    enabled: true,
    id,
    providerModelId: "deployment-sol",
    reasoningEffort: id === "deep" ? "max" : "medium",
    reasoningMode: id === "deep" ? "pro" : "standard",
    updatedAt: NOW,
    updatedByUserId: "admin-1",
    version
  }));
}

function writes(expectedVersion = 3) {
  return [
    { description: "Fast", enabled: true, expectedVersion, id: "fast" as const, providerModelId: "deployment-sol", reasoningEffort: "medium", reasoningMode: "standard" },
    { description: "Balanced", enabled: true, expectedVersion, id: "balanced" as const, providerModelId: "deployment-sol", reasoningEffort: "high", reasoningMode: "standard" },
    { description: "Deep", enabled: true, expectedVersion, id: "deep" as const, providerModelId: "deployment-sol", reasoningEffort: "max", reasoningMode: "pro" }
  ];
}

function transactional<T extends Record<string, unknown>>(db: T) {
  return Object.assign(db, {
    $transaction: vi.fn(async (operation: (tx: T) => Promise<unknown>) => operation(db))
  });
}

describe("Prisma admin run profile repository", () => {
  it("locks and CAS-updates all three rows before returning fresh state", async () => {
    const query = vi.fn(async (_sql: unknown) => [
      { id: "balanced", version: 3 },
      { id: "deep", version: 3 },
      { id: "fast", version: 3 }
    ]);
    const update = vi.fn(async () => ({}));
    const findManyModels = vi.fn()
      .mockResolvedValueOnce([activeModel()])
      .mockResolvedValueOnce([activeModel()]);
    const db = transactional({
      $queryRaw: query,
      providerModel: { findMany: findManyModels },
      runProfile: {
        findMany: vi.fn(async () => storedRows()),
        update
      }
    });
    const repository = createPrismaAdminRunProfileRepository(db as unknown as PrismaClient);

    await expect(repository.updateAll({ profiles: writes(), updatedByUserId: "admin-1" }))
      .resolves.toMatchObject({ profiles: expect.arrayContaining([expect.objectContaining({ id: "deep", version: 4 })]) });
    expect(update).toHaveBeenCalledTimes(3);
    expect(update).toHaveBeenNthCalledWith(3, {
      data: {
        description: "Deep",
        enabled: true,
        providerModelId: "deployment-sol",
        reasoningEffort: "max",
        reasoningMode: "pro",
        updatedByUserId: "admin-1",
        version: { increment: 1 }
      },
      where: { id: "deep" }
    });
    const sql = query.mock.calls[0]?.[0] as { strings?: string[] } | undefined;
    expect(sql?.strings?.join(" ")).toContain("FOR UPDATE");
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "RepeatableRead"
    });
  });

  it("returns stale without loading targets or writing if any version changed", async () => {
    const findMany = vi.fn();
    const update = vi.fn();
    const db = transactional({
      $queryRaw: vi.fn(async (_sql: unknown) => [
        { id: "balanced", version: 3 },
        { id: "deep", version: 4 },
        { id: "fast", version: 3 }
      ]),
      providerModel: { findMany },
      runProfile: { findMany: vi.fn(), update }
    });
    const repository = createPrismaAdminRunProfileRepository(db as unknown as PrismaClient);

    await expect(repository.updateAll({ profiles: writes(), updatedByUserId: "admin-1" }))
      .resolves.toBe("stale");
    expect(findMany).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects unsupported target reasoning before changing any row", async () => {
    const update = vi.fn();
    const target = activeModel();
    const db = transactional({
      $queryRaw: vi.fn(async (_sql: unknown) => [
        { id: "balanced", version: 3 },
        { id: "deep", version: 3 },
        { id: "fast", version: 3 }
      ]),
      providerModel: { findMany: vi.fn(async () => [target]) },
      runProfile: { findMany: vi.fn(), update }
    });
    const repository = createPrismaAdminRunProfileRepository(db as unknown as PrismaClient);
    const unsupportedWrites = writes();
    unsupportedWrites[2] = { ...unsupportedWrites[2]!, reasoningEffort: "impossible" };

    await expect(repository.updateAll({ profiles: unsupportedWrites, updatedByUserId: "admin-1" }))
      .resolves.toBe("invalid_target");
    expect(update).not.toHaveBeenCalled();
  });
});
