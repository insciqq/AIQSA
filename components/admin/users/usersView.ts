import type {
  AdminDeletionInfo,
  AdminEntitlementSummary,
  AdminGroup,
  AdminInviteEmailDelivery,
  AdminInviteRecord,
  AdminUserRecord
} from "@/lib/contracts/admin";

/**
 * Presentation rules for the Users page (PRD 5.8): table rows, filter pills,
 * access summaries, open invites and the read-only direct-grant listing.
 * Everything derives from the dashboard; the browser adds no state of its own.
 */

export type AdminUserListFilter =
  | "all"
  | "denied"
  | "disabled"
  | "invited"
  | "no-model-access"
  | "pending";

export const adminUserListFilters: readonly AdminUserListFilter[] = [
  "all",
  "pending",
  "invited",
  "disabled",
  "denied",
  "no-model-access"
];

export const ADMIN_USER_FILTER_LABEL: Readonly<Record<AdminUserListFilter, string>> = {
  all: "All",
  denied: "Denied",
  disabled: "Disabled",
  invited: "Invited",
  "no-model-access": "No model access",
  pending: "Pending"
};

/** Rows shown before `Show N more` takes over. */
export const ADMIN_USERS_PAGE_SIZE = 50;
/** Open invites shown before `Show N more`. */
export const ADMIN_OPEN_INVITES_PREVIEW = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

export function parseAdminUserListFilter(value: string | null): AdminUserListFilter {
  return value !== null && (adminUserListFilters as readonly string[]).includes(value)
    ? (value as AdminUserListFilter)
    : "all";
}

export function activeGroupIdsForUser(
  user: Pick<AdminUserRecord, "groups">,
  groups: readonly Pick<AdminGroup, "archivedAt" | "id">[]
): string[] {
  const activeIds = new Set(groups.filter((group) => !group.archivedAt).map((group) => group.id));
  return user.groups.filter((group) => activeIds.has(group.groupId)).map((group) => group.groupId);
}

export function isFullAccessMember(
  user: Pick<AdminUserRecord, "groups">,
  groups: readonly Pick<AdminGroup, "archivedAt" | "id" | "systemRole">[]
): boolean {
  const fullAccessIds = new Set(
    groups.filter((group) => !group.archivedAt && group.systemRole === "full_access").map((group) => group.id)
  );
  return user.groups.some((membership) => fullAccessIds.has(membership.groupId));
}

export function hasModelAccess(entitlements: AdminEntitlementSummary): boolean {
  return entitlements.models.length > 0 || entitlements.providers.length > 0;
}

export type AdminUserAccessSummary = Readonly<{
  label: string;
  tone: "caution" | "muted" | "normal";
}>;

function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/** `22 models · 5 search`, `everything`, `No model access` or `—` (PRD 5.8). */
export function userAccessSummary(
  user: AdminUserRecord,
  groups: readonly Pick<AdminGroup, "archivedAt" | "id" | "systemRole">[]
): AdminUserAccessSummary {
  if (user.status === "pending") return { label: "via group after approval", tone: "normal" };
  if (user.status !== "active") return { label: "—", tone: "muted" };
  if (isFullAccessMember(user, groups)) return { label: "everything", tone: "normal" };
  const { models, providers, searchStrategies } = user.effectiveEntitlements;
  if (!hasModelAccess(user.effectiveEntitlements)) return { label: "No model access", tone: "caution" };
  const parts = [
    providers.length ? count(providers.length, "provider") : null,
    models.length ? count(models.length, "model") : null,
    searchStrategies.length ? `${searchStrategies.length} search` : null
  ].filter((part): part is string => part !== null);
  return { label: parts.join(" · "), tone: "normal" };
}

/** Two-letter initials for the avatar tile; falls back to the email's first letter. */
export function userInitials(user: Pick<AdminUserRecord, "displayName" | "email">): string {
  const words = user.displayName.trim().split(/\s+/u).filter(Boolean);
  const letters = words.length >= 2
    ? `${words[0]!.slice(0, 1)}${words[words.length - 1]!.slice(0, 1)}`
    : words[0]?.slice(0, 2) ?? user.email?.slice(0, 1) ?? "·";
  return letters.toLocaleUpperCase();
}

const shortDate = new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short" });
const shortDateWithYear = new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short", year: "numeric" });
const shortTime = new Intl.DateTimeFormat("en-US", { hour: "2-digit", hour12: false, minute: "2-digit" });

