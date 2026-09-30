// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { ActiveRunConflictError } from "./runRepositoryContract";
import { mapActiveRunConflict } from "./prismaRepositoryShared";

function uniqueError(meta: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "6.19.3",
    meta
  });
}

describe("active run conflict mapping", () => {
  it("maps only the ModelRun chat uniqueness target", async () => {
    await expect(mapActiveRunConflict(async () => {
      throw uniqueError({ modelName: "ModelRun", target: ["chatId"] });
    })).rejects.toBeInstanceOf(ActiveRunConflictError);
  });

  it.each(["ModelRun_one_active_per_chat_idx", "ModelRun_one_workspace_wait_per_chat_idx"])(
    "maps exact named %s uniqueness diagnostics", async (index) => {
      const errors = [
        uniqueError({ target: index }),
        uniqueError({ modelName: "ModelRun", target: [index] }),
        new Prisma.PrismaClientKnownRequestError("Raw query failed", { code: "P2010", clientVersion: "6.19.3",
          meta: { code: "23505", message: `duplicate key value violates unique constraint "${index}"` } }),
        new Error(`duplicate key value violates unique constraint "${index}"`)
      ];
      for (const error of errors) {
        await expect(mapActiveRunConflict(async () => { throw error; })).rejects.toBeInstanceOf(ActiveRunConflictError);
      }
    });

  it.each([
    { modelName: "Message", target: ["id"] },
    { modelName: "ModelRun", target: ["id"] },
    { modelName: "ModelRun", target: ["userId", "chatId", "id"] },
    { modelName: "WorkspaceSession", target: ["chatId"] },
    { target: ["chatId"] },
    { modelName: "ModelRun", target: "ModelRun_pkey" },
    { modelName: "ModelRun", target: "ModelRun_one_active_per_chat_idx_other" }
  ])("does not relabel unrelated uniqueness failures (%s)", async (meta) => {
    const error = uniqueError(meta);
    await expect(mapActiveRunConflict(async () => { throw error; })).rejects.toBe(error);
  });

  it("does not treat generic duplicate-key text as an active run", async () => {
    const error = new Error("duplicate key value violates unique constraint Message_pkey");
    await expect(mapActiveRunConflict(async () => { throw error; })).rejects.toBe(error);
  });

  it("preserves non-unique failures even when they mention a known index", async () => {
    const error = new Error('could not access index "ModelRun_one_active_per_chat_idx"');
    await expect(mapActiveRunConflict(async () => { throw error; })).rejects.toBe(error);
  });
});
