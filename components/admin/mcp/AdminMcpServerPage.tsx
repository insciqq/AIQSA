"use client";

import { AdminMcpToolAccessEditor, mcpToolAccessSummary } from "./AdminMcpToolAccessEditor";
import { adminMcpErrorMessage } from "@/components/admin/adminMcpApi";
import { safeMcpEndpoint } from "@/lib/contracts/mcp";
import {
  adminMcpActivationStage,
  adminMcpActivationVerb,
  isAdminMcpActivationPending
} from "@/components/admin/mcp/adminMcpActivation";
import {
  activeInventory,
  draftInventory,
} from "@/components/admin/mcp/adminMcpDraft";
import {
  AdminMcpServerGroupAccessPanel,
  AdminMcpServerUserAccessPanel
} from "@/components/admin/mcp/AdminMcpGrantPanels";
import {
  AdminMcpOneTimeValues,
  mcpOneTimeRequest,
  type AdminMcpOneTimeValueDraft
} from "@/components/admin/mcp/AdminMcpOneTimeValues";
import { cardClass, McpNote, McpServerTile, McpStatusPill, sectionHeadingClass } from "@/components/admin/mcp/mcpPrimitives";
import {
  mcpAuthorizationState,
  mcpHeaderStatus,
  mcpOAuthOutcomeCopy,
  mcpSourceLabel,
  type AdminMcpOAuthOutcome
} from "@/components/admin/mcp/mcpServerView";
import type { AdminFeedbackController } from "@/components/admin/useAdminFeedback";
import type { AdminMcpController } from "@/components/admin/useAdminMcpController";
import { UiV2Button, UiV2IconButton, UiV2Switch } from "@/components/ui-v2";
import type { AdminGroup, AdminUserRecord } from "@/lib/contracts/admin";
import type { AdminMcpServer } from "@/lib/contracts/mcp";
import { CircleAlert, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const linkButton = "v2-button v2-focusable";

export type AdminMcpServerPageProps = Readonly<{
  controller: AdminMcpController;
  feedback: Pick<AdminFeedbackController, "reportError">;
  groups: readonly AdminGroup[];
  /** The outcome of the validation OAuth return for this server, shown once in the banner. */
  oauthOutcome: AdminMcpOAuthOutcome | null;
  onDismissOAuthOutcome(): void;
  onOpenSettings(): void;
  oneTimeValues: AdminMcpOneTimeValueDraft;
  server: AdminMcpServer;
  setOneTimeValues(values: AdminMcpOneTimeValueDraft): void;
  users: readonly AdminUserRecord[];
}>;

/**
 * The setup in progress, the last failed setup, or the OAuth return: one
 * banner slot at the top of the page (PRD 5.10). Progress comes from the
 * background pipeline the controller polls.
 */
function ActivationBanner({
  controller,
  oauthOutcome,
  onDismissOAuthOutcome,
  onOpenSettings,
  server
}: Readonly<{
  controller: AdminMcpController;
  oauthOutcome: AdminMcpOAuthOutcome | null;
  onDismissOAuthOutcome(): void;
  onOpenSettings(): void;
  server: AdminMcpServer;
}>) {
  const activation = server.activation;
  const stage = adminMcpActivationStage(server);

  if (stage && activation && isAdminMcpActivationPending(activation)) {
    return (
      <section
        aria-live="polite"
        className="rounded-[12px] border border-proof/25 bg-proof/[0.06] px-4 py-3"
        data-testid="admin-mcp-activation-progress"
        role="status"
      >
        <div className="flex min-w-0 items-start gap-3">
          <LoaderCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0 animate-spin text-proof" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <p className="text-sm font-semibold text-ink">{adminMcpActivationVerb(server)} · {stage.label}</p>
              <span className="text-metadata text-ink-muted">Step {stage.step} of {stage.total}</span>
            </div>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-ink-secondary">{stage.detail}</p>
            <div aria-hidden="true" className="mt-3 grid gap-1" style={{ gridTemplateColumns: `repeat(${stage.total}, minmax(0, 1fr))` }}>
              {Array.from({ length: stage.total }, (_, index) => (
                <span className={`h-1 rounded-pill ${index < stage.step ? "bg-proof" : "bg-trace-strong"}`} key={index} />
              ))}
            </div>
            <p className="mt-2 text-metadata text-ink-muted">Continues in the background. You can leave this page and come back.</p>
          </div>
        </div>
      </section>
    );
  }

  if (activation?.stage === "failed") {
    const reason = adminMcpErrorMessage({ code: activation.errorCode ?? "mcp_admin_action_failed", issues: activation.issues });
    return (
      <section className="rounded-[12px] border border-critical/25 bg-critical/5 px-4 py-3" data-testid="admin-mcp-activation-failed" role="alert">
        <div className="flex min-w-0 items-start gap-3">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-critical" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-ink">Setup failed</p>
            <p className="mt-1 max-w-3xl break-words text-xs leading-5 text-ink-secondary [overflow-wrap:anywhere]">{reason}</p>
            <p className="mt-1 text-metadata text-ink-muted">The configuration in use, if any, is unchanged.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <UiV2Button
                disabled={controller.state.busy || Boolean(server.archivedAt)}
                icon="regenerate"
                onClick={() => void controller.actions.activate(server.id)}
                tone="primary"
                type="button"
              >
                Retry
              </UiV2Button>
              <UiV2Button disabled={Boolean(server.archivedAt)} icon="settings" onClick={onOpenSettings} tone="ghost" type="button">
                Open settings
              </UiV2Button>
            </div>
          </div>
        </div>
      </section>
    );
  }

  if (oauthOutcome) {
    const copy = mcpOAuthOutcomeCopy(oauthOutcome);
    return (
      <McpNote data-testid="admin-mcp-oauth-return" role="status" tone={copy.tone}>
        <div className="flex items-start justify-between gap-3">
          <span className="min-w-0 flex-1">{copy.text}</span>
          <UiV2IconButton icon="close" label="Dismiss" onClick={onDismissOAuthOutcome} />
        </div>
      </McpNote>
    );
  }

  const correction = server.activeRevision?.validationEvidence.evidence.endpointCorrection;
  const endpoint = correction && typeof correction === "object" && !Array.isArray(correction) && correction.kind === "gitlab"
    ? safeMcpEndpoint(correction.endpoint) : undefined;
  if (endpoint) return <McpNote data-testid="admin-mcp-endpoint-corrected" role="status" tone="ok">
    <span className="[overflow-wrap:anywhere]">Corrected the GitLab MCP URL to {endpoint}. Initialization and tool discovery passed before saving.</span>
  </McpNote>;
  return null;
}

function AuthorizationCard({ controller, server }: Readonly<{ controller: AdminMcpController; server: AdminMcpServer }>) {
  const state = mcpAuthorizationState(server);
  const connection = server.validationOAuth;
  const archived = Boolean(server.archivedAt);
  const encoded = encodeURIComponent(server.id);
  const connectHref = `/api/admin/mcp/${encoded}/oauth/validation/connect`;
  const reconnectHref = `/api/admin/mcp/${encoded}/oauth/validation/reconnect`;
  const ready = connection?.state === "ready";
  const reconnect = connection?.state === "reauthorization_required";
  const disconnecting = connection?.state === "disconnecting";
  return (
    <section aria-labelledby="mcp-authorization-heading" className="grid grid-cols-[minmax(0,1fr)] gap-2.5">
      <h3 className={sectionHeadingClass} id="mcp-authorization-heading">Authorization</h3>
      <div className={cardClass}>
        <div className="grid gap-3 px-5 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <McpStatusPill label={state.label} testId="mcp-authorization-state" tone={state.tone} />
              <span className="text-sm text-ink">{state.detail}</span>
            </div>
            <p className="mt-1 text-xs leading-5 text-ink-muted">
              Your account is used only to check the settings. People connect their own accounts in chat settings.
            </p>
          </div>
          {archived ? null : (
            <div className="flex flex-wrap gap-2">
              {ready || reconnect ? (
                <a className={linkButton} data-tone={reconnect ? "primary" : "ghost"} href={reconnectHref}>
                  <span>Reconnect</span>
                </a>
              ) : (
                <a aria-disabled={disconnecting ? true : undefined} className={linkButton} data-tone="primary" href={connectHref}>
                  <span>Connect</span>
                </a>
              )}
              <UiV2Button
                disabled={controller.state.busy || !connection || connection.state === "disconnected" || disconnecting}
                onClick={() => void controller.actions.disconnectValidationOAuth(server.id)}
                tone="ghost"
                type="button"
              >
                Disconnect
              </UiV2Button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function ToolsSection({ controller, groups, server, users }: Pick<AdminMcpServerPageProps, "controller" | "groups" | "server" | "users">) {
  const [editingTool, setEditingTool] = useState<string | null>(null);
  const accessTrigger = useRef<HTMLButtonElement | null>(null);
  const [query, setQuery] = useState("");
  const [onlyEnabled, setOnlyEnabled] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const tools = server.activeRevision ? activeInventory(server) : draftInventory(server);
  const disabledNames = new Set((server.activeRevision
    ? server.activeRevision.disabledToolNames : server.draft.disabledToolNames) ?? []);
  const enabledCount = tools.filter(({ name }) => !disabledNames.has(name)).length;
  const search = query.trim().toLocaleLowerCase();
  const filtered = tools.filter((tool) =>
    (!onlyEnabled || !disabledNames.has(tool.name)) &&
    (!search || `${tool.name} ${tool.description ?? ""}`.toLocaleLowerCase().includes(search)));
  const shown = expanded ? filtered : filtered.slice(0, 6);
  const locked = controller.state.busy || Boolean(server.archivedAt) || !server.activeRevision;
  useEffect(() => {
    if (editingTool !== null || controller.state.busy || !accessTrigger.current) return;
    // Wait for the closing render to re-enable the trigger before focusing it.
    const trigger = accessTrigger.current;
    accessTrigger.current = null;
    if (trigger.isConnected && !trigger.disabled) trigger.focus();
    else searchRef.current?.focus();
  }, [editingTool, controller.state.busy]);
  const setTool = async (name: string, enabled: boolean) => {
    const saved = await controller.actions.update(server.id, {
      expectedUpdatedAt: server.updatedAt,
      tool: { enabled, name }
    });
    if (saved && onlyEnabled && !enabled) searchRef.current?.focus();
  };

  return (
    <section aria-labelledby="mcp-tools-heading" className="grid grid-cols-[minmax(0,1fr)] gap-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className={sectionHeadingClass} id="mcp-tools-heading">Tools</h3>
        <span className="text-xs text-ink-muted" data-testid="mcp-tools-summary">
          {tools.length ? `${enabledCount} of ${tools.length} on` : "None yet"}
        </span>
      </div>
      <McpNote tone="warn">
        Tools that are on can act and change data without a per-call confirmation; newly discovered tools are on until turned off.
        {server.draft.source.kind !== "remote" ? " Local servers run in an isolated runtime with unrestricted outbound network access." : ""}
      </McpNote>
      {tools.length ? (
        <>
          <p className="text-xs text-ink-muted">{server.activeRevision
            ? "Tool switches apply immediately to new requests."
            : "Use Test & Save before changing which tools are on."}</p>
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <input
              aria-label="Search tools"
              className="min-w-0 flex-1 rounded-[8px] border border-trace-subtle bg-control-surface px-3 py-2 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-focus"
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Search tools…"
              ref={searchRef}
              type="search"
              value={query}
            />
            <label className="flex items-center gap-2 text-xs text-ink-secondary">
              <input checked={onlyEnabled} className="size-4 accent-proof" onChange={(event) => setOnlyEnabled(event.currentTarget.checked)} type="checkbox" />
              Only enabled
            </label>
            {filtered.length > 6 ? (
              <UiV2Button aria-expanded={expanded} onClick={() => setExpanded((value) => !value)} tone="ghost" type="button">
                {expanded ? "Show fewer" : `Show all ${filtered.length}`}
              </UiV2Button>
            ) : null}
          </div>
        </>
      ) : null}
      <div className={cardClass}>
        {shown.length ? (
          <ul aria-label={`Tools of ${server.name}`} className="max-h-[32rem] divide-y divide-trace-subtle overflow-y-auto">
            {shown.map((tool) => (
              <li className="flex min-w-0 items-start justify-between gap-4 px-4 py-3 sm:px-5" data-testid={`mcp-tool-${tool.name}`} key={tool.name}>
                <div className="min-w-0 flex-1">
                  <p className="break-words font-mono text-xs font-medium text-ink [overflow-wrap:anywhere]">{tool.name}</p>
                  {tool.description ? <p className="mt-0.5 break-words text-xs leading-5 text-ink-muted [overflow-wrap:anywhere]">{tool.description}</p> : null}
                  <p className="mt-1 text-xs text-ink-secondary">{mcpToolAccessSummary(server.toolAccess?.find((policy) => policy.name === tool.name))}</p>
                  <UiV2Button aria-label={`Edit access to ${tool.name}`} disabled={locked || editingTool !== null} onClick={(event) => { accessTrigger.current = event.currentTarget; setEditingTool(tool.name); }} tone="ghost" type="button">Edit access</UiV2Button>
                </div>
                <UiV2Switch checked={!disabledNames.has(tool.name)} disabled={locked} label={`Use ${tool.name}`} onChange={(next) => void setTool(tool.name, next)} />
              </li>
            ))}
          </ul>
        ) : (
          <div className="px-5 py-6 text-sm text-ink-muted" role="status">
            {tools.length ? "No tools match your filters." : server.activeRevision ? "This server exposes no tools." : "Use Test & Save to discover this server’s tools."}
            {tools.length ? <UiV2Button onClick={() => { setQuery(""); setOnlyEnabled(false); searchRef.current?.focus(); }} tone="ghost" type="button">Clear filters</UiV2Button> : null}
          </div>
        )}
      </div>
      {editingTool ? <AdminMcpToolAccessEditor controller={controller} groups={groups} key={`${server.id}:${editingTool}`} name={editingTool} onClose={() => setEditingTool(null)} server={server} users={users} /> : null}
    </section>
  );
}

/**
 * One server page (PRD 5.10): the state line with Test & Save on top, the
 * setup progress or OAuth return as one banner, the values a check still
 * needs, the administrator's authorization, the tools with their switches
 * and who may use the server. Settings and the `⋯` actions live in the
 * topbar the section owns.
 */
export function AdminMcpServerPage({
  controller,
  feedback,
  groups,
  oauthOutcome,
  onDismissOAuthOutcome,
  onOpenSettings,
  oneTimeValues,
  server,
  setOneTimeValues,
  users
}: AdminMcpServerPageProps) {
  const [saving, setSaving] = useState(false);
  const archived = Boolean(server.archivedAt);
  const applying = isAdminMcpActivationPending(server.activation);

  const testAndSave = async () => {
    setSaving(true);
    try {
      const result = await controller.actions.save(server.id, {
        oneTimeValues: mcpOneTimeRequest(server, oneTimeValues)
      });
      if (result.applied) setOneTimeValues({});
      else if (result.message) feedback.reportError(result.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex max-w-[1120px] flex-col gap-7 px-4 py-6 sm:px-6 lg:px-8" data-testid="mcp-server-page">
      <header className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start">
        <McpServerTile label={server.name} size="header" />
        <div className="min-w-0 flex-1">
          <h2 className="break-words text-xl font-semibold leading-tight text-ink [overflow-wrap:anywhere]">{server.name}</h2>
          <p className="mt-0.5 text-[13px] text-ink-muted" data-testid="mcp-server-page-status">{mcpHeaderStatus(server)}</p>
          <p className="mt-1 break-words text-xs text-ink-muted [overflow-wrap:anywhere]">{mcpSourceLabel(server)}</p>
          {server.description ? (
            <p className="mt-1 max-w-3xl break-words text-sm leading-6 text-ink-secondary [overflow-wrap:anywhere]">{server.description}</p>
          ) : null}
        </div>
        {archived ? null : (
          <div className="flex flex-col items-start gap-1 sm:items-end">
            <UiV2Button
              busy={saving}
              data-testid="mcp-test-save"
              disabled={controller.state.busy || applying}
              icon="flask"
              onClick={() => void testAndSave()}
              tone="primary"
              type="button"
            >
              Test &amp; Save
            </UiV2Button>
            <span className="max-w-[18rem] text-xs leading-5 text-ink-muted sm:text-right">
              Checks the connection and tools, then applies the settings. A failed check changes nothing.
            </span>
          </div>
        )}
      </header>

      {archived ? <McpNote data-testid="mcp-archived-note">This server is archived and kept for records only.</McpNote> : null}

      <ActivationBanner
        controller={controller}
        oauthOutcome={oauthOutcome}
        onDismissOAuthOutcome={onDismissOAuthOutcome}
        onOpenSettings={onOpenSettings}
        server={server}
      />

      {archived ? null : (
        <AdminMcpOneTimeValues
          disabled={controller.state.busy}
          onChange={setOneTimeValues}
          server={server}
          values={oneTimeValues}
        />
      )}

      {server.draft.auth.mode === "oauth" ? <AuthorizationCard controller={controller} server={server} /> : null}

      <ToolsSection controller={controller} groups={groups} server={server} users={users} />

      <section aria-labelledby="mcp-access-heading" className="grid grid-cols-[minmax(0,1fr)] gap-2.5">
        <h3 className={sectionHeadingClass} id="mcp-access-heading">Access</h3>
        <p className="text-xs leading-5 text-ink-muted">
          Groups and people who may use this server in chats. Full access groups are always included; personal fields are granted per person.
        </p>
        <h4 className="mt-1 text-xs font-medium text-ink-secondary">Groups</h4>
        <AdminMcpServerGroupAccessPanel controller={controller} groups={groups} server={server} />
        <h4 className="mt-1 text-xs font-medium text-ink-secondary">People</h4>
        <AdminMcpServerUserAccessPanel controller={controller} groups={groups} server={server} users={users} />
      </section>
    </div>
  );
}
