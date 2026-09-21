import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { createSkillCatalogRepository } from "./catalogRepository";

describe("Skill catalog authority boundaries", () => {
  it("loads prior activity only from the caller's supplied active-branch answer messages", async () => {
    const findMany = vi.fn(async () => [{ skillId: "workflow" }]);
    const repository = createSkillCatalogRepository({ modelRunSkillBinding: { findMany } } as unknown as PrismaClient);
    expect(await repository.loadedBeforeForMessages("runner", "chat", [])).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
    expect(await repository.loadedBeforeForMessages("runner", "chat", ["answer", "answer"])).toEqual(["workflow"]);
    expect(findMany).toHaveBeenCalledWith({ where: { mode: "loaded", modelRun: { userId: "runner", chatId: "chat",
      assistantMessageId: { in: ["answer"] } } }, select: { skillId: true }, distinct: ["skillId"] });
  });

  it("does not read a disabled account's catalog or frozen bundle", async () => {
    const findMany = vi.fn(), findFirst = vi.fn();
    const repository = createSkillCatalogRepository({ user: { findFirst: vi.fn(async () => null) },
      skillDefinition: { findMany }, skillRevision: { findFirst } } as unknown as PrismaClient);
    expect(await repository.listEnabledForRun("disabled")).toEqual([]);
    expect(await repository.resolveFrozen({ userId: "disabled", skillId: "skill", revisionId: "frozen" })).toBeNull();
    expect(findMany).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
  });
});
