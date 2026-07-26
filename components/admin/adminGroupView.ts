import { providerDisplayName } from "@/components/admin/adminViewUtils";
import type {
  AdminAccessGrantRecord,
  AdminCatalog,
  AdminDeletionInfo,
  AdminGroup
} from "@/lib/contracts/admin";

export type AdminGroupStatusFilter = "active" | "all" | "archived";
export type AdminGrantTarget = Readonly<{
  modelId?: string | null;
  provider?: string | null;
  searchStrategy?: string | null;
}>;

export function activeGroups(groups: readonly AdminGroup[]): AdminGroup[] {
  return groups.filter((group) => !group.archivedAt);
}

export function filterAdminGroups(
  groups: readonly AdminGroup[],
  catalog: AdminCatalog,
  query: string,
  statusFilter: AdminGroupStatusFilter
): AdminGroup[] {
  const normalizedQuery = query.trim().toLowerCase();

  return groups.filter((group) => {
    const archived = Boolean(group.archivedAt);
    const matchesStatus =
      statusFilter === "all" ||
      (statusFilter === "active" && !archived) ||
      (statusFilter === "archived" && archived);
    const haystack = [group.name, groupAccessSummary(catalog, group)].join(" ").toLowerCase();

    return matchesStatus && (!normalizedQuery || haystack.includes(normalizedQuery));
  });
}

export function resolveAdminGroupSelection(
  groups: readonly AdminGroup[],
  selectedGroupId: string | null
): AdminGroup | null {
  return selectedGroupId
    ? groups.find((group) => group.id === selectedGroupId) ?? null
    : null;
}

function enabledGrants(group: AdminGroup): AdminAccessGrantRecord[] {
  return group.accessGrants.filter((grant) => grant.enabled);
}

export function enabledGrantCount(group: AdminGroup): number {
  return enabledGrants(group).length;
}

export function grantCounts(group: AdminGroup): { models: number; providers: number; search: number } {
  const grants = enabledGrants(group);

  return {
    models: grants.filter((grant) => grant.provider && grant.modelId).length,
    providers: grants.filter((grant) => grant.provider && !grant.modelId && !grant.searchStrategy).length,
    search: grants.filter((grant) => grant.searchStrategy).length
  };
}

export function groupAccessState(group: AdminGroup): { className: string; label: string } {
  if (group.systemRole === "full_access") {
    return {
      className: "border-positive/25 bg-positive/10 text-positive",
      label: "full access"
    };
  }

  if (group.archivedAt) {
    return {
      className: "border-trace-subtle bg-control-surface text-ink-secondary",
      label: "archived"
    };
  }

  const counts = grantCounts(group);

  if (!enabledGrantCount(group)) {
    return {
      className: "border-caution/25 bg-caution/10 text-caution",
      label: "no access"
    };
  }

  if (counts.providers) {
    return {
      className: "border-caution/25 bg-caution/10 text-caution",
      label: "broad access"
    };
  }

  return {
    className: "border-positive/25 bg-positive/10 text-positive",
    label: "configured"
  };
}

export function groupAccessSummary(catalog: AdminCatalog, group: AdminGroup): string {
  if (group.systemRole === "full_access") {
    return "Automatic entitlement to all current and future providers, models, search strategies, and MCP servers.";
  }

  const counts = grantCounts(group);

  if (group.archivedAt) {
    return "Archived groups no longer apply grants.";
  }

  if (!enabledGrantCount(group)) {
    return "No provider, model, or search access.";
  }

  const providerNames = enabledGrants(group)
    .filter((grant) => grant.provider && !grant.modelId && !grant.searchStrategy)
    .map((grant) => providerDisplayName(catalog, grant.provider!));
  const parts = [
    providerNames.length ? `All ${providerNames.join(", ")} models` : null,
    counts.models ? `${counts.models} explicit model${counts.models === 1 ? "" : "s"}` : null,
    counts.search ? `${counts.search} search strateg${counts.search === 1 ? "y" : "ies"}` : null
  ].filter(Boolean);

  return parts.join(" / ");
}

export function providerModelCount(catalog: Pick<AdminCatalog, "models">, providerId: string): number {
  return catalog.models.filter((model) => model.provider === providerId).length;
}

export function grantEnabled(group: AdminGroup, target: AdminGrantTarget): boolean {
  return group.accessGrants.some(
    (grant) =>
      grant.enabled &&
      (grant.provider ?? null) === (target.provider ?? null) &&
      (grant.modelId ?? null) === (target.modelId ?? null) &&
      (grant.searchStrategy ?? null) === (target.searchStrategy ?? null)
  );
}

export function groupDeletionInfo(group: AdminGroup): AdminDeletionInfo {
  if (group.deletion) {
    return group.deletion;
  }

  if (group.systemRole === "full_access") {
    return {
      canDelete: false,
      reason: "system_group_forbidden",
      summary: "Built-in groups cannot be renamed, archived, or deleted."
    };
  }

  return {
    canDelete: group.userCount === 0 && enabledGrantCount(group) === 0,
    reason: group.userCount > 0 ? "group_has_members" : enabledGrantCount(group) > 0 ? "group_has_grants" : null,
    summary:
      group.userCount > 0
        ? "Remove members before deleting this group."
        : enabledGrantCount(group) > 0
          ? "Remove active grants before deleting this group."
          : "No members or active grants; this group can be deleted."
  };
}
