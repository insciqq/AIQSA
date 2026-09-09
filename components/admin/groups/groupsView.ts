import type {
  AdminCatalog,
  AdminDeletionInfo,
  AdminGroup,
  AdminGroupGrantChange,
  AdminUserRecord
} from "@/lib/contracts/admin";
import type { AdminProviderConnection } from "@/lib/contracts/adminProviders";

/**
 * Presentation rules for the Groups section (PRD 5.9): the list filters and
 * summaries, the per-provider access state of one group, the read-only key
 * line, and the member candidates. Everything derives from the dashboard and
 * the provider catalog; the browser adds no state of its own.
 */

export type AdminGroupStatusFilter = "active" | "all" | "archived";

export const adminGroupStatusFilters: readonly AdminGroupStatusFilter[] = ["active", "all", "archived"];

export const ADMIN_GROUP_FILTER_LABEL: Readonly<Record<AdminGroupStatusFilter, string>> = {
  active: "Active",
  all: "All",
  archived: "Archived"
};

/** Rows shown before `Show N more` takes over. */
export const ADMIN_GROUPS_PAGE_SIZE = 50;

export type AdminGroupGrantTarget = Readonly<{
  modelId?: string;
  provider?: string;
  searchStrategy?: string;
}>;

/** Access of one group to one provider: everything (including future models), a model subset, or nothing. */
export type AdminGroupProviderAccess =
  | Readonly<{ kind: "all" }>
  | Readonly<{ kind: "some"; modelIds: readonly string[] }>
  | Readonly<{ kind: "none" }>;

export function isFullAccessGroup(group: Pick<AdminGroup, "systemRole">): boolean {
  return group.systemRole === "full_access";
}

export function groupMatchesFilter(group: Pick<AdminGroup, "archivedAt">, filter: AdminGroupStatusFilter): boolean {
  if (filter === "all") return true;
  return filter === "archived" ? group.archivedAt !== null : group.archivedAt === null;
}

export function adminGroupFilterCounts(
  groups: readonly Pick<AdminGroup, "archivedAt">[]
): Record<AdminGroupStatusFilter, number> {
  const archived = groups.filter((group) => group.archivedAt !== null).length;
  return { active: groups.length - archived, all: groups.length, archived };
}

function enabledGrants(group: Pick<AdminGroup, "accessGrants">) {
  return group.accessGrants.filter((grant) => grant.enabled);
}

export function grantEnabled(group: Pick<AdminGroup, "accessGrants">, target: AdminGroupGrantTarget): boolean {
  return group.accessGrants.some(
    (grant) =>
      grant.enabled &&
      (grant.provider ?? null) === (target.provider ?? null) &&
      (grant.modelId ?? null) === (target.modelId ?? null) &&
      (grant.searchStrategy ?? null) === (target.searchStrategy ?? null)
  );
}

export function providerAccess(group: Pick<AdminGroup, "accessGrants">, providerId: string): AdminGroupProviderAccess {
  const grants = enabledGrants(group).filter((grant) => grant.provider === providerId && !grant.searchStrategy);
  if (grants.some((grant) => !grant.modelId)) return { kind: "all" };
  const modelIds = grants.map((grant) => grant.modelId).filter((modelId): modelId is string => modelId !== null);
  return modelIds.length ? { kind: "some", modelIds } : { kind: "none" };
}

/** The provider row's second line: what the switch or checklist currently means. */
export function providerAccessLabel(access: AdminGroupProviderAccess, grantableModelCount: number): string {
  switch (access.kind) {
    case "all":
      return "All models, including ones added later";
    case "some": {
      const granted = access.modelIds.length;
      return granted >= grantableModelCount && grantableModelCount > 0
        ? "All current models"
        : `${granted} of ${grantableModelCount} models`;
    }
    case "none":
      return "No access";
  }
}

