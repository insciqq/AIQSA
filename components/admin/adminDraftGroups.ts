import type { AdminGroup } from "@/lib/contracts/admin";

export function activeDraftGroupIds(
  groups: readonly Pick<AdminGroup, "archivedAt" | "id">[],
  groupIds: readonly string[]
): string[] {
  const activeIds = new Set(groups.filter((group) => !group.archivedAt).map((group) => group.id));

  return groupIds.filter((groupId) => activeIds.has(groupId));
}
