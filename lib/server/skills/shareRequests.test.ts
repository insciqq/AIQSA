import { Prisma, type PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { createSkillSharingService, ensureSkillShareRequest } from "./shareRequests";

function transactionFixture() {
  return {
    $queryRaw: vi.fn(async () => [{ role: "user" }]),
    skillDefinition: {
      findUnique: vi.fn(async () => ({ id: "skill", ownerUserId: "owner", currentRevisionId: "revision", sharedRevisionId: null,
        archivedAt: null, deletedAt: null, version: 2, currentRevision: { bundleReady: true } })),
      update: vi.fn()
    },
    skillShareRequest: {
      findFirst: vi.fn(async (): Promise<{ createdAt: Date; revisionId?: string } | null> => ({ createdAt: new Date("2100-01-01T00:00:00.000Z") })),
      updateMany: vi.fn(async () => ({ count: 1 })), create: vi.fn()
    }
  };
}

describe("Skill sharing serialized writes", () => {
  it("keeps the latest request visible when the wall clock trails previous writes", async () => {
    const tx = transactionFixture();
    await ensureSkillShareRequest(tx as unknown as Prisma.TransactionClient,
      { userId: "owner", skillId: "skill", expectedVersion: 2, explicit: true });
    expect(tx.skillShareRequest.create).toHaveBeenCalledWith({ data: {
      skillId: "skill", revisionId: "revision", requestedByUserId: "owner", createdAt: new Date("2100-01-01T00:00:00.001Z")
    } });
    expect(tx.skillDefinition.update).not.toHaveBeenCalled();
  });

  it("keeps an existing pending request frozen when another audience is added", async () => {
    const tx = transactionFixture();
    await ensureSkillShareRequest(tx as unknown as Prisma.TransactionClient,
      { userId: "owner", skillId: "skill", firstAudience: false });
    expect(tx.skillShareRequest.updateMany).not.toHaveBeenCalled();
    expect(tx.skillShareRequest.create).not.toHaveBeenCalled();
  });

  it("reuses an identical pending request after a lost owner response", async () => {
    const tx = transactionFixture();
    tx.skillShareRequest.findFirst.mockResolvedValueOnce({ revisionId: "revision", createdAt: new Date() });
    await ensureSkillShareRequest(tx as unknown as Prisma.TransactionClient,
      { userId: "owner", skillId: "skill", expectedVersion: 2, explicit: true });
    expect(tx.skillShareRequest.updateMany).not.toHaveBeenCalled();
    expect(tx.skillShareRequest.create).not.toHaveBeenCalled();
  });

  it("does not supersede a request from an editor holding a stale version", async () => {
    const tx = transactionFixture();
    await expect(ensureSkillShareRequest(tx as unknown as Prisma.TransactionClient,
      { userId: "owner", skillId: "skill", expectedVersion: 1, explicit: true })).rejects.toThrow("skill_version_conflict");
    expect(tx.skillShareRequest.updateMany).not.toHaveBeenCalled();
    expect(tx.skillShareRequest.create).not.toHaveBeenCalled();
  });

  it.each([
    { code: "P2034" }, { code: "P2010", meta: { code: "40P01" } },
    { code: "P2002", meta: { target: "SkillShareRequest_pending_skill_key" } }
  ])("bounds transaction retries and returns 409 after $code collisions", async ({ code, meta }) => {
    const transact = vi.fn().mockRejectedValue(new Prisma.PrismaClientKnownRequestError("synthetic", { code, meta, clientVersion: "test" }));
    const service = createSkillSharingService({ $transaction: transact } as unknown as PrismaClient);
    await expect(service.request("owner", "skill", 2)).rejects.toMatchObject({ code: "skill_share_request_conflict", status: 409 });
    expect(transact).toHaveBeenCalledTimes(3);
  });

  it("does not retry an unrelated uniqueness failure", async () => {
    const error = new Prisma.PrismaClientKnownRequestError("synthetic", { code: "P2002", meta: { target: ["id"] }, clientVersion: "test" });
    const transact = vi.fn().mockRejectedValue(error);
    const service = createSkillSharingService({ $transaction: transact } as unknown as PrismaClient);
    await expect(service.request("owner", "skill", 2)).rejects.toBe(error);
    expect(transact).toHaveBeenCalledTimes(1);
  });
});
