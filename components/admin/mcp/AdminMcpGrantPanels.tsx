"use client";

import {
  AdminAvailabilityStatus,
  focusRing,
  inputClass,
  touchTarget
} from "@/components/admin/adminPrimitives";
import { cardClass } from "@/components/admin/mcp/mcpPrimitives";
import type { AdminMcpController } from "@/components/admin/useAdminMcpController";
import { UiV2Button, UiV2Switch } from "@/components/ui-v2";
import type { AdminGroup, AdminUserRecord } from "@/lib/contracts/admin";
import type { AdminMcpGrant, AdminMcpServer } from "@/lib/contracts/mcp";
import { Check, Search } from "lucide-react";
import { useId, useMemo, useState } from "react";

const MCP_ACCESS_PAGE_SIZE = 8;

function grantForGroup(server: AdminMcpServer, groupId: string): AdminMcpGrant | undefined {
  return server.grants.find((grant) => grant.groupId === groupId);
}

function grantForUser(server: AdminMcpServer, userId: string): AdminMcpGrant | undefined {
  return server.grants.find((grant) => grant.userId === userId);
}

function inheritedMcpAccessGroups(
  server: AdminMcpServer,
  user: AdminUserRecord,
  groups: readonly AdminGroup[]
): AdminGroup[] {
  const memberships = new Set(user.groups.map((membership) => membership.groupId));
  return groups.filter((group) =>
    memberships.has(group.id) &&
    !group.archivedAt &&
    (group.systemRole === "full_access" || grantForGroup(server, group.id)?.canUse === true)
  );
}

function inheritedAccessLabel(inheritedGroups: readonly AdminGroup[]): string | null {
  const fullAccess = inheritedGroups.find((group) => group.systemRole === "full_access");
  if (fullAccess) return "Included via Full access";
  if (!inheritedGroups.length) return null;
  return `Included via ${inheritedGroups[0]!.name}${inheritedGroups.length > 1 ? ` +${inheritedGroups.length - 1}` : ""}`;
}

function EffectiveAccessFact({ accountActive, direct, inheritedGroups }: Readonly<{
  accountActive: boolean;
  direct: boolean;
  inheritedGroups: readonly AdminGroup[];
}>) {
  const inherited = inheritedAccessLabel(inheritedGroups);
  const label = !accountActive
    ? "Unavailable while account is inactive"
    : inherited ?? (direct ? "Granted directly" : "No access");
  const effective = accountActive && Boolean(inherited || direct);

  return (
    <span
      className={[
        "inline-flex min-h-control-sm items-center gap-1.5 rounded-control border px-3 text-xs font-medium",
        effective
          ? "border-proof/25 bg-proof/[0.08] text-proof"
          : "border-trace-strong bg-control-surface text-ink"
      ].join(" ")}
      data-effective-mcp-access={effective ? "granted" : "not-granted"}
    >
      {effective ? <Check aria-hidden="true" className="size-3.5" /> : null}
      {label}
    </span>
  );
}

function GrantToggle({
  checked,
  disabled,
  label,
  onClick
}: Readonly<{
  checked: boolean;
  disabled: boolean;
  label: string;
  onClick(): void;
}>) {
  return (
    <button
      aria-label={label}
      aria-pressed={checked}
      className={[
        `inline-flex min-h-control-sm min-w-20 items-center justify-center gap-1.5 rounded-control px-3 text-xs font-medium ${focusRing} ${touchTarget} disabled:cursor-not-allowed disabled:opacity-50`,
        checked ? "bg-proof text-proof-contrast hover:bg-proof-hover" : "bg-control-surface text-ink-secondary hover:bg-control-hover"
      ].join(" ")}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {checked ? <Check aria-hidden="true" className="size-3.5" /> : null}
      {checked ? "Granted" : "Not granted"}
    </button>
  );
}

function DirectGrantAction({
  direct,
  disabled,
  label,
  onClick
}: Readonly<{
  direct: boolean;
  disabled: boolean;
  label: string;
  onClick(): void;
}>) {
  return (
    <button
      aria-label={label}
      className={[
        `inline-flex min-h-control-sm items-center justify-center rounded-control border px-3 text-xs font-medium ${focusRing} ${touchTarget} disabled:cursor-not-allowed disabled:opacity-50`,
        direct
          ? "border-transparent bg-control-surface text-ink-secondary hover:bg-control-hover hover:text-ink"
          : "border-proof/25 bg-proof/[0.08] text-proof hover:border-proof/40 hover:bg-proof/[0.14]"
      ].join(" ")}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {direct ? "Revoke direct grant" : "Grant directly"}
    </button>
  );
}

