import { describe, expect, it, vi } from "vitest";
import { applyMembershipChange, syncExternalGroups } from "./groupMembership";

type Membership = { groupId: string; role: string; userId: string };
type GroupIdFilter = string | { in: string[] };

/** A small in-memory store answering exactly the queries the membership service sends. */
function membershipStore(input: {
  archived?: string[];
  externalNames?: { groupId: string; source: string; value: string }[];
  grants?: { canUse: boolean; groupId: string | null; serverId: string; userId: string | null }[];
  memberships?: Membership[];
  userServers?: { desiredRuntimeGenerationId: string | null; enabled: boolean; serverId: string; userId: string }[];
}) {
  const archived = new Set(input.archived ?? []);
  const memberships = [...(input.memberships ?? [])];
  const grants = input.grants ?? [];
  const userServers = input.userServers ?? [];
  const matchesGroup = (groupId: string, filter?: GroupIdFilter) =>
    filter === undefined || (typeof filter === "string" ? filter === groupId : filter.in.includes(groupId));
  const tx = {
    groupExternalName: {
      findMany: vi.fn(async ({ where }: { where: { source: string } }) =>
        (input.externalNames ?? []).filter((name) => name.source === where.source && !archived.has(name.groupId)))
    },
    mcpGrant: {
      count: vi.fn(async ({ where }: {
        where: { OR: ({ groupId: { in: string[] } } | { userId: string })[]; serverId: string };
      }) => grants.filter((grant) => grant.canUse && grant.serverId === where.serverId && where.OR.some((option) =>
        "userId" in option ? grant.userId === option.userId : grant.groupId !== null && option.groupId.in.includes(grant.groupId)
      )).length),
      findMany: vi.fn(async ({ where }: { where: { groupId: { in: string[] } } }) => [
        ...new Set(grants
          .filter((grant) => grant.canUse && grant.groupId !== null && where.groupId.in.includes(grant.groupId))
          .map((grant) => grant.serverId))
      ].map((serverId) => ({ serverId })))
    },
    mcpUserServer: {
      updateMany: vi.fn(async ({ data, where }: {
        data: { desiredRuntimeGenerationId?: null; enabled?: boolean };
        where: { serverId: GroupIdFilter; userId: string };
      }) => {
        const rows = userServers.filter((row) => row.userId === where.userId && matchesGroup(row.serverId, where.serverId));
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      })
    },
    userGroup: {
      create: vi.fn(async ({ data }: { data: Membership }) => {
        memberships.push(data);
        return data;
      }),
      deleteMany: vi.fn(async ({ where }: { where: { groupId: { in: string[] }; userId: string } }) => {
        const before = memberships.length;
        for (let index = memberships.length - 1; index >= 0; index -= 1) {
          const membership = memberships[index]!;
          if (membership.userId === where.userId && where.groupId.in.includes(membership.groupId)) {
            memberships.splice(index, 1);
          }
        }
        return { count: before - memberships.length };
      }),
      findMany: vi.fn(async ({ where }: { where: { group?: { archivedAt: null }; groupId?: GroupIdFilter; userId: string } }) =>
        memberships
          .filter((membership) => membership.userId === where.userId && matchesGroup(membership.groupId, where.groupId) &&
            !(where.group && archived.has(membership.groupId)))
          .map(({ groupId }) => ({ groupId })))
    }
  };

  return { memberships, tx, userServers };
}

function groupsOf(memberships: Membership[], userId = "user-1"): string[] {
  return memberships.filter((membership) => membership.userId === userId).map((membership) => membership.groupId).sort();
}

