import type { AdminMembership } from "@/lib/contracts/admin";

export type AdminMembershipSource = Readonly<{
  group?: Readonly<{ name: string }> | null;
  groupId: string;
  role: string;
}>;

export type AdminGroupNameLookup = ReadonlyMap<string, Readonly<{ name: string }>>;

export function serializeAdminDate(value: Date | string | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

export function serializeAdminMemberships(
  memberships: readonly AdminMembershipSource[],
  groupNamesById?: AdminGroupNameLookup
): AdminMembership[] {
  return memberships.flatMap((membership) => {
    const group = membership.group ?? groupNamesById?.get(membership.groupId);

    return group
      ? [
          {
            groupId: membership.groupId,
            name: group.name,
            role: membership.role
          }
        ]
      : [];
  });
}
