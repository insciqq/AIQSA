// @vitest-environment node
import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { createPrismaAssistantRepository } from "./prismaRepository";

/** A transaction whose definition row, read under its lock, is at `version`. */
function publicationFixture(version: number) {
  const tx = {
    $queryRaw: vi.fn(async (query: TemplateStringsArray) => {
      const sql = query.join("?");
      if (sql.includes("FROM \"AssistantDefinition\"")) return [{ archivedAt: null, id: "assistant-1", version }];
      if (sql.includes("FROM \"UserGroup\"")) return [{ groupId: "group-1" }];
      return [];
    }),
    assistantDefinition: { findUnique: vi.fn(async () => ({ skillLinks: [] })) },
    assistantPublication: {
      create: vi.fn(async () => ({ assistantId: "assistant-1", group: { name: "Backend" }, groupId: "group-1", id: "publication-1",
        publishedByUserId: "user-1", scope: "group", updatedAt: new Date("2026-10-23T00:00:00.000Z") })),
      findFirst: vi.fn(async () => null),
      update: vi.fn()
    }
  };
  const repository = createPrismaAssistantRepository({
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx))
  } as unknown as PrismaClient);
  return { repository, tx };
}

const groupPublication = { actorIsAdmin: false, assistantId: "assistant-1", groupId: "group-1", scope: "group" as const, userId: "user-1" };

describe("Assistant publication guarded by a proposal's version", () => {
  it("publishes nothing when the definition was saved after the proposal, checked under the definition's row lock", async () => {
    const changed = publicationFixture(5);
    await expect(changed.repository.publish({ ...groupPublication, expectedVersion: 4 })).resolves.toEqual({ kind: "version_conflict" });
    expect(changed.tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(changed.tx.$queryRaw.mock.calls[0]![0].join("?")).toContain("FOR UPDATE");
    expect(changed.tx.assistantPublication.create).not.toHaveBeenCalled();
    expect(changed.tx.assistantPublication.update).not.toHaveBeenCalled();
  });

  it("publishes the version the proposal named, and Studio's publication of the current definition", async () => {
    const current = publicationFixture(5);
    await expect(current.repository.publish({ ...groupPublication, expectedVersion: 5 })).resolves.toMatchObject({ kind: "ok" });
    expect(current.tx.assistantPublication.create).toHaveBeenCalledOnce();
    const studio = publicationFixture(9);
    await expect(studio.repository.publish(groupPublication)).resolves.toMatchObject({ kind: "ok" });
  });
});
