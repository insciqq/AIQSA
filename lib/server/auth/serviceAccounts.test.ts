import { describe, expect, it, vi } from "vitest";
import { createServiceAccount, findServiceAccount, isServiceAccount } from "./serviceAccounts";

type Actor = { kind: string; role: string; status: string } | null;

function transaction(actor: Actor) {
  const createUser = vi.fn(async (input: { data: Record<string, unknown> }) => ({
    displayName: input.data.displayName,
    id: "service-1",
    status: input.data.status
  }));
  const createMemorySettings = vi.fn(async () => ({ userId: "service-1" }));
  const upsertSettings = vi.fn(async () => ({}));
  const tx = {
    $queryRaw: vi.fn(async () => []),
    user: { create: createUser, findUnique: vi.fn(async () => actor) },
    userGroup: { upsert: vi.fn() },
    userMemorySettings: { upsert: createMemorySettings },
    userSettings: { upsert: upsertSettings }
  };
  return { createMemorySettings, createUser, tx, upsertSettings };
}

const admin = { kind: "person", role: "admin", status: "active" };

describe("service accounts", () => {
  it("creates an active, emailless, non-administrator service account with Memory off", async () => {
    const { createMemorySettings, createUser, tx, upsertSettings } = transaction(admin);

    await expect(createServiceAccount(tx as never, { createdByUserId: "admin-1", displayName: "  Discord  " }))
      .resolves.toEqual({ account: { displayName: "Discord", id: "service-1", status: "active" }, kind: "created" });
    expect(createUser).toHaveBeenCalledWith(expect.objectContaining({
      data: { displayName: "Discord", email: null, kind: "service", role: "user", status: "active" }
    }));
    // No identity is created: nothing touches AuthIdentity at all.
    expect(tx).not.toHaveProperty("authIdentity");
    expect(upsertSettings).toHaveBeenCalledOnce();
    // The default row may already exist (database default): both branches turn Memory off.
    expect(createMemorySettings).toHaveBeenCalledWith(expect.objectContaining({
      create: { learnAutomatically: false, referenceChatHistory: false, useMemoryFacts: false, userId: "service-1" },
      update: { learnAutomatically: false, referenceChatHistory: false, useMemoryFacts: false },
      where: { userId: "service-1" }
    }));
  });

  it("is created only by an active administrator who is a person", async () => {
    for (const actor of [
      null,
      { ...admin, role: "user" },
      { ...admin, status: "disabled" },
      { ...admin, kind: "service" }
    ]) {
      const { createUser, tx } = transaction(actor);

      await expect(createServiceAccount(tx as never, { createdByUserId: "actor-1", displayName: "Discord" }))
        .resolves.toEqual({ kind: "actor_forbidden" });
      expect(createUser).not.toHaveBeenCalled();
    }
  });

  it("refuses an empty or overlong name before reading anything", async () => {
    for (const displayName of ["", "   ", "x".repeat(161)]) {
      const { tx } = transaction(admin);

      await expect(createServiceAccount(tx as never, { createdByUserId: "admin-1", displayName }))
        .resolves.toEqual({ kind: "display_name_invalid" });
      expect(tx.$queryRaw).not.toHaveBeenCalled();
    }
  });

  it("finds only service accounts and treats rows without a kind as people", async () => {
    const db = (row: object | null) => ({ user: { findUnique: vi.fn(async () => row) } });

    await expect(findServiceAccount(db({ displayName: "Discord", id: "service-1", kind: "service", status: "disabled" }) as never, "service-1"))
      .resolves.toEqual({ displayName: "Discord", id: "service-1", status: "disabled" });
    await expect(findServiceAccount(db({ displayName: "Dana", id: "user-1", kind: "person", status: "active" }) as never, "user-1"))
      .resolves.toBeNull();
    await expect(findServiceAccount(db(null) as never, "missing")).resolves.toBeNull();
    expect(isServiceAccount({})).toBe(false);
    expect(isServiceAccount(null)).toBe(false);
  });
});