/** `Sep 3` this year, `Sep 3, 2025` otherwise; empty for an unreadable date. */
export function formatShortDay(iso: string, now: Date): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.getFullYear() === now.getFullYear() ? shortDate.format(date) : shortDateWithYear.format(date);
}

/** `never`, `just now` or `Sep 3, 19:04` for the Last seen column. */
export function formatLastSeen(iso: string | null, now: Date): string {
  if (!iso) return "never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "never";
  if (now.getTime() - date.getTime() < 60_000) return "just now";
  return `${formatShortDay(iso, now)}, ${shortTime.format(date)}`;
}

export function userMatchesQuery(user: AdminUserRecord, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return true;
  const haystack = [user.displayName, user.email ?? "", ...user.groups.map((group) => group.name)]
    .join(" ")
    .toLocaleLowerCase();
  return haystack.includes(normalized);
}

export function userMatchesFilter(
  user: AdminUserRecord,
  filter: AdminUserListFilter,
  groups: readonly Pick<AdminGroup, "archivedAt" | "id" | "systemRole">[]
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "invited":
      return false;
    case "no-model-access":
      return user.status === "active" && !isFullAccessMember(user, groups) && !hasModelAccess(user.effectiveEntitlements);
    default:
      return user.status === filter;
  }
}

const statusRank: Record<AdminUserRecord["status"], number> = {
  active: 1,
  denied: 3,
  disabled: 2,
  pending: 0
};

/** Users for the table: the query and filter applied, pending first, then by name. */
export function deriveAdminUserRows(input: Readonly<{
  filter: AdminUserListFilter;
  groups: readonly Pick<AdminGroup, "archivedAt" | "id" | "systemRole">[];
  query: string;
  users: readonly AdminUserRecord[];
}>): AdminUserRecord[] {
  return input.users
    .filter((user) => userMatchesFilter(user, input.filter, input.groups) && userMatchesQuery(user, input.query))
    .sort((left, right) =>
      statusRank[left.status] - statusRank[right.status] ||
      left.displayName.localeCompare(right.displayName) ||
      (left.email ?? "").localeCompare(right.email ?? "")
    );
}

export function adminUserFilterCounts(input: Readonly<{
  groups: readonly Pick<AdminGroup, "archivedAt" | "id" | "systemRole">[];
  openInviteCount: number;
  users: readonly AdminUserRecord[];
}>): Record<AdminUserListFilter, number> {
  const counts: Record<AdminUserListFilter, number> = {
    all: input.users.length,
    denied: 0,
    disabled: 0,
    invited: input.openInviteCount,
    "no-model-access": 0,
    pending: 0
  };
  for (const user of input.users) {
    if (user.status === "pending") counts.pending += 1;
    if (user.status === "disabled") counts.disabled += 1;
    if (user.status === "denied") counts.denied += 1;
    if (userMatchesFilter(user, "no-model-access", input.groups)) counts["no-model-access"] += 1;
  }
  return counts;
}

/** Pills shown in the toolbar: the five fixed ones plus No model access only while it applies. */
export function visibleAdminUserFilters(
  counts: Record<AdminUserListFilter, number>,
  selected: AdminUserListFilter
): AdminUserListFilter[] {
  return adminUserListFilters.filter((filter) =>
    filter !== "no-model-access" || counts["no-model-access"] > 0 || selected === "no-model-access"
  );
}

export function userStatusClass(status: AdminUserRecord["status"]): string {
  const classes: Record<AdminUserRecord["status"], string> = {
    active: "border-positive/35 bg-positive/[0.12] text-positive",
    denied: "border-critical/35 bg-critical/10 text-critical",
    disabled: "border-trace-strong bg-control-surface text-ink",
    pending: "border-caution/35 bg-caution/10 text-caution"
  };
  return classes[status];
}

export function userStatusRowClass(status: AdminUserRecord["status"]): string {
  const classes: Record<AdminUserRecord["status"], string> = {
    active: "border-l-2 border-l-positive/55 bg-positive/5",
    denied: "border-l-2 border-l-critical/55 bg-critical/5",
    disabled: "border-l-2 border-l-trace-strong bg-control-surface",
    pending: "border-l-2 border-l-caution/55 bg-caution/5"
  };
  return classes[status];
}

export function userDeletionInfo(user: AdminUserRecord, adminUserId: string): AdminDeletionInfo {
  if (user.id === adminUserId) {
    return {
      canDelete: false,
      reason: "active_user",
      summary: "Your current admin account cannot delete itself."
    };
  }
  return (
    user.deletion ?? {
      canDelete: user.status !== "active",
      reason: user.status === "active" ? "active_user" : null,
      summary:
        user.status === "active"
          ? "Disable this user before deletion can be considered."
          : "No app-owned records detected; auth request data can be removed."
    }
  );
}

