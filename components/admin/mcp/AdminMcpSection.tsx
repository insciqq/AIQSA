"use client";

import { adminSectionPath } from "@/components/admin/adminSections";
import { AdminTopbarMenu, useAdminSectionTopbar, type AdminShellTopbar } from "@/components/admin/AdminShell";
import { AdminMcpConfigurationsSheet } from "@/components/admin/mcp/AdminMcpConfigurationsSheet";
import { AdminMcpList } from "@/components/admin/mcp/AdminMcpList";
import { mcpOneTimeRequest, type AdminMcpOneTimeValueDraft } from "@/components/admin/mcp/AdminMcpOneTimeValues";
import { AdminMcpServerPage } from "@/components/admin/mcp/AdminMcpServerPage";
import { AdminMcpSettingsSheet } from "@/components/admin/mcp/AdminMcpSettingsSheet";
import {
  readAdminMcpOAuthReturn,
  withoutAdminMcpOAuthReturn,
  type AdminMcpOAuthReturn
} from "@/components/admin/mcp/mcpServerView";
import type { AdminConfirmationController } from "@/components/admin/useAdminConfirmationController";
import type { AdminFeedbackController } from "@/components/admin/useAdminFeedback";
import type { AdminMcpController } from "@/components/admin/useAdminMcpController";
import { UiV2Button, UiV2Icon } from "@/components/ui-v2";
import type { AdminDashboard } from "@/lib/contracts/admin";
import type { AdminMcpServer } from "@/lib/contracts/mcp";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";

const crumbLink =
  "rounded-[6px] font-medium text-ink-muted outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-focus";

export type AdminMcpSectionProps = Readonly<{
  controller: AdminMcpController;
  dashboard: Pick<AdminDashboard, "groups" | "users">;
  feedback: Pick<AdminFeedbackController, "reportError" | "reportNotice">;
  onSelectResource(resource: string | null): void;
  requestConfirmation: AdminConfirmationController["requestConfirmation"];
  /** Open server page from `?resource=`, or null for the list. */
  resource: string | null;
}>;

type OpenSheet = Readonly<{ kind: "configurations" | "settings"; serverId: string }>;

/** Values typed for one check belong to the page they were typed on. */
type OneTimeDraft = Readonly<{ resource: string | null; values: AdminMcpOneTimeValueDraft }>;

const NO_VALUES: AdminMcpOneTimeValueDraft = {};

function Crumbs({ current, onBack }: Readonly<{ current: string; onBack(): void }>) {
  const href = adminSectionPath(typeof window === "undefined" ? "/admin" : window.location.href, "mcp");
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <a
        className={crumbLink}
        href={href}
        onClick={(event: MouseEvent<HTMLAnchorElement>) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          onBack();
        }}
      >
        MCP servers
      </a>
      <UiV2Icon className="size-3.5 shrink-0 text-ink-muted" name="chevron-right" />
      <span className="truncate">{current}</span>
    </span>
  );
}

/**
 * MCP servers section (PRD 5.10): the list, one server page per
 * `?resource=`, the Settings and Earlier configurations sheets, and the
 * validation OAuth return. The section owns the topbar; the panel owns the
 * controller because the Users and Groups pages share it.
 */
