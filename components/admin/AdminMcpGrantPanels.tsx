"use client";

import {
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
        checked ? "bg-surface-selected text-accent-cyan" : "bg-surface-thread text-content-muted hover:bg-surface-hover"
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
    return <p className="text-xs text-content-muted" role="status">Loading MCP servers…</p>;
  }
  if (!controller.state.loaded) {
    return <p className="text-xs leading-5 text-accent-amber">MCP grants are unavailable. Open MCP servers or retry its catalog.</p>;
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
  const disabled = controller.state.busy || Boolean(group.archivedAt);
  return (
    <section className="rounded-panel bg-surface-raised/50" data-testid="admin-group-mcp-access">
      <div className="border-b border-separator-subtle px-3 py-2">
        <div className="text-xs font-medium text-content-secondary">MCP server grants</div>
        <p className="mt-1 text-xs leading-5 text-content-muted">
          A grant unlocks every valid current and future tool from that installation-owned server. Personal fields are never granted through a group.
        </p>
      </div>
      <div className="grid gap-2 p-3">
        <CatalogState controller={controller} />
        {controller.state.loaded && !servers.length ? (
          <p className="text-xs text-content-muted">No non-archived MCP servers.</p>
        ) : null}
        {servers.map((server) => {
          const grant = grantForGroup(server, group.id);
          return (
            <div className="flex min-w-0 flex-col gap-2 rounded-control bg-surface-thread px-3 py-2 sm:flex-row sm:items-center sm:justify-between" key={server.id}>
              <div className="min-w-0">
                <div className="break-words text-xs font-medium text-content-primary [overflow-wrap:anywhere]">{server.name}</div>
                <p className="mt-1 text-[11px] text-content-muted">
                  {server.enabled ? "Enabled installation-wide" : "Currently disabled installation-wide"}
                </p>
              </div>
              <GrantToggle
                checked={grant?.canUse === true}
                disabled={disabled}
                label={`${grant?.canUse ? "Revoke" : "Grant"} ${server.name} for group ${group.name}`}
                onClick={() => void controller.actions.grant(server.id, {
                  canUse: grant?.canUse !== true,
                  groupId: group.id
                })}
              />
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
    <section className="mt-3 grid gap-2 rounded-control bg-surface-raised px-3 py-2" data-testid="admin-user-mcp-access">
      <div>
        <div className="text-xs font-medium text-content-secondary">MCP server access</div>
        <p className="mt-1 text-[11px] leading-5 text-content-muted">
          Direct server use combines with group grants. Personal-field permission is direct-only and does not reveal a stored value.
        </p>
      </div>
      <CatalogState controller={controller} />
      {controller.state.loaded && !servers.length ? <p className="text-xs text-content-muted">No non-archived MCP servers.</p> : null}
      {servers.map((server) => {
        const grant = grantForUser(server, user.id);
        const grantedSlots = new Set(grant?.personalSlotKeys ?? []);
        const personalSlots = server.activePersonalSlots;
        const activeSlotKeys = new Set(personalSlots.map((slot) => slot.slotKey));
        const staleSlotKeys = [...grantedSlots].filter((slotKey) => !activeSlotKeys.has(slotKey));
        return (
          <div className="grid min-w-0 gap-2 rounded-control bg-surface-thread p-2" key={server.id}>
            <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="break-words text-xs font-medium text-content-primary [overflow-wrap:anywhere]">{server.name}</div>
                <p className="mt-1 text-[11px] text-content-muted">
                  {server.enabled ? "Enabled installation-wide" : "Currently disabled installation-wide"}
                </p>
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
              <fieldset className="min-w-0 border-t border-separator-subtle pt-2">
                <legend className="px-1 text-[11px] text-content-muted">Permitted personal fields</legend>
                <div className="mt-1 flex min-w-0 flex-wrap gap-2">
                  {personalSlots.map((slot) => (
                    <label className={`flex min-h-control-sm min-w-0 items-center gap-2 rounded-control bg-surface-raised px-2.5 text-[11px] text-content-secondary ${touchTarget}`} key={slot.slotKey}>
                      <input
                        checked={grantedSlots.has(slot.slotKey)}
                        className="size-4 shrink-0 accent-accent-cyan"
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
              <fieldset className="min-w-0 border-t border-separator-subtle pt-2">
                <legend className="px-1 text-[11px] text-accent-amber">Removed field permissions</legend>
                <p className="mt-1 text-[11px] leading-5 text-content-muted">
                  These keys no longer exist in the active revision. Clear them to finish grant cleanup.
                </p>
                <div className="mt-1 flex min-w-0 flex-wrap gap-2">
                  {staleSlotKeys.map((slotKey) => (
                    <label className={`flex min-h-control-sm min-w-0 items-center gap-2 rounded-control bg-surface-raised px-2.5 font-mono text-[11px] text-accent-amber ${touchTarget}`} key={slotKey}>
                      <input
                        checked
                        className="size-4 shrink-0 accent-accent-cyan"
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
      {user.status !== "active" ? <p className="text-[11px] text-accent-amber">MCP grants can be edited after this user becomes active.</p> : null}
    </section>
  );
}