/**
 * Grants that no current group explains: effective access minus the union of
 * the user's active groups' enabled grants. Full access members hold
 * everything through the group, so nothing is direct.
 */
export function directUserGrants(
  user: AdminUserRecord,
  groups: readonly AdminGroup[]
): AdminEntitlementSummary {
  if (isFullAccessMember(user, groups)) return { models: [], providers: [], searchStrategies: [] };
  const memberOf = new Set(activeGroupIdsForUser(user, groups));
  const groupModels = new Set<string>();
  const groupProviders = new Set<string>();
  const groupSearch = new Set<string>();
  for (const group of groups) {
    if (!memberOf.has(group.id)) continue;
    for (const grant of group.accessGrants) {
      if (!grant.enabled) continue;
      if (grant.provider && grant.modelId) groupModels.add(`${grant.provider}:${grant.modelId}`);
      else if (grant.provider) groupProviders.add(grant.provider);
      if (grant.searchStrategy) groupSearch.add(grant.searchStrategy);
    }
  }
  const { models, providers, searchStrategies } = user.effectiveEntitlements;
  return {
    models: models.filter((model) => !groupModels.has(`${model.provider}:${model.modelId}`)),
    providers: providers.filter((provider) => !groupProviders.has(provider)),
    searchStrategies: searchStrategies.filter((strategy) => !groupSearch.has(strategy))
  };
}

// Invites

export type AdminInviteState = "accepted" | "expired" | "open" | "revoked";

export function inviteState(invite: AdminInviteRecord, nowMs: number): AdminInviteState {
  if (invite.acceptedAt) return "accepted";
  if (invite.revokedAt) return "revoked";
  return new Date(invite.expiresAt).getTime() > nowMs ? "open" : "expired";
}

export function isInviteOpen(invite: AdminInviteRecord, nowMs: number): boolean {
  return inviteState(invite, nowMs) === "open";
}

/** Open invites, soonest expiry first. */
export function openInvites(invites: readonly AdminInviteRecord[], nowMs: number): AdminInviteRecord[] {
  return invites
    .filter((invite) => isInviteOpen(invite, nowMs))
    .sort((left, right) => new Date(left.expiresAt).getTime() - new Date(right.expiresAt).getTime());
}

/** Expired or revoked invites that were never accepted, newest first. */
export function staleInvites(invites: readonly AdminInviteRecord[], nowMs: number): AdminInviteRecord[] {
  return invites
    .filter((invite) => {
      const state = inviteState(invite, nowMs);
      return state === "expired" || state === "revoked";
    })
    .sort((left, right) => new Date(right.expiresAt).getTime() - new Date(left.expiresAt).getTime());
}

/** `expires in 6 days`, `expires in 1 day`, `expires today`. */
export function inviteExpiryLabel(invite: AdminInviteRecord, nowMs: number): string {
  const remainingMs = new Date(invite.expiresAt).getTime() - nowMs;
  const days = Math.floor(remainingMs / DAY_MS);
  if (days <= 0) return "expires today";
  return `expires in ${count(days, "day")}`;
}

/** `revoked Sep 3` / `expired Sep 3` for the stale list. */
export function inviteStaleLabel(invite: AdminInviteRecord, nowMs: number): string {
  const now = new Date(nowMs);
  if (invite.revokedAt) return `revoked ${formatShortDay(invite.revokedAt, now)}`;
  return `expired ${formatShortDay(invite.expiresAt, now)}`;
}

/** Delivery note for the invite created in this session; older invites carry no delivery record. */
export function inviteDeliveryLabel(delivery: AdminInviteEmailDelivery): string {
  switch (delivery) {
    case "sent":
      return "email sent";
    case "failed":
      return "email failed — share the link manually";
    case "unavailable":
      return "email not configured — share the link manually";
    case "not_requested":
      return "no email sent — share the link manually";
  }
}

export function inviteDeletionInfo(invite: AdminInviteRecord, nowMs: number): AdminDeletionInfo {
  if (invite.deletion) return invite.deletion;
  const state = inviteState(invite, nowMs);
  return {
    canDelete: state === "expired" || state === "revoked",
    reason: state === "accepted" ? "invite_accepted" : state === "open" ? "invite_open" : null,
    summary: state === "accepted"
      ? "Accepted invites are kept for audit history."
      : state === "open"
        ? "Revoke this open invite before deleting it."
        : "This stale invite can be deleted."
  };
}