describe("external group sync", () => {
  it("adds mapped groups and removes only managed ones the source no longer lists", async () => {
    const store = membershipStore({
      archived: ["archived-mapped"],
      externalNames: [
        { groupId: "engineering", source: "oidc", value: "/engineering" },
        { groupId: "admins", source: "oidc", value: "aiqsa-admins" },
        { groupId: "archived-mapped", source: "oidc", value: "/engineering" },
        { groupId: "directory", source: "ldap", value: "/engineering" }
      ],
      memberships: [
        { groupId: "admins", role: "member", userId: "user-1" },
        { groupId: "manual", role: "owner", userId: "user-1" },
        { groupId: "directory", role: "member", userId: "user-1" },
        { groupId: "archived-mapped", role: "member", userId: "user-1" }
      ]
    });

    await expect(syncExternalGroups(store.tx as never, {
      source: "oidc",
      userId: "user-1",
      values: ["/engineering", "unmapped", "/Engineering"]
    })).resolves.toEqual({ added: 1, removed: 1 });

    expect(groupsOf(store.memberships)).toEqual(["archived-mapped", "directory", "engineering", "manual"]);
    expect(store.memberships.find((membership) => membership.groupId === "engineering")?.role).toBe("member");
    expect(store.memberships.find((membership) => membership.groupId === "manual")?.role).toBe("owner");
  });

  it("changes nothing when the claim is missing or nothing differs", async () => {
    const store = membershipStore({
      externalNames: [{ groupId: "engineering", source: "saml", value: "engineering" }],
      memberships: [{ groupId: "engineering", role: "member", userId: "user-1" }]
    });

    await expect(syncExternalGroups(store.tx as never, { source: "saml", userId: "user-1", values: null }))
      .resolves.toEqual({ added: 0, removed: 0, warning: "groups_claim_missing" });
    expect(store.tx.groupExternalName.findMany).not.toHaveBeenCalled();
    await expect(syncExternalGroups(store.tx as never, { source: "saml", userId: "user-1", values: ["engineering"] }))
      .resolves.toEqual({ added: 0, removed: 0 });
    await expect(syncExternalGroups(store.tx as never, { source: "ldap", userId: "user-1", values: [] }))
      .resolves.toEqual({ added: 0, removed: 0 });
    expect(store.tx.userGroup.create).not.toHaveBeenCalled();
    expect(store.tx.userGroup.deleteMany).not.toHaveBeenCalled();
    expect(groupsOf(store.memberships)).toEqual(["engineering"]);
  });
});

describe("membership change side effects", () => {
  it("re-resolves every MCP server the user's groups grant and switches off the ones it loses", async () => {
    const store = membershipStore({
      grants: [
        { canUse: true, groupId: "leaving", serverId: "lost", userId: null },
        { canUse: true, groupId: "leaving", serverId: "kept-by-user", userId: null },
        { canUse: true, groupId: null, serverId: "kept-by-user", userId: "user-1" },
        { canUse: true, groupId: "staying", serverId: "unchanged", userId: null },
        { canUse: true, groupId: "joining", serverId: "gained", userId: null }
      ],
      memberships: [
        { groupId: "leaving", role: "member", userId: "user-1" },
        { groupId: "staying", role: "member", userId: "user-1" }
      ],
      userServers: ["lost", "kept-by-user", "unchanged", "gained", "elsewhere"].map((serverId) => ({
        desiredRuntimeGenerationId: `generation-${serverId}`,
        enabled: true,
        serverId,
        userId: "user-1"
      }))
    });

    await expect(applyMembershipChange(store.tx as never, { add: ["joining"], remove: ["leaving"], userId: "user-1" }))
      .resolves.toEqual({ added: 1, removed: 1 });

    expect(groupsOf(store.memberships)).toEqual(["joining", "staying"]);
    expect(Object.fromEntries(store.userServers.map((row) => [row.serverId, row]))).toEqual({
      elsewhere: { desiredRuntimeGenerationId: "generation-elsewhere", enabled: true, serverId: "elsewhere", userId: "user-1" },
      gained: { desiredRuntimeGenerationId: null, enabled: true, serverId: "gained", userId: "user-1" },
      "kept-by-user": { desiredRuntimeGenerationId: null, enabled: true, serverId: "kept-by-user", userId: "user-1" },
      lost: { desiredRuntimeGenerationId: null, enabled: false, serverId: "lost", userId: "user-1" },
      unchanged: { desiredRuntimeGenerationId: null, enabled: true, serverId: "unchanged", userId: "user-1" }
    });
  });
});