/**
 * The exact personal fields a user may fill for one server, plus keys that a
 * later configuration dropped and that still sit on the grant.
 */
function PersonalFieldGrants({
  controller,
  disabled,
  grant,
  server,
  user
}: Readonly<{
  controller: AdminMcpController;
  disabled: boolean;
  grant: AdminMcpGrant | undefined;
  server: AdminMcpServer;
  user: AdminUserRecord;
}>) {
  const grantedSlots = new Set(grant?.personalSlotKeys ?? []);
  const personalSlots = server.activePersonalSlots;
  const activeSlotKeys = new Set(personalSlots.map((slot) => slot.slotKey));
  const staleSlotKeys = [...grantedSlots].filter((slotKey) => !activeSlotKeys.has(slotKey));
  const save = (next: readonly string[]) => void controller.actions.grant(server.id, {
    canUse: grant?.canUse === true,
    personalSlotKeys: [...next],
    userId: user.id
  });
  if (!personalSlots.length && !staleSlotKeys.length) return null;
  return (
    <>
      {personalSlots.length ? (
        <fieldset className="min-w-0 border-t border-trace-subtle pt-2">
          <legend className="px-1 text-metadata text-ink-muted">Permitted personal fields</legend>
          <div className="mt-1 flex min-w-0 flex-wrap gap-2">
            {personalSlots.map((slot) => (
              <label className={`flex min-h-control-sm min-w-0 items-center gap-2 rounded-control bg-control-surface px-2.5 text-metadata text-ink-secondary ${touchTarget}`} key={slot.slotKey}>
                <input
                  checked={grantedSlots.has(slot.slotKey)}
                  className="size-4 shrink-0 accent-proof"
                  disabled={disabled}
                  onChange={(event) => {
                    const next = new Set(grantedSlots);
                    if (event.currentTarget.checked) next.add(slot.slotKey);
                    else next.delete(slot.slotKey);
                    save([...next]);
                  }}
                  type="checkbox"
                />
                <span className="break-words [overflow-wrap:anywhere]">{slot.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      {staleSlotKeys.length ? (
        <fieldset className="min-w-0 border-t border-trace-subtle pt-2">
          <legend className="px-1 text-metadata text-caution">Removed field permissions</legend>
          <p className="mt-1 text-metadata leading-5 text-ink-muted">
            These fields no longer exist in the current configuration. Clear them to finish grant cleanup.
          </p>
          <div className="mt-1 flex min-w-0 flex-wrap gap-2">
            {staleSlotKeys.map((slotKey) => (
              <label className={`flex min-h-control-sm min-w-0 items-center gap-2 rounded-control bg-control-surface px-2.5 font-mono text-metadata text-caution ${touchTarget}`} key={slotKey}>
                <input
                  checked
                  className="size-4 shrink-0 accent-proof"
                  disabled={disabled}
                  onChange={() => save([...grantedSlots].filter((candidate) => candidate !== slotKey))}
                  type="checkbox"
                />
                <span className="break-all">{slotKey}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
    </>
  );
}

function CatalogState({ controller }: { controller: AdminMcpController }) {
  if (controller.state.loading && !controller.state.loaded) {
    return <p className="text-xs text-ink-muted" role="status">Loading MCP servers…</p>;
  }
  if (!controller.state.loaded) {
    return <p className="text-xs leading-5 text-caution">MCP grants are unavailable. Open MCP servers or retry its catalog.</p>;
  }
  return null;
}

/** One group's MCP grants across every server (Groups page). */
export function AdminMcpGroupAccessPanel({
  controller,
  group
}: Readonly<{
  controller: AdminMcpController;
  group: AdminGroup;
}>) {
  const servers = controller.state.servers.filter((server) => !server.archivedAt);
  const systemFullAccess = group.systemRole === "full_access";
  const disabled = controller.state.busy || Boolean(group.archivedAt);
  return (
    <section className="border-b border-trace-subtle py-5" data-testid="admin-group-mcp-access">
      <div>
        <div className="text-sm font-semibold text-ink">MCP server grants</div>
        <p className="mt-1 text-xs leading-5 text-ink-muted">
          {systemFullAccess
            ? "Full access automatically includes every current and future MCP server. Personal fields remain direct-user permissions."
            : "A grant unlocks every valid current and future tool from that installation-owned server. Personal fields are never granted through a group."}
        </p>
      </div>
      <div className="mt-4 divide-y divide-trace-subtle border-y border-trace-subtle">
        <CatalogState controller={controller} />
        {controller.state.loaded && !servers.length ? (
          <p className="py-4 text-xs text-ink-muted">No non-archived MCP servers.</p>
        ) : null}
        {servers.map((server) => {
          const grant = grantForGroup(server, group.id);
          return (
            <div className="flex min-w-0 flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between" key={server.id}>
              <div className="min-w-0">
                <div className="break-words text-sm font-medium text-ink [overflow-wrap:anywhere]">{server.name}</div>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <span className="text-metadata text-ink-muted">Installation-wide</span>
                  <AdminAvailabilityStatus enabled={server.enabled} />
                </div>
              </div>
              {systemFullAccess ? (
                <span
                  className="inline-flex min-h-control-sm items-center gap-1.5 rounded-control bg-proof/[0.08] px-3 text-xs font-medium text-proof"
                  data-testid={`system-mcp-grant-${server.id}`}
                >
                  <Check aria-hidden="true" className="size-3.5" />
                  Included automatically
                </span>
              ) : (
                <GrantToggle
                  checked={grant?.canUse === true}
                  disabled={disabled}
                  label={`${grant?.canUse ? "Revoke" : "Grant"} ${server.name} for group ${group.name}`}
                  onClick={() => void controller.actions.grant(server.id, {
                    canUse: grant?.canUse !== true,
                    groupId: group.id
                  })}
                />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** One user's direct MCP access and personal-field permissions across every server (Users page). */
export function AdminMcpUserAccessPanel({
  controller,
  groups,
  user
}: Readonly<{
  controller: AdminMcpController;
  groups: readonly AdminGroup[];
  user: AdminUserRecord;
}>) {
  const servers = controller.state.servers.filter((server) => !server.archivedAt);
  const disabled = controller.state.busy || user.status !== "active";
  return (
    <section className="border-b border-trace-subtle py-5" data-testid="admin-user-mcp-access">
      <div>
        <div className="text-sm font-semibold text-ink">MCP server access</div>
        <p className="mt-1 text-xs leading-5 text-ink-muted">
          Direct server use combines with group grants. Personal-field permission is direct-only and does not reveal a stored value.
        </p>
      </div>
      <CatalogState controller={controller} />
      {controller.state.loaded && !servers.length ? <p className="mt-3 text-xs text-ink-muted">No non-archived MCP servers.</p> : null}
      <div className="mt-4 divide-y divide-trace-subtle border-y border-trace-subtle">
      {servers.map((server) => {
        const grant = grantForUser(server, user.id);
        const direct = grant?.canUse === true;
        const inheritedGroups = inheritedMcpAccessGroups(server, user, groups);
        return (
          <div className="grid min-w-0 gap-3 py-3" key={server.id}>
            <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="break-words text-sm font-medium text-ink [overflow-wrap:anywhere]">{server.name}</div>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <span className="text-metadata text-ink-muted">Installation-wide</span>
                  <AdminAvailabilityStatus enabled={server.enabled} />
                </div>
              </div>
              <div className="flex flex-wrap items-end gap-2 sm:justify-end">
                <div className="grid gap-1">
                  <span className="text-metadata font-medium uppercase tracking-[0.08em] text-ink-muted">Effective access</span>
                  <EffectiveAccessFact
                    accountActive={user.status === "active"}
                    direct={direct}
                    inheritedGroups={inheritedGroups}
                  />
                </div>
                <div className="grid gap-1">
                  <span className="text-metadata font-medium uppercase tracking-[0.08em] text-ink-muted">Direct assignment</span>
                  <DirectGrantAction
                    direct={direct}
                    disabled={disabled}
                    label={`${direct ? "Revoke" : "Grant"} ${server.name} directly for ${user.displayName}`}
                    onClick={() => void controller.actions.grant(server.id, {
                      canUse: !direct,
                      personalSlotKeys: [...(grant?.personalSlotKeys ?? [])],
                      userId: user.id
                    })}
                  />
                </div>
              </div>
            </div>
            <PersonalFieldGrants controller={controller} disabled={disabled} grant={grant} server={server} user={user} />
          </div>
        );
      })}
      </div>
      {user.status !== "active" ? <p className="mt-3 text-metadata text-caution">MCP grants can be edited after this user becomes active.</p> : null}
    </section>
  );
}

/** Every group with a switch for one server (server page). Full access groups are always included. */
export function AdminMcpServerGroupAccessPanel({
  controller,
  groups,
  server
}: Readonly<{
  controller: AdminMcpController;
  groups: readonly AdminGroup[];
  server: AdminMcpServer;
}>) {
  const visible = groups.filter((group) => !group.archivedAt);
  const disabled = controller.state.busy || Boolean(server.archivedAt);
  return (
    <div className={cardClass} data-testid="mcp-server-group-access">
      {visible.length ? (
        <ul aria-label={`Groups with access to ${server.name}`} className="divide-y divide-trace-subtle">
          {visible.map((group) => {
            const grant = grantForGroup(server, group.id);
            const fullAccess = group.systemRole === "full_access";
            return (
              <li className="flex min-h-12 items-center justify-between gap-3 px-4 py-2.5 sm:px-5" key={group.id}>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">{group.name}</p>
                  <p className="text-xs text-ink-muted">
                    {fullAccess
                      ? "Full access · every server is included"
                      : `${group.userCount} member${group.userCount === 1 ? "" : "s"}`}
                  </p>
                </div>
                {fullAccess ? (
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium text-proof" data-testid={`system-mcp-grant-${group.id}`}>
                    <Check aria-hidden="true" className="size-3.5" />
                    Included
                  </span>
                ) : (
                  <UiV2Switch
                    checked={grant?.canUse === true}
                    disabled={disabled}
                    label={`${server.name} for ${group.name}`}
                    onChange={(next) => void controller.actions.grant(server.id, { canUse: next, groupId: group.id })}
                  />
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="px-5 py-6 text-sm text-ink-muted" role="status">No groups yet. Groups are managed in Groups.</p>
      )}
    </div>
  );
}

/**
 * Active users with a switch for direct access to one server, granted users
 * first, searchable when the list is long (server page).
 */
export function AdminMcpServerUserAccessPanel({
  controller,
  groups,
  server,
  users
}: Readonly<{
  controller: AdminMcpController;
  groups: readonly AdminGroup[];
  server: AdminMcpServer;
  users: readonly AdminUserRecord[];
}>) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const searchId = useId();
  const disabled = controller.state.busy || Boolean(server.archivedAt);
  const rows = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return users
      .filter((user) => user.status === "active")
      .filter((user) => !normalized ||
        user.displayName.toLowerCase().includes(normalized) ||
        (user.email ?? "").toLowerCase().includes(normalized))
      .sort((left, right) => {
        const leftDirect = grantForUser(server, left.id)?.canUse === true ? 0 : 1;
        const rightDirect = grantForUser(server, right.id)?.canUse === true ? 0 : 1;
        return leftDirect - rightDirect || left.displayName.localeCompare(right.displayName);
      });
  }, [query, server, users]);
  const shown = expanded ? rows : rows.slice(0, MCP_ACCESS_PAGE_SIZE);
  const hidden = rows.length - shown.length;
  const activeUsers = users.filter((user) => user.status === "active").length;

  return (
    <div className="flex flex-col gap-2.5" data-testid="mcp-server-user-access">
      {activeUsers > MCP_ACCESS_PAGE_SIZE ? (
        <div className="relative w-full sm:w-80">
          <label className="sr-only" htmlFor={searchId}>Search users</label>
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-ink-muted" />
          <input
            className={`${inputClass} h-8 min-h-0 py-0 pl-9 text-[13px]`}
            id={searchId}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Name or email"
            type="search"
            value={query}
          />
        </div>
      ) : null}
      <div className={cardClass}>
        {shown.length ? (
          <>
            <ul aria-label={`Users with access to ${server.name}`} className="divide-y divide-trace-subtle">
              {shown.map((user) => {
                const grant = grantForUser(server, user.id);
                const direct = grant?.canUse === true;
                const inherited = inheritedAccessLabel(inheritedMcpAccessGroups(server, user, groups));
                return (
                  <li className="flex min-w-0 flex-col gap-2 px-4 py-2.5 sm:px-5" key={user.id}>
                    <div className="flex min-h-7 min-w-0 items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-ink">{user.displayName}</p>
                        <p className="truncate text-xs text-ink-muted">
                          {[user.email, inherited].filter((part): part is string => Boolean(part)).join(" · ")}
                        </p>
                      </div>
                      <UiV2Switch
                        checked={direct}
                        disabled={disabled}
                        label={`${server.name} for ${user.displayName}`}
                        onChange={(next) => void controller.actions.grant(server.id, {
                          canUse: next,
                          personalSlotKeys: [...(grant?.personalSlotKeys ?? [])],
                          userId: user.id
                        })}
                      />
                    </div>
                    <PersonalFieldGrants controller={controller} disabled={disabled} grant={grant} server={server} user={user} />
                  </li>
                );
              })}
            </ul>
            {hidden > 0 ? (
              <div className="flex justify-center border-t border-trace-subtle px-4 py-2.5">
                <UiV2Button onClick={() => setExpanded(true)} tone="ghost" type="button">
                  Show {hidden} more
                </UiV2Button>
              </div>
            ) : null}
          </>
        ) : (
          <p className="px-5 py-6 text-sm text-ink-muted" role="status">
            {activeUsers ? "No users match this search." : "No active users yet. People appear here once their account is active."}
          </p>
        )}
      </div>
    </div>
  );
}