export function catalogModelsForProvider(
  catalog: Pick<AdminCatalog, "models">,
  providerId: string
): AdminCatalog["models"] {
  return [...new Map(catalog.models
    .filter((model) => model.provider === providerId)
    .map((model) => [model.modelId, model])).values()];
}

export function catalogSearchSources(catalog: Pick<AdminCatalog, "searchStrategies">): AdminCatalog["searchStrategies"] {
  return [...new Map(catalog.searchStrategies.map((source) => [source.strategyId, source])).values()];
}

/** Current identities only; an existing provider-wide grant remains intact when granting. */
export function groupModelChanges(group: Pick<AdminGroup, "accessGrants">, catalog: AdminCatalog, enabled: boolean): AdminGroupGrantChange[] {
  const changes: AdminGroupGrantChange[] = [];
  for (const providerId of new Set(catalog.providers.map((provider) => provider.id))) {
    const models = catalogModelsForProvider(catalog, providerId);
    const access = providerAccess(group, providerId);
    if (enabled && access.kind === "all") continue;
    if (!enabled && models.length && access.kind === "all") {
      changes.push({ enabled: false, provider: providerId });
    }
    for (const model of models) {
      const target = { modelId: model.modelId, provider: providerId };
      if (grantEnabled(group, target) !== enabled) changes.push({ ...target, enabled });
    }
  }
  return changes;
}

export function groupSearchChanges(group: Pick<AdminGroup, "accessGrants">, catalog: AdminCatalog, enabled: boolean): AdminGroupGrantChange[] {
  return catalogSearchSources(catalog)
    .filter((source) => grantEnabled(group, { searchStrategy: source.strategyId }) !== enabled)
    .map((source) => ({ enabled, searchStrategy: source.strategyId }));
}

export type AdminGroupAccessCounts = Readonly<{
  /** Models the group can use now: every model of a provider-wide grant plus the explicit ones. */
  models: number;
  providers: number;
  search: number;
}>;

/** Effective counts against the current catalog; grants on retired models or Search sources do not count. */
export function groupAccessCounts(group: Pick<AdminGroup, "accessGrants">, catalog: AdminCatalog): AdminGroupAccessCounts {
  const modelKeys = new Set<string>();
  let providers = 0;
  for (const providerId of new Set(catalog.providers.map((provider) => provider.id))) {
    const access = providerAccess(group, providerId);
    if (access.kind === "none") continue;
    providers += 1;
    const providerModels = catalogModelsForProvider(catalog, providerId);
    if (access.kind === "all") {
      for (const model of providerModels) modelKeys.add(JSON.stringify([providerId, model.modelId]));
    } else {
      const known = new Set(providerModels.map((model) => model.modelId));
      for (const modelId of access.modelIds) {
        if (known.has(modelId)) modelKeys.add(JSON.stringify([providerId, modelId]));
      }
    }
  }
  const search = catalogSearchSources(catalog).filter((source) => grantEnabled(group, { searchStrategy: source.strategyId })).length;
  return { models: modelKeys.size, providers, search };
}

function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/** `22 models · 2 Search sources`, `Everything`, `No access` or `Archived` for the list column. */
export function groupAccessSummary(group: AdminGroup, catalog: AdminCatalog): string {
  if (isFullAccessGroup(group)) return "Everything, including providers and servers added later";
  if (group.archivedAt) return "Archived · grants no longer apply";
  const counts = groupAccessCounts(group, catalog);
  if (!counts.models && !counts.search) return "No access";
  return [
    counts.models ? count(counts.models, "model") : null,
    counts.search ? count(counts.search, "Search source") : null
  ].filter((part): part is string => part !== null).join(" · ");
}

/** `3 members · 22 models · 2 Search sources · 4 MCP servers` under the page title. */
export function groupHeaderSummary(
  group: AdminGroup,
  catalog: AdminCatalog,
  mcpServerCount: number | null
): string {
  const members = count(group.userCount, "member");
  if (isFullAccessGroup(group)) return `${members} · every provider, model, Search source and MCP server`;
  const counts = groupAccessCounts(group, catalog);
  return [
    members,
    count(counts.models, "model"),
    count(counts.search, "Search source"),
    mcpServerCount === null ? null : count(mcpServerCount, "MCP server")
  ].filter((part): part is string => part !== null).join(" · ");
}

