import { describe, expect, it } from "vitest";
import {
  adminGroupDeletionBlock,
  adminGroupDeletionInfo,
  adminInviteDeletionBlock,
  adminInviteDeletionInfo,
  adminOwnedAppDataCount,
  adminUserDeletionBlock,
  adminUserDeletionInfo,
  adminUserOwnedDataCount,
  type AdminUserOwnedDataSource
} from "./adminDeletionMetadata";

function ownedDataSource(
  counts: Partial<AdminUserOwnedDataSource["_count"]> = {},
  settings: unknown | null = null
): AdminUserOwnedDataSource {
  return {
    _count: {
      accessGrants: 0,
      attachments: 0,
      chats: 0,
      folders: 0,
      modelRuns: 0,
      promptPresets: 0,
      sharedSnapshots: 0,
      usageEvents: 0,
      ...counts
    },
    settings
  };
}

describe("admin deletion metadata", () => {
  it("gives active status precedence over owned data and keeps exact user guard copy", () => {
    expect(
      adminUserDeletionBlock({
        ownedDataCount: 4,
        status: "active"
      })
    ).toBe("user_active");
    expect(
      adminUserDeletionBlock({
        ownedDataCount: 1,
        status: "disabled"
      })
    ).toBe("user_has_owned_data");
    expect(
      adminUserDeletionBlock({
        ownedDataCount: 0,
        status: "pending"
      })
    ).toBeNull();
    expect(
      adminUserDeletionInfo({
        ownedDataCount: 4,
        status: "active"
      })
    ).toEqual({
      canDelete: false,
      reason: "active_user",
      summary: "Disable this user before deletion can be considered."
    });

    expect(
      adminUserDeletionInfo({
        ownedDataCount: 1,
        status: "disabled"
      })
    ).toEqual({
      canDelete: false,
      reason: "user_has_owned_data",
      summary: "1 owned app record keep this account as disabled history."
    });

    expect(
      adminUserDeletionInfo({
        ownedDataCount: 2,
        status: "denied"
      })
    ).toEqual({
      canDelete: false,
      reason: "user_has_owned_data",
      summary: "2 owned app records keep this account as disabled history."
    });

    expect(
      adminUserDeletionInfo({
        ownedDataCount: 0,
        status: "pending"
      })
    ).toEqual({
      canDelete: true,
      reason: null,
      summary: "No app-owned records detected; auth request data can be removed."
    });
  });

  it("gives members precedence over grants and ignores disabled grants", () => {
    expect(
      adminGroupDeletionBlock({
        activeGrantCount: 2,
        memberCount: 2
      })
    ).toBe("group_has_members");
    expect(
      adminGroupDeletionBlock({
        activeGrantCount: 2,
        memberCount: 0
      })
    ).toBe("group_has_grants");
    expect(
      adminGroupDeletionBlock({
        activeGrantCount: 0,
        memberCount: 0
      })
    ).toBeNull();

    expect(
      adminGroupDeletionInfo({
        _count: { users: 2 },
        accessGrants: [{ enabled: true }, { enabled: true }]
      })
    ).toEqual({
      canDelete: false,
      reason: "group_has_members",
      summary: "Remove 2 members before deleting this group."
    });

    expect(
      adminGroupDeletionInfo({
        _count: { users: 1 },
        accessGrants: []
      })
    ).toEqual({
      canDelete: false,
      reason: "group_has_members",
      summary: "Remove 1 member before deleting this group."
    });

    expect(
      adminGroupDeletionInfo({
        _count: { users: 0 },
        accessGrants: [{ enabled: true }, { enabled: true }, { enabled: false }]
      })
    ).toEqual({
      canDelete: false,
      reason: "group_has_grants",
      summary: "Remove 2 active grants before deleting this group."
    });

    expect(
      adminGroupDeletionInfo({
        _count: { users: 0 },
        accessGrants: [{ enabled: true }]
      })
    ).toEqual({
      canDelete: false,
      reason: "group_has_grants",
      summary: "Remove 1 active grant before deleting this group."
    });

    expect(
      adminGroupDeletionInfo({
        _count: { users: 0 },
        accessGrants: [{ enabled: false }]
      })
    ).toEqual({
      canDelete: true,
      reason: null,
      summary: "No members or active grants; this group can be deleted."
    });
  });

  it("keeps accepted invites, treats only unrevoked future invites as open, and includes the expiry boundary", () => {
    const now = new Date("2026-07-12T12:00:00.000Z");
    const stale = {
      canDelete: true,
      reason: null,
      summary: "This stale invite can be deleted."
    };

    expect(
      adminInviteDeletionBlock(
        {
          acceptedAt: new Date("2026-07-10T00:00:00.000Z"),
          expiresAt: new Date("2026-07-19T12:00:00.000Z"),
          revokedAt: new Date("2026-07-11T00:00:00.000Z")
        },
        now
      )
    ).toBe("invite_accepted");
    expect(
      adminInviteDeletionBlock(
        {
          acceptedAt: null,
          expiresAt: new Date("2026-07-19T12:00:00.000Z"),
          revokedAt: null
        },
        now
      )
    ).toBe("invite_open");
    expect(
      adminInviteDeletionBlock(
        {
          acceptedAt: null,
          expiresAt: now,
          revokedAt: null
        },
        now
      )
    ).toBeNull();

    expect(
      adminInviteDeletionInfo(
        {
          acceptedAt: new Date("2026-07-10T00:00:00.000Z"),
          expiresAt: new Date("2026-07-11T00:00:00.000Z"),
          revokedAt: new Date("2026-07-09T00:00:00.000Z")
        },
        now
      )
    ).toEqual({
      canDelete: false,
      reason: "invite_accepted",
      summary: "Accepted invites are kept for audit history."
    });

    expect(
      adminInviteDeletionInfo(
        {
          acceptedAt: null,
          expiresAt: new Date("2026-07-12T12:00:00.001Z"),
          revokedAt: null
        },
        now
      )
    ).toEqual({
      canDelete: false,
      reason: "invite_open",
      summary: "Revoke this open invite before deleting it."
    });

    expect(
      adminInviteDeletionInfo(
        {
          acceptedAt: null,
          expiresAt: now,
          revokedAt: null
        },
        now
      )
    ).toEqual(stale);
    expect(
      adminInviteDeletionInfo(
        {
          acceptedAt: null,
          expiresAt: new Date("2026-07-12T11:59:59.999Z"),
          revokedAt: null
        },
        now
      )
    ).toEqual(stale);
    expect(
      adminInviteDeletionInfo(
        {
          acceptedAt: null,
          expiresAt: new Date("2026-07-19T12:00:00.000Z"),
          revokedAt: new Date("2026-07-12T11:00:00.000Z")
        },
        now
      )
    ).toEqual(stale);
  });

  it("counts every app-owned relation and settings without counting null settings", () => {
    const countFields: Array<keyof AdminUserOwnedDataSource["_count"]> = [
      "accessGrants",
      "attachments",
      "chats",
      "folders",
      "modelRuns",
      "promptPresets",
      "sharedSnapshots",
      "usageEvents"
    ];

    expect(adminUserOwnedDataCount(ownedDataSource())).toBe(0);

    for (const field of countFields) {
      const counts = {
        accessGrants: 0,
        attachments: 0,
        chats: 0,
        folders: 0,
        modelRuns: 0,
        promptPresets: 0,
        sharedSnapshots: 0,
        usageEvents: 0
      };
      counts[field] = 2;

      expect(adminUserOwnedDataCount(ownedDataSource(counts)), field).toBe(2);
    }

    expect(adminUserOwnedDataCount(ownedDataSource({}, {}))).toBe(1);
    expect(
      adminUserOwnedDataCount(
        ownedDataSource(
          {
            accessGrants: 1,
            attachments: 2,
            chats: 3,
            folders: 4,
            modelRuns: 5,
            promptPresets: 6,
            sharedSnapshots: 7,
            usageEvents: 8
          },
          {}
        )
      )
    ).toBe(37);
    expect(
      adminOwnedAppDataCount({
        accessGrants: 1,
        attachments: 2,
        chats: 3,
        folders: 4,
        modelRuns: 5,
        promptPresets: 6,
        settings: 7,
        sharedSnapshots: 8,
        usageEvents: 9
      })
    ).toBe(45);
  });
});
