import { Prisma, type PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { createAdminUserAccessCommands } from "./adminUserAccessCommands";

function fixture() {
  let status = "active";
  const direct = { id: "direct", enabled: true, groupId: null, userId: "person", providerConnectionId: null, providerModelId: "model", searchStrategy: null };
  const group = { ...direct, id: "group-grant", groupId: "group", userId: null };
  let grants = [direct, group] as Array<{ id: string; enabled: boolean; groupId: string | null; userId: string | null; providerConnectionId: string | null; providerModelId: string | null; searchStrategy: string | null }>;
  let assignment: { credentialId: string; updatedAt: Date } | null = null;
  let credentialAvailable = true;
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) => Object.entries(where).every(([key, value]) => row[key] === value);
  const tx = {
    accessGrant: {
      create: vi.fn(async ({ data }: { data: typeof direct }) => { const created = { ...data, id: "created" }; grants.push(created); return created; }),
      deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => { grants = grants.filter((row) => !matches(row, where)); return { count: 1 }; }),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => grants.some((row) => matches(row, where)) ? { providerModel: { connectionId: "provider" } } : null),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => grants.filter((row) => matches(row, where)).map(({ id }) => ({ id })))
    },
    providerCredential: { findFirst: vi.fn(async ({ where }: { where: { id: string; connectionId: string } }) => credentialAvailable && where.connectionId === "provider" && where.id === "key" ? { id: "key" } : null) },
    providerModel: { findMany: vi.fn(async () => [{ activeConfig: { answerSelectable: true }, connection: { displayName: "Provider", family: "fake", id: "provider" }, displayName: "Model", id: "model", modelClass: "answer" }]) },
    providerUserCredentialAssignment: {
      deleteMany: vi.fn(async () => { assignment = null; return { count: 1 }; }),
      findUnique: vi.fn(async () => assignment),
      upsert: vi.fn(async ({ create }: { create: { credentialId: string } }) => { assignment = { credentialId: create.credentialId, updatedAt: new Date("2026-09-08T12:00:00.000Z") }; return assignment; })
    },
    searchOption: { findMany: vi.fn(async () => []) },
    user: { findUnique: vi.fn(async () => ({ status })) }
  };
  const client = {
    $transaction: vi.fn(async (operation: (tx: object) => Promise<unknown>) => {
      const before = structuredClone(grants);
      try { return await operation(tx); }
      catch (error) { grants = before; throw error; }
    })
  } as unknown as PrismaClient;
  return {
    client, commands: createAdminUserAccessCommands(client), tx,
    get assignment() { return assignment; }, get grants() { return grants; },
    disableCredential() { credentialAvailable = false; }, disableUser() { status = "disabled"; }
  };
}

describe("direct user access commands", () => {
  it("removes an overlapping direct grant without changing the group grant, even when the user is disabled", async () => {
    const f = fixture();
    f.disableUser();
    await expect(f.commands.setUserGrants({
      changes: [{ enabled: false, modelId: "model", provider: "provider" }], expectedGrantIds: ["direct"], userId: "person"
    })).resolves.toBe("applied");
    expect(f.grants.map(({ id }) => id)).toEqual(["group-grant"]);
    expect(f.tx.providerModel.findMany).not.toHaveBeenCalled();
  });

  it("rejects stale direct-grant state and rolls back a batch with an unavailable target", async () => {
    const f = fixture();
    await expect(f.commands.setUserGrants({ changes: [{ enabled: true, provider: "provider" }], expectedGrantIds: [], userId: "person" })).resolves.toBe("user_access_stale");
    await expect(f.commands.setUserGrants({
      changes: [{ enabled: false, modelId: "model", provider: "provider" }, { enabled: true, provider: "unavailable" }], expectedGrantIds: ["direct"], userId: "person"
    })).resolves.toBe("user_grant_invalid");
    expect(f.grants.map(({ id }) => id)).toEqual(["direct", "group-grant"]);
  });

  it("adds a provider grant only from the server catalog and never updates group authority", async () => {
    const f = fixture();
    await expect(f.commands.setUserGrants({ changes: [{ enabled: true, provider: "provider" }], expectedGrantIds: ["direct"], userId: "person" })).resolves.toBe("applied");
    expect(f.grants.find(({ id }) => id === "created")).toMatchObject({ groupId: null, providerConnectionId: "provider", userId: "person" });
    expect(f.grants.find(({ id }) => id === "group-grant")).toMatchObject({ groupId: "group", enabled: true });
    expect(f.client.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  });

  it("assigns an exact usable key, refuses stale replacement and removes a now-disabled override", async () => {
    const f = fixture();
    const empty = { connectionId: "provider", credentialId: "key", expectedCredentialId: null, expectedUpdatedAt: null, userId: "person" };
    await expect(f.commands.setUserCredential(empty)).resolves.toBe("applied");
    await expect(f.commands.setUserCredential({ ...empty, credentialId: null })).resolves.toBe("user_access_stale");
    const current = f.assignment!;
    f.disableCredential();
    await expect(f.commands.setUserCredential({ ...empty, expectedCredentialId: current.credentialId, expectedUpdatedAt: current.updatedAt.toISOString() })).resolves.toBe("user_credential_invalid");
    f.disableUser();
    await expect(f.commands.setUserCredential({ ...empty, credentialId: null, expectedCredentialId: current.credentialId, expectedUpdatedAt: current.updatedAt.toISOString() })).resolves.toBe("applied");
    expect(f.assignment).toBeNull();
  });

  it("rejects cross-provider credentials without writing an assignment", async () => {
    const f = fixture();
    await expect(f.commands.setUserCredential({ connectionId: "other-provider", credentialId: "key", expectedCredentialId: null, expectedUpdatedAt: null, userId: "person" })).resolves.toBe("user_credential_invalid");
    expect(f.tx.providerUserCredentialAssignment.upsert).not.toHaveBeenCalled();
  });
});
