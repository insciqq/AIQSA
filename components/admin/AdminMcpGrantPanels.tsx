"use client";

import {
  AdminAvailabilityStatus,
  focusRing,
  touchTarget
} from "@/components/admin/adminPrimitives";
import type { AdminMcpController } from "@/components/admin/useAdminMcpController";
import type { AdminGroup, AdminUserRecord } from "@/lib/contracts/admin";
import type { AdminMcpGrant, AdminMcpServer } from "@/lib/contracts/mcp";
import { Check } from "lucide-react";

function grantForGroup(server: AdminMcpServer, groupId: string): AdminMcpGrant | undefined {
  return server.grants.find((grant) => grant.groupId === groupId);
}

function grantForUser(server: AdminMcpServer, userId: string): AdminMcpGrant | undefined {
  return server.grants.find((grant) => grant.userId === userId);
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

function CatalogState({ controller }: { controller: AdminMcpController }) {
  if (controller.state.loading && !controller.state.loaded) {
    return <p className="text-xs text-ink-muted" role="status">Loading MCP servers…</p>;
  }
  if (!controller.state.loaded) {
    return <p className="text-xs leading-5 text-caution">MCP grants are unavailable. Open MCP servers or retry its catalog.</p>;
  }
  return null;
}

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
                  <span className="text-[11px] text-ink-muted">Installation-wide</span>
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

export function AdminMcpUserAccessPanel({
  controller,
  user
}: Readonly<{
  controller: AdminMcpController;
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
        const grantedSlots = new Set(grant?.personalSlotKeys ?? []);
        const personalSlots = server.activePersonalSlots;
        const activeSlotKeys = new Set(personalSlots.map((slot) => slot.slotKey));
        const staleSlotKeys = [...grantedSlots].filter((slotKey) => !activeSlotKeys.has(slotKey));
        return (
          <div className="grid min-w-0 gap-3 py-3" key={server.id}>
            <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="break-words text-sm font-medium text-ink [overflow-wrap:anywhere]">{server.name}</div>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <span className="text-[11px] text-ink-muted">Installation-wide</span>
                  <AdminAvailabilityStatus enabled={server.enabled} />
                </div>
              </div>
              <GrantToggle
                checked={grant?.canUse === true}
                disabled={disabled}
                label={`${grant?.canUse ? "Revoke" : "Grant"} ${server.name} directly for ${user.displayName}`}
                onClick={() => void controller.actions.grant(server.id, {
                  canUse: grant?.canUse !== true,
                  personalSlotKeys: [...grantedSlots],
                  userId: user.id
                })}
              />
            </div>
            {personalSlots.length ? (
              <fieldset className="min-w-0 border-t border-trace-subtle pt-2">
                <legend className="px-1 text-[11px] text-ink-muted">Permitted personal fields</legend>
                <div className="mt-1 flex min-w-0 flex-wrap gap-2">
                  {personalSlots.map((slot) => (
                    <label className={`flex min-h-control-sm min-w-0 items-center gap-2 rounded-control bg-control-surface px-2.5 text-[11px] text-ink-secondary ${touchTarget}`} key={slot.slotKey}>
                      <input
                        checked={grantedSlots.has(slot.slotKey)}
                        className="size-4 shrink-0 accent-proof"
                        disabled={disabled}
                        onChange={(event) => {
                          const next = new Set(grantedSlots);
                          if (event.currentTarget.checked) next.add(slot.slotKey);
                          else next.delete(slot.slotKey);
                          void controller.actions.grant(server.id, {
                            canUse: grant?.canUse === true,
                            personalSlotKeys: [...next],
                            userId: user.id
                          });
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
                <legend className="px-1 text-[11px] text-caution">Removed field permissions</legend>
                <p className="mt-1 text-[11px] leading-5 text-ink-muted">
                  These keys no longer exist in the active revision. Clear them to finish grant cleanup.
                </p>
                <div className="mt-1 flex min-w-0 flex-wrap gap-2">
                  {staleSlotKeys.map((slotKey) => (
                    <label className={`flex min-h-control-sm min-w-0 items-center gap-2 rounded-control bg-control-surface px-2.5 font-mono text-[11px] text-caution ${touchTarget}`} key={slotKey}>
                      <input
                        checked
                        className="size-4 shrink-0 accent-proof"
                        disabled={disabled}
                        onChange={() => {
                          const next = [...grantedSlots].filter((candidate) => candidate !== slotKey);
                          void controller.actions.grant(server.id, {
                            canUse: grant?.canUse === true,
                            personalSlotKeys: next,
                            userId: user.id
                          });
                        }}
                        type="checkbox"
                      />
                      <span className="break-all">{slotKey}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ) : null}
          </div>
        );
      })}
      </div>
      {user.status !== "active" ? <p className="mt-3 text-[11px] text-caution">MCP grants can be edited after this user becomes active.</p> : null}
    </section>
  );
}