export function groupMatchesQuery(group: AdminGroup, catalog: AdminCatalog, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return true;
  return [group.name, groupAccessSummary(group, catalog)].join(" ").toLocaleLowerCase().includes(normalized);
}

/** Groups for the list: the query and status filter applied; Full access first, then by name. */
export function deriveAdminGroupRows(input: Readonly<{
  catalog: AdminCatalog;
  filter: AdminGroupStatusFilter;
  groups: readonly AdminGroup[];
  query: string;
}>): AdminGroup[] {
  return input.groups
    .filter((group) => groupMatchesFilter(group, input.filter) && groupMatchesQuery(group, input.catalog, input.query))
    .sort((left, right) =>
      Number(isFullAccessGroup(right)) - Number(isFullAccessGroup(left)) ||
      left.name.localeCompare(right.name)
    );
}

export function groupDeletionInfo(group: AdminGroup): AdminDeletionInfo {
  if (group.deletion) return group.deletion;
  if (isFullAccessGroup(group)) {
    return {
      canDelete: false,
      reason: "system_group_forbidden",
      summary: "Full access is built in and cannot be renamed, archived, or deleted."
    };
  }
  const grants = enabledGrants(group).length;
  return {
    canDelete: group.userCount === 0 && grants === 0,
    reason: group.userCount > 0 ? "group_has_members" : grants > 0 ? "group_has_grants" : null,
    summary:
      group.userCount > 0
        ? "Remove members before deleting this group."
        : grants > 0
          ? "Remove active grants before deleting this group."
          : "No members or active grants; this group can be deleted."
  };
}

export function groupMembers(users: readonly AdminUserRecord[], groupId: string): AdminUserRecord[] {
  return users
    .filter((user) => user.groups.some((membership) => membership.groupId === groupId))
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

/** Active users who are not members yet, for the Add a person picker. */
export function groupMemberCandidates(users: readonly AdminUserRecord[], groupId: string): AdminUserRecord[] {
  return users.filter(
    (user) => user.status === "active" && !user.groups.some((membership) => membership.groupId === groupId)
  );
}

export type AdminGroupProviderKey = Readonly<{
  label: string;
  /** True when the group has its own key on this provider (set on the provider page). */
  override: boolean;
}>;

/**
 * The read-only `Key: …` line of a provider row: the group's override when
 * one is assigned, otherwise the provider's default key. Null when the
 * provider has no usable key at all.
 */
export function groupProviderKey(
  connection: Pick<AdminProviderConnection, "assignments" | "credentials" | "defaultCredentialId"> | null,
  groupId: string
): AdminGroupProviderKey | null {
  if (!connection) return null;
  const labelOf = (credentialId: string | null) =>
    credentialId ? connection.credentials.find((credential) => credential.id === credentialId)?.label ?? null : null;
  const override = connection.assignments.find((assignment) => assignment.group.id === groupId);
  const overrideLabel = override ? labelOf(override.credentialId) : null;
  if (overrideLabel) return { label: `Key: ${overrideLabel}`, override: true };
  const defaultLabel = labelOf(connection.defaultCredentialId);
  return defaultLabel ? { label: `Key: ${defaultLabel} (default)`, override: false } : null;
}

/** Changes that bring every current model of a provider to `enabled` without touching the provider-wide grant. */
export function providerModelChanges(
  catalog: Pick<AdminCatalog, "models">,
  providerId: string,
  enabled: boolean
): AdminGroupGrantChange[] {
  return catalogModelsForProvider(catalog, providerId).map((model) => ({
    enabled,
    modelId: model.modelId,
    provider: providerId
  }));
}
