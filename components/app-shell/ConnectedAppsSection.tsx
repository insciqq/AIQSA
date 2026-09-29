"use client";

import { UiV2Button } from "@/components/ui-v2";
import { McpHubConnection } from "@/components/app-shell/McpHubConnection";
import type { MemoryMcpConnectedApp } from "@/lib/contracts/memoryMcpConnectedApps";
import {
  activateConnectedApps,
  deactivateConnectedApps,
  refreshConnectedApps,
  revokeConnectedAppAccess,
  useConnectedAppsStore
} from "@/components/app-shell/connectedAppsStore";
import { CircleCheck, Clock3, LoaderCircle, ShieldCheck, Unplug } from "lucide-react";
import { useEffect, useRef } from "react";

function timestamp(value: string | null): string {
  if (!value) return "Never used";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function permissionCopy(app: MemoryMcpConnectedApp) {
  if (app.capability === "mcp:hub") return {
    label: "MCP Hub", retained: "MCP connections retained",
    revoked: "MCP Hub access revoked. Your MCP connections were kept."
  };
  if (app.capability === "skills:store") return {
    label: app.scopes?.includes("skills:write")
      ? "Skills · read, download, create, update, and delete"
      : "Skills · read and download",
    retained: "Stored Skills and local copies retained",
    revoked: "Skills access revoked. Your stored Skills and downloaded copies were kept."
  };
  return {
    label: "Personal Memory", retained: "Memory retained",
    revoked: "Personal Memory access revoked. Stored Memory facts were kept."
  };
}

export function ConnectedAppsSection({
  accountId,
  onBusyChange
}: Readonly<{
  accountId: string;
  onBusyChange?(busy: boolean): void;
}>) {
  const state = useConnectedAppsStore();
  const headingRefs = useRef(new Map<string, HTMLHeadingElement>());
  const focusedRevocation = useRef<string | null>(null);
  const current = state.accountId === accountId;
  const apps = current ? state.apps : [];
  const busyConnectionId = current ? state.busyConnectionId : null;
  const error = current ? state.error : null;
  const loadState = current ? state.loadState : "loading";
  const lastRevoked = apps.find((app) => app.connectionId === state.lastRevokedConnectionId);

  useEffect(() => {
    activateConnectedApps(accountId);
    void refreshConnectedApps().catch(() => undefined);
    return () => deactivateConnectedApps(accountId);
  }, [accountId]);

  useEffect(() => {
    onBusyChange?.(Boolean(busyConnectionId));
    return () => onBusyChange?.(false);
  }, [busyConnectionId, onBusyChange]);

  useEffect(() => {
    const connectionId = current ? state.lastRevokedConnectionId : null;
    if (!connectionId || focusedRevocation.current === connectionId) return;
    focusedRevocation.current = connectionId;
    headingRefs.current.get(connectionId)?.focus();
  }, [current, state.lastRevokedConnectionId]);

  return (
    <div className="v2-agent-settings">
      <McpHubConnection expanded />
      <section aria-labelledby="connected-apps-list-heading" className="v2-agent-permissions">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-ink" id="connected-apps-list-heading">
              Authorized connections
            </h3>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-ink-secondary">
              Review the access you granted each app. Permissions do not indicate whether an agent is currently connected. Revoke each connection separately.
            </p>
          </div>
          <UiV2Button
            disabled={loadState === "loading" || Boolean(busyConnectionId)}
            icon="regenerate"
            onClick={() => void refreshConnectedApps(true).catch(() => undefined)}
          >
            Refresh
          </UiV2Button>
        </div>

        <div className="mt-4 text-xs leading-5 text-ink-secondary">
          <p className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>Revoking access stops future calls. Your stored Skills, MCP connections, and Memory facts remain. Downloaded Skills stay on the agent&apos;s device.</span>
          </p>
        </div>

        {current && lastRevoked ? (
          <p className="mt-4 flex items-center gap-2 text-sm text-positive" role="status">
            <CircleCheck className="size-4 shrink-0" aria-hidden="true" />
            {permissionCopy(lastRevoked).revoked}
          </p>
        ) : null}

        {loadState === "loading" && apps.length === 0 ? (
          <div className="grid min-h-40 place-items-center" role="status">
            <p className="flex items-center gap-2 text-sm text-ink-secondary">
              <LoaderCircle className="size-4 animate-spin text-proof motion-reduce:animate-none" aria-hidden="true" />
              Loading connected apps…
            </p>
          </div>
        ) : loadState === "error" && apps.length === 0 ? (
          <div className="mt-6 border-y border-critical/35 px-4 py-5 text-center">
            <p className="text-sm font-medium text-critical" role="alert">Connected apps could not be loaded.</p>
            <p className="mt-1 text-xs text-ink-muted">Your connections were not changed.</p>
            <UiV2Button className="mt-3" onClick={() => void refreshConnectedApps(true).catch(() => undefined)}>
              Retry
            </UiV2Button>
          </div>
        ) : apps.length === 0 ? (
          <div className="mt-6 border-y border-trace-subtle px-4 py-6 text-center">
            <p className="text-sm font-medium text-ink">No connected apps</p>
            <p className="mt-1 text-xs leading-5 text-ink-muted">
              Share the connection guide above with your agent. Approved connections will appear here after sign-in.
            </p>
          </div>
        ) : (
          <ul aria-label="Authorized connections" className="mt-5 border-b border-trace-subtle">
            {apps.map((app) => {
              const active = app.state === "ACTIVE";
              const busy = busyConnectionId === app.connectionId;
              const permission = permissionCopy(app);
              return (
                <li className="border-t border-trace-subtle px-3 py-5" key={app.connectionId}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h4
                          ref={(node) => {
                            if (node) headingRefs.current.set(app.connectionId, node);
                            else headingRefs.current.delete(app.connectionId);
                          }}
                          className="break-words text-sm font-semibold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                          tabIndex={-1}
                        >
                          {app.clientName}
                        </h4>
                        <span className={active ? "text-xs font-medium text-positive" : "text-xs font-medium text-ink-muted"}>
                          {active ? "Authorized" : "Revoked"}
                        </span>
                      </div>
                      <p className="mt-1 break-all font-mono text-xs text-ink-muted">{app.clientOrigin}</p>
                      <p className="mt-2 text-sm font-medium text-ink-secondary">{permission.label}</p>
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted">
                        <span className="flex items-center gap-1.5">
                          <ShieldCheck className="size-3.5" aria-hidden="true" />
                          Authorized <time dateTime={app.connectedAt}>{timestamp(app.connectedAt)}</time>
                        </span>
                        <span className="flex items-center gap-1.5">
                          <Clock3 className="size-3.5" aria-hidden="true" />
                          Last used {app.lastUsedAt ? <time dateTime={app.lastUsedAt}>{timestamp(app.lastUsedAt)}</time> : "never"}
                        </span>
                      </div>
                      {!active && app.revokedAt ? (
                        <p className="mt-2 text-xs text-ink-muted">
                          Revoked <time dateTime={app.revokedAt}>{timestamp(app.revokedAt)}</time> · {permission.retained}
                        </p>
                      ) : null}
                    </div>
                    {active ? (
                      <UiV2Button
                        aria-label={`Revoke ${app.clientName} ${permission.label} access`}
                        busy={busy}
                        disabled={Boolean(busyConnectionId)}
                        icon="lock"
                        onClick={() => void revokeConnectedAppAccess(app.connectionId).catch(() => undefined)}
                        tone="destructive"
                      >
                        Revoke access
                      </UiV2Button>
                    ) : (
                      <span className="flex min-h-control items-center gap-1.5 text-xs text-ink-muted">
                        <Unplug className="size-3.5" aria-hidden="true" /> Access revoked
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {error && apps.length > 0 ? (
          <p className="mt-4 flex items-center justify-between gap-3 text-sm text-critical" role="alert">
            The connection could not be updated. Try again.
            <button
              className="shrink-0 rounded-control px-2 py-1 text-xs text-ink-secondary outline-none focus-visible:ring-2 focus-visible:ring-focus"
              onClick={() => void refreshConnectedApps(true).catch(() => undefined)}
              type="button"
            >
              Refresh state
            </button>
          </p>
        ) : null}
      </section>
    </div>
  );
}
