import { describe, expect, it, vi } from "vitest";
import { loadEntitlementsForUser } from "./dbEntitlements";

describe("database entitlement loader", () => {
  it("derives full access from an active system-group membership without grant rows", async () => {
    const accessGrantFindMany = vi.fn(async () => []);
    const userGroupFindMany = vi.fn(async () => [{
      group: { systemRole: "full_access" },
      groupId: "full-access"
    }]);

    const entitlements = await loadEntitlementsForUser("user-1", {
      accessGrant: { findMany: accessGrantFindMany },
      userGroup: { findMany: userGroupFindMany }
    } as never);

    expect(entitlements.fullAccess).toBe(true);
    expect(entitlements.modelKeys).toEqual(new Set());
    expect(entitlements.searchStrategies).toEqual(new Set());
    expect(userGroupFindMany).toHaveBeenCalledWith({
      select: {
        group: { select: { systemRole: true } },
        groupId: true
      },
      where: {
        group: { archivedAt: null },
        userId: "user-1"
      }
    });
    expect(accessGrantFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        OR: [
          { userId: "user-1" },
          { groupId: { in: ["full-access"] } }
        ]
      }
    }));
  });

  it("does not derive the wildcard from an absent active full-access membership", async () => {
    const entitlements = await loadEntitlementsForUser("user-1", {
      accessGrant: { findMany: vi.fn(async () => []) },
      userGroup: { findMany: vi.fn(async () => []) }
    } as never);

    expect(entitlements.fullAccess).toBe(false);
  });
});
