import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

const calls = vi.hoisted(() => [] as string[]);

vi.mock("../background/legacyMemoryRows", () => ({
  async purgeLegacyMemoryRowsOfAccount(_tx: unknown, userId: string) { calls.push(`legacy:${userId}`); }
}));
vi.mock("../mcp/personalArchive", () => ({
  async archivePersonalMcpServers(_tx: unknown, input: { ownerUserId: string }) { calls.push(`archive:${input.ownerUserId}`); }
}));
vi.mock("../telemetry/store", () => ({
  async clearTelemetryIncidentUser(_tx: unknown, userId: string) { calls.push(`telemetry:${userId}`); }
}));
vi.mock("./signInRefusals", () => ({
  async deleteSignInRefusalsOfEmails() { calls.push("refusals"); }
}));
vi.mock("./transactionLocks", () => ({
  async lockActiveAdmins() { return []; },
  async lockAuthUser() { calls.push("lock"); }
}));

import { createAdminUserSessionCommands } from "./adminUserSessionCommands";

/** A transaction whose every count is zero unless named, with one stale user. */
function fakePrisma(input: { counts?: Record<string, number>; status?: string; user?: boolean }) {
  const counts = input.counts ?? {};
  const tx = new Proxy({} as Record<string, unknown>, {
    get(_target, model: string) {
      if (model === "user") {
        return {
          async delete({ where }: { where: { id: string } }) { calls.push(`delete:${where.id}`); },
          async findUnique() {
            return input.user === false ? null : {
              authIdentities: [{ normalizedEmail: "stale@example.com" }], email: "stale@example.com",
              id: "user-1", status: input.status ?? "disabled"
            };
          }
        };
      }
      return { count: async () => counts[model] ?? 0 };
    }
  });
  return {
    $transaction: async (work: (client: unknown) => Promise<unknown>) => work(tx)
  } as unknown as PrismaClient;
}

beforeEach(() => {
  calls.length = 0;
});

describe("stale account deletion", () => {
  it("deletes the account in one step, its old Memory rows first, without the Memory coordinator", async () => {
    const commands = createAdminUserSessionCommands(fakePrisma({}));
    await expect(commands.deleteStaleUser({ actingAdminUserId: "admin-1", userId: "user-1" })).resolves.toBe("deleted");
    expect(calls).toEqual(["lock", "legacy:user-1", "telemetry:user-1", "refusals", "delete:user-1"]);
  });

  it("stays pending while personal MCP servers drain, then completes", async () => {
    const kick = vi.fn();
    const pending = createAdminUserSessionCommands(fakePrisma({ counts: { mcpServer: 1 } }), { accountMcpDeletionKick: kick });
    await expect(pending.deleteStaleUser({ actingAdminUserId: "admin-1", userId: "user-1" })).resolves.toBe("deletion_pending");
    expect(calls).toEqual(["lock", "archive:user-1"]);
    expect(kick).toHaveBeenCalledOnce();

    calls.length = 0;
    const drained = createAdminUserSessionCommands(fakePrisma({}), { accountMcpDeletionKick: kick });
    await expect(drained.deleteStaleUser({ actingAdminUserId: "admin-1", userId: "user-1" })).resolves.toBe("deleted");
    expect(calls).toContain("delete:user-1");
  });

  it("refuses an account that still owns chats or is active, and changes nothing", async () => {
    for (const [prisma, expected] of [
      [fakePrisma({ counts: { chat: 2 } }), "user_has_owned_data"],
      [fakePrisma({ status: "active" }), "user_active"],
      [fakePrisma({ user: false }), "not_found"]
    ] as const) {
      calls.length = 0;
      const commands = createAdminUserSessionCommands(prisma);
      await expect(commands.deleteStaleUser({ actingAdminUserId: "admin-1", userId: "user-1" })).resolves.toBe(expected);
      expect(calls.filter((call) => call.startsWith("legacy") || call.startsWith("delete"))).toEqual([]);
    }
  });

  it("never deletes the acting administrator", async () => {
    const commands = createAdminUserSessionCommands(fakePrisma({}));
    await expect(commands.deleteStaleUser({ actingAdminUserId: "user-1", userId: "user-1" }))
      .resolves.toBe("self_delete_forbidden");
    expect(calls).toEqual([]);
  });
});