export function AdminMcpSection({
  controller,
  dashboard,
  feedback,
  onSelectResource,
  requestConfirmation,
  resource
}: AdminMcpSectionProps) {
  const [creatingRequested, setCreating] = useState(false);
  // Keyed by the open page so a page change never carries a sheet along.
  const [openSheet, setOpenSheet] = useState<OpenSheet | null>(null);
  const [oneTimeDraft, setOneTimeDraft] = useState<OneTimeDraft>({ resource: null, values: NO_VALUES });
  const oneTimeValues = oneTimeDraft.resource === resource ? oneTimeDraft.values : NO_VALUES;
  const setOneTimeValues = useCallback(
    (values: AdminMcpOneTimeValueDraft) => setOneTimeDraft({ resource, values }),
    [resource]
  );
  const [oauthReturn] = useState<AdminMcpOAuthReturn | null>(() =>
    typeof window === "undefined" ? null : readAdminMcpOAuthReturn(window.location.href));
  const [oauthDismissed, setOauthDismissed] = useState(false);
  const oauthHandledRef = useRef(false);
  const { busy, error, loaded, loading, servers } = controller.state;
  const creating = creatingRequested && resource === null;
  const server = useMemo(
    () => (resource ? servers.find(({ id }) => id === resource) ?? null : null),
    [resource, servers]
  );
  const settingsOpen = resource !== null && openSheet?.kind === "settings" && openSheet.serverId === resource;
  const configurationsOpen = resource !== null && openSheet?.kind === "configurations" && openSheet.serverId === resource;

  // The OAuth callback lands on the list with `oauth` and `server`; open that
  // server's page once the catalog knows it and keep only the outcome.
  useEffect(() => {
    if (oauthHandledRef.current || !oauthReturn || !loaded || typeof window === "undefined") return;
    oauthHandledRef.current = true;
    window.history.replaceState(window.history.state, "", withoutAdminMcpOAuthReturn(window.location.href));
    if (oauthReturn.serverId && servers.some(({ id }) => id === oauthReturn.serverId)) {
      onSelectResource(oauthReturn.serverId);
    }
  }, [loaded, oauthReturn, onSelectResource, servers]);

  const backToList = useCallback(() => {
    setCreating(false);
    onSelectResource(null);
  }, [onSelectResource]);

  const requestDelete = useCallback((target: AdminMcpServer) => {
    const name = target.name;
    requestConfirmation({
      body: `“${name}” disappears from chats and Control Center for everyone right away. Chats already running may finish. This cannot be undone.`,
      confirmLabel: "Delete server",
      dialogLabel: `Delete ${name}`,
      icon: "trash",
      onConfirm: async () => {
        const deleted = await controller.actions.delete(target.id);
        if (deleted) onSelectResource(null);
      },
      testId: "admin-confirm-delete-mcp-server",
      title: `Delete “${name}”?`,
      tone: "destructive"
    });
  }, [controller.actions, onSelectResource, requestConfirmation]);

  const checkUpdate = useCallback(async (target: AdminMcpServer) => {
    const ok = await controller.actions.checkUpdate(target.id, {
      oneTimeValues: mcpOneTimeRequest(target, oneTimeValues)
    });
    if (ok) setOneTimeValues(NO_VALUES);
  }, [controller.actions, oneTimeValues, setOneTimeValues]);

  const topbar = useMemo<AdminShellTopbar>(() => {
    if (resource && server) {
      const archived = server.archivedAt !== null;
      return {
        actions: (
          <>
            <UiV2Button
              data-testid="mcp-open-settings"
              disabled={archived}
              icon="settings"
              onClick={() => setOpenSheet({ kind: "settings", serverId: server.id })}
              tone="ghost"
              type="button"
            >
              Settings
            </UiV2Button>
            {archived ? null : (
              <AdminTopbarMenu
                actions={[
                  {
                    disabled: busy,
                    icon: "regenerate",
                    label: "Check for update",
                    onSelect: () => void checkUpdate(server)
                  },
                  {
                    icon: "history",
                    label: "Earlier configurations",
                    onSelect: () => setOpenSheet({ kind: "configurations", serverId: server.id })
                  },
                  {
                    disabled: busy || (!server.activeRevision && !server.enabled),
                    icon: server.enabled ? "stop" : "check",
                    label: server.enabled ? "Disable" : "Enable",
                    onSelect: () => void controller.actions.update(server.id, { enabled: !server.enabled }),
                    separatorBefore: true
                  },
                  {
                    disabled: busy,
                    icon: "trash",
                    label: "Delete",
                    onSelect: () => requestDelete(server),
                    separatorBefore: true,
                    tone: "destructive"
                  }
                ]}
                label={`More actions for ${server.name}`}
              />
            )}
          </>
        ),
        title: <Crumbs current={server.name} onBack={backToList} />
      };
    }
    if (resource) {
      return { title: <Crumbs current="Server" onBack={backToList} /> };
    }
    return {
      actions: (
        <UiV2Button
          data-testid="mcp-new-server"
          disabled={!loaded}
          icon="plus"
          onClick={() => setCreating(true)}
          tone="primary"
          type="button"
        >
          New server
        </UiV2Button>
      ),
      title: "MCP servers"
    };
  }, [backToList, busy, checkUpdate, controller.actions, loaded, requestDelete, resource, server]);
  useAdminSectionTopbar(topbar);

  if (resource) {
    if (!server) {
      return (
        <div className="px-4 py-12 text-center sm:px-6" data-testid="admin-mcp-section" role={loaded ? "alert" : "status"}>
          {loaded ? (
            <>
              <p className="text-sm font-semibold text-ink-secondary">This MCP server no longer exists.</p>
              <UiV2Button className="mt-4" onClick={backToList} tone="ghost" type="button">Back to MCP servers</UiV2Button>
            </>
          ) : (
            <p className="text-sm text-ink-muted">Loading MCP server…</p>
          )}
        </div>
      );
    }
    const oauthOutcome = !oauthDismissed && oauthReturn?.serverId === server.id ? oauthReturn.outcome : null;
    return (
      <div className="min-w-0" data-testid="admin-mcp-section">
        <AdminMcpServerPage
          controller={controller}
          feedback={feedback}
          groups={dashboard.groups}
          key={server.id}
          oauthOutcome={oauthOutcome}
          onDismissOAuthOutcome={() => setOauthDismissed(true)}
          onOpenSettings={() => setOpenSheet({ kind: "settings", serverId: server.id })}
          oneTimeValues={oneTimeValues}
          server={server}
          setOneTimeValues={setOneTimeValues}
          users={dashboard.users}
        />
        <AdminMcpSettingsSheet
          controller={controller}
          key={`settings:${server.id}`}
          mode={{ kind: "edit", server }}
          onClose={() => setOpenSheet(null)}
          onSaved={() => setOpenSheet(null)}
          open={settingsOpen}
        />
        <AdminMcpConfigurationsSheet
          controller={controller}
          onClose={() => setOpenSheet(null)}
          oneTimeValues={oneTimeValues}
          open={configurationsOpen}
          server={server}
          setOneTimeValues={setOneTimeValues}
        />
      </div>
    );
  }

  return (
    <div className="min-w-0" data-testid="admin-mcp-section">
      <div className="flex max-w-[1120px] flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <AdminMcpList
          error={error}
          loaded={loaded}
          loading={loading}
          onOpen={(serverId) => onSelectResource(serverId)}
          onRetry={() => void controller.actions.refresh()}
          servers={servers}
        />
        <p className="text-xs leading-5 text-ink-muted">
          People use a server&apos;s tools in chat once a group or a direct grant includes them; servers with OAuth also ask each person to connect their own account.
        </p>
      </div>
      <AdminMcpSettingsSheet
        controller={controller}
        mode={{ kind: "create" }}
        onClose={() => setCreating(false)}
        onSaved={(serverId) => {
          setCreating(false);
          onSelectResource(serverId);
        }}
        open={creating}
      />
    </div>
  );
}
