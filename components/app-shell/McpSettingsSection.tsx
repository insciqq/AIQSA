import {
  MCP_RUN_PLAN_LIMITS,
  type McpSlotValue,
  type UserMcpConfigurationField,
  type UserMcpServer
} from "@/lib/contracts/mcp";
import { UiV2Button, UiV2Icon, UiV2IconButton, UiV2Monogram, UiV2Switch } from "@/components/ui-v2";
import { UiV2Sheet } from "@/components/ui-v2/SheetV2";
import { useCallback, useEffect, useRef, useState } from "react";
import { SectionHeading } from "@/features/library-v2/LibraryV2";
import { DiscardChangesConfirmationDialog } from "./ConfirmationDialog";
import { useBeforeUnloadGuard } from "./useBeforeUnloadGuard";
import { McpHubConnection } from "./McpHubConnection";
import {
  disconnectUserMcpServer,
  McpSettingsApiError,
  updateUserMcpServer,
  userMcpOAuthAction
} from "./mcpSettingsApi";
import {
  isMcpOAuthAuthorizing,
  clearMcpOAuthAuthorizing,
  markMcpOAuthAuthorizing,
  observeMcpSettings,
  refreshMcpSettings,
  useMcpSettingsStore
} from "./mcpSettingsStore";
import {
  mcpReadinessPresentation,
  mcpOperationalPresentation,
  mcpSetupAttention,
  type McpReadinessPresentation
} from "./mcpReadiness";

function errorText(error: unknown, server: UserMcpServer): string {
  if (!(error instanceof McpSettingsApiError)) {
    return "The MCP server could not be updated. Try again.";
  }
  if (error.issues.some((issue) => issue.code === "oauth_required" || issue.path === "oauth")) {
    return `Connect ${server.name} to an external account before enabling it.`;
  }
  const missingSlots = error.issues.filter((issue) => issue.code === "slot_value_required");
  if (missingSlots.length) {
    const personalSlotKeys = new Set(server.fields.map((field) => field.slotKey));
    const hasPersonalMissingSlot = missingSlots.some((issue) =>
      issue.path.startsWith("values.") && personalSlotKeys.has(issue.path.slice("values.".length))
    );
    return hasPersonalMissingSlot
      ? "Add and save the required personal values before enabling this server."
      : "This server needs additional administrator configuration before it can be enabled.";
  }
  if (error.code === "invalid_mcp_values") {
    return "The MCP settings could not be saved. Review the values and try again.";
  }
  if (error.status === 404) return "This MCP server is no longer available to your account.";
  return "The MCP server could not be updated. Try again.";
}

function readinessTone(kind: McpReadinessPresentation["kind"]): "danger" | "neutral" | "ok" | "warn" {
  if (kind === "ready") return "ok";
  if (kind === "failed") return "danger";
  if (kind === "attention") return "warn";
  return "neutral";
}

function toolCountLabel(count: number): string {
  return `${count} tool${count === 1 ? "" : "s"}`;
}

type ServerEdits = Record<string, Record<string, McpSlotValue | null>>;

function fieldValue(
  field: UserMcpConfigurationField,
  edits: Readonly<Record<string, McpSlotValue | null>>
): McpSlotValue | "" {
  if (Object.hasOwn(edits, field.slotKey)) return edits[field.slotKey] ?? "";
  if (!field.sensitive && field.value !== undefined) return field.value;
  return field.valueType === "boolean" ? false : "";
}

function Spinner() {
  return <span className="v2-spinner" aria-hidden="true" />;
}

function FieldEditor({
  disabled,
  edits,
  field,
  inputId,
  onChange
}: Readonly<{
  disabled: boolean;
  edits: Readonly<Record<string, McpSlotValue | null>>;
  field: UserMcpConfigurationField;
  inputId: string;
  onChange(value: McpSlotValue | null): void;
}>) {
  const value = fieldValue(field, edits);
  const status = field.source === "personal"
    ? "Personal value configured"
    : field.source === "shared"
      ? "Using the administrator’s shared value"
      : "No value configured";

  return (
    <div className="v2-settings-field">
      <div className="v2-settings-field-head">
        <label htmlFor={inputId}>{field.label}</label>
        <span className="v2-settings-field-status">{status}</span>
      </div>
      {field.description ? <p className="v2-settings-field-note">{field.description}</p> : null}
      <div className="v2-settings-field-controls">
        {field.valueType === "boolean" ? (
          <button
            aria-pressed={value === true}
            className="v2-settings-select-trigger v2-focusable"
            disabled={disabled}
            id={inputId}
            onClick={() => onChange(value !== true)}
            type="button"
          >
            Personal override
            <span className="v2-settings-field-toggle" data-on={value === true || undefined}>
              {value === true ? "On" : "Off"}
            </span>
          </button>
        ) : field.valueType === "enum" && field.enumValues?.length ? (
          <select
            className="v2-settings-input"
            disabled={disabled}
            id={inputId}
            onChange={(event) => onChange(event.target.value)}
            value={typeof value === "string" ? value : ""}
          >
            <option value="">Choose a value</option>
            {field.enumValues.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        ) : (
          <input
            autoComplete="off"
            className="v2-settings-input"
            disabled={disabled}
            id={inputId}
            inputMode={field.valueType === "number" ? "decimal" : undefined}
            maxLength={field.maxLength}
            minLength={field.minLength}
            onChange={(event) => onChange(
              field.valueType === "number"
                ? event.target.value === "" ? "" : Number(event.target.value)
                : event.target.value
            )}
            placeholder={field.sensitive && field.configured ? "Enter a replacement value" : "Enter a value"}
            type={field.sensitive || field.valueType === "secret" ? "password" : field.valueType === "number" ? "number" : "text"}
            value={typeof value === "boolean" ? String(value) : value}
          />
        )}
        <UiV2Button
          disabled={disabled || (!field.configured && !Object.hasOwn(edits, field.slotKey))}
          onClick={() => onChange(null)}
        >
          Clear personal value
        </UiV2Button>
      </div>
      {field.sensitive ? (
        <p className="v2-settings-field-note">
          <UiV2Icon name="lock" />
          Stored values are write-only and are never shown again.
        </p>
      ) : null}
    </div>
  );
}

function OAuthLink({
  authorizing,
  disabled = false,
  href,
  label,
  onStart,
  onCancel,
  tone = "ghost",
  ...props
}: Readonly<{
  "aria-label"?: string;
  authorizing: boolean;
  disabled?: boolean;
  href: string;
  label: string;
  onStart(): void;
  onCancel(): void;
  tone?: "ghost" | "primary";
}>) {
  return (
    <a
      role="link"
      aria-busy={authorizing || undefined}
      aria-disabled={authorizing || disabled || undefined}
      aria-label={props["aria-label"]}
      className="v2-button v2-focusable"
      data-tone={tone}
      href={disabled ? undefined : href}
      tabIndex={authorizing || disabled ? -1 : undefined}
      onClick={(event) => {
        if (authorizing || disabled) {
          event.preventDefault();
          return;
        }
        onStart();
        queueMicrotask(() => { if (event.defaultPrevented) onCancel(); });
      }}
    >
      {authorizing ? <Spinner /> : <UiV2Icon name="lock" />}
      <span>{authorizing ? "Authorizing" : label}</span>
    </a>
  );
}

function ServerRow({
  edits,
  enableIssue,
  onBusyChange,
  onEdit,
  oauthBlockedReason,
  server,
  visible
}: Readonly<{
  edits: Readonly<Record<string, McpSlotValue | null>>;
  enableIssue: string | null;
  onBusyChange(busy: boolean): void;
  onEdit(slotKey: string, value: McpSlotValue | null | undefined): void;
  oauthBlockedReason: string | null;
  server: UserMcpServer;
  visible: boolean;
}>) {
  const replaceServer = useMcpSettingsStore((state) => state.replaceServer);
  const refreshing = useMcpSettingsStore((state) => state.loadState === "loading");
  const refreshError = useMcpSettingsStore((state) => state.error);
  const [busy, setBusy] = useState<"disconnect" | "save" | "toggle" | null>(null);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const openRef = useRef<HTMLButtonElement>(null);
  const [authorizing, setAuthorizing] = useState(() => isMcpOAuthAuthorizing(server.id));
  const hasEdits = Object.keys(edits).length > 0;
  const cancelAuthorization = useCallback(() => {
    clearMcpOAuthAuthorizing(server.id);
    setAuthorizing(false);
  }, [server.id]);
  useEffect(() => {
    if (!authorizing) return;
    // A cancelled/failed document navigation leaves this owner alive. Restore
    // its controls promptly; the storage TTL only covers abandoned documents.
    const timer = window.setTimeout(cancelAuthorization, 2_000);
    window.addEventListener("pageshow", cancelAuthorization);
    return () => { window.clearTimeout(timer); window.removeEventListener("pageshow", cancelAuthorization); };
  }, [authorizing, cancelAuthorization]);
  const connected = server.oauthState === "ready" || server.oauthState === "reauthorization_required";
  const needsOAuth = server.oauthAvailable && server.oauthState !== "ready";
  const missingPersonalField = server.fields.find((field) => field.source === "missing");
  const authorizationBlocked = oauthBlockedReason ?? (missingPersonalField
    ? "Add and save the required personal values before connecting." : null);
  const readiness = mcpReadinessPresentation(server.readiness, server.runtimeErrorCode);
  const operational = mcpOperationalPresentation(server);
  // The catalog count is informational: tool names appear once the runtime
  // reported them, so the fold below lists the exact tools only then.
  const toolCount = server.tools.length || server.knownToolCount;

  async function run(kind: typeof busy, operation: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(kind);
    onBusyChange(true);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      setError(errorText(cause, server));
    } finally {
      busyRef.current = false;
      setBusy(null);
      onBusyChange(false);
    }
  }

  const startAuthorization = () => {
    markMcpOAuthAuthorizing(server.id);
    setAuthorizing(true);
    setError(null);
  };

  const toggle = (enabled: boolean) => {
    if (enabled && enableIssue) {
      setError(enableIssue);
      return;
    }
    void run("toggle", async () => {
      replaceServer(await updateUserMcpServer(server.id, { enabled }));
    });
  };

  function close() {
    setConfirmDiscard(false);
    setOpen(false);
    // Complete setup may disappear after saving. The chevron remains a stable
    // return target, after the modal layer has restored the original opener.
    requestAnimationFrame(() => openRef.current?.focus());
  }

  function requestClose() {
    if (busyRef.current || authorizing) return;
    if (hasEdits) setConfirmDiscard(true);
    else close();
  }

  const status = (
    <p aria-live="polite" className="v2-settings-server-status" role="status">
      <span className="v2-settings-server-readiness" data-tone={readinessTone(operational.kind)}>
        {operational.kind === "ready" ? <UiV2Icon name="check" />
          : operational.kind === "progress" ? <Spinner /> : null}
        {operational.label}
      </span>
      {toolCount > 0 ? <><span aria-hidden="true"> · </span><span>{toolCountLabel(toolCount)}</span></> : null}
      {readiness.kind === "attention" || readiness.kind === "failed" ? <>
        <span className="v2-settings-server-readiness v2-settings-server-attention" data-tone={readinessTone(readiness.kind)}>{readiness.label}</span>
      </> : null}
    </p>
  );

  return (
    <>
    {visible ? <article
      aria-labelledby={`mcp-server-${server.id}`}
      className="v2-settings-server"
      data-enabled={server.enabled || undefined}
      data-resource-availability-row={server.enabled ? "enabled" : "disabled"}
    >
      <div className="v2-settings-server-head">
        <UiV2Monogram className="v2-settings-server-mark" label={server.name} />
        <div className="v2-settings-server-copy">
          <h4 id={`mcp-server-${server.id}`}>{server.name}</h4>
          {server.description ? <p className="v2-settings-server-description">{server.description}</p> : null}
        </div>
        <div className="v2-settings-server-summary">{status}</div>
        <div className="v2-settings-server-action">
          <UiV2IconButton icon="chevron-right" label={`Open ${server.name}`} ref={openRef}
            onClick={() => setOpen(true)} />
          {!server.enabled && missingPersonalField ? (
            <UiV2Button
              aria-label={`Complete setup for ${server.name}`}
              disabled={busy !== null}
              tone="primary"
              onClick={() => {
                setError("Add and save the required personal values before enabling this server.");
                setOpen(true);
                requestAnimationFrame(() => document.getElementById(`mcp-field-${server.id}-${missingPersonalField.slotKey}`)?.focus());
              }}
            >
              Complete setup
            </UiV2Button>
          ) : !server.enabled && needsOAuth ? (
            <OAuthLink
              aria-label={`${server.oauthState === "reauthorization_required" ? "Reconnect" : "Connect"} ${server.name} to enable`}
              authorizing={authorizing}
              disabled={busy !== null || Boolean(oauthBlockedReason)}
              onCancel={cancelAuthorization}
              href={userMcpOAuthAction(server.id, server.oauthState === "reauthorization_required")}
              label={server.oauthState === "reauthorization_required" ? "Reconnect to enable" : "Connect to enable"}
              tone="primary"
              onStart={startAuthorization}
            />
          ) : (
              <UiV2Switch
                aria-busy={busy === "toggle" || undefined}
                checked={server.enabled}
                disabled={busy !== null}
                label={`Enable ${server.name}`}
                onChange={toggle}
              />
          )}
        </div>
      </div>
      {!open && error ? <p className="v2-settings-error" role="alert">{error}</p> : null}
      {!open && authorizing ? <p className="v2-settings-field-note" role="status">Authorizing in your browser…</p> : null}
      {!open && server.oauthAvailable && oauthBlockedReason ? <p className="v2-settings-field-note" role="status">{oauthBlockedReason}</p> : null}
    </article> : null}
    <UiV2Sheet open={open} title={server.name} testId="mcp-server-sheet" width="wide"
      description={server.description ? <span className="v2-settings-server-full-description">{server.description}</span> : undefined}
      closeBlocked={busy !== null || authorizing} onClose={requestClose}
      footer={<>
        <UiV2Button disabled={busy !== null || authorizing} onClick={requestClose}>Cancel</UiV2Button>
        {server.fields.length ? <UiV2Button busy={busy === "save"} disabled={!hasEdits || busy !== null || authorizing}
          tone="primary" onClick={() => void run("save", async () => {
            replaceServer(await updateUserMcpServer(server.id, { values: edits }));
            for (const slotKey of Object.keys(edits)) onEdit(slotKey, undefined);
          })}>Save personal values</UiV2Button> : null}
      </>}>
      <div className="v2-settings-server-details">
      <section className="v2-settings-server-section" aria-label={`${server.name} status`}>
        <div className="v2-settings-server-section-copy">
          <h3 className="v2-settings-server-section-title">Status</h3>
          {status}
          <span className="v2-settings-server-section-note">{server.enabled ? "Connection enabled" : "Connection disabled"}</span>
        </div>
        <UiV2Button busy={refreshing} disabled={refreshing || busy !== null}
          onClick={() => void refreshMcpSettings(true).catch(() => undefined)}>Refresh status</UiV2Button>
        {error ? <p className="v2-settings-error" role="alert">{error}</p> : null}
        {refreshError ? <p className="v2-settings-field-note" role="status">Status could not be refreshed. Try again.</p> : null}
      </section>
      {server.fields.length ? (
        <section className="v2-settings-server-section v2-settings-server-fields" aria-label={`${server.name} personal configuration`}>
          <div className="v2-settings-server-section-copy">
            <h3 className="v2-settings-server-section-title">Personal values</h3>
            <span className="v2-settings-server-section-note">
              You can change only the fields your administrator made personal. Server endpoints and launch settings remain installation-owned.
            </span>
            {hasEdits ? <span className="v2-settings-server-section-note" data-tone="warn">Unsaved personal values</span> : null}
          </div>
          <div className="v2-settings-field-list">
            {server.fields.map((field) => (
              <FieldEditor
                disabled={busy !== null || authorizing}
                edits={edits}
                field={field}
                inputId={`mcp-field-${server.id}-${field.slotKey}`}
                key={field.slotKey}
                onChange={(value) => onEdit(field.slotKey, value)}
              />
            ))}
          </div>
        </section>
      ) : null}
      {server.oauthAvailable ? (
        <section className="v2-settings-server-section" aria-label={`${server.name} authorization`}>
          <div className="v2-settings-server-section-copy">
            <h3 className="v2-settings-server-section-title">Authorization</h3>
            <span className="v2-settings-server-section-note">
              {authorizing ? "Authorizing in your browser…" : server.accountLabel ?? "No external account connected"}
            </span>
            {authorizationBlocked ? <span className="v2-settings-field-note" role="status">{authorizationBlocked}</span> : null}
          </div>
          <div className="v2-settings-server-section-actions">
            <OAuthLink authorizing={authorizing} disabled={busy !== null || Boolean(authorizationBlocked)}
              onCancel={cancelAuthorization} href={userMcpOAuthAction(server.id, connected)}
              label={connected ? "Reconnect" : "Connect"} onStart={startAuthorization} />
            {connected ? <UiV2Button busy={busy === "disconnect"} disabled={busy !== null || authorizing}
              onClick={() => void run("disconnect", async () => {
                await disconnectUserMcpServer(server.id);
                await refreshMcpSettings(true);
              })}>Disconnect</UiV2Button> : null}
          </div>
        </section>
      ) : null}
      <section className="v2-settings-server-section v2-settings-server-fields" aria-label={`${server.name} tools`}>
        <h3 className="v2-settings-server-section-title">Tools{toolCount > 0 ? ` · ${toolCount}` : ""}</h3>
        {server.tools.length ? (
          <ul className="v2-settings-tool-list" aria-label={`${server.name} tools`}>
            {server.tools.map((tool) => (
              <li key={tool.name}>
                <span className="v2-settings-tool-name">{tool.name}</span>
                {tool.description ? <span className="v2-settings-tool-note">{tool.description}</span> : null}
              </li>
            ))}
          </ul>
        ) : <p className="v2-settings-server-section-note">Tool names appear after the server reports them.</p>}
      </section>
      </div>
    </UiV2Sheet>
    {confirmDiscard ? <DiscardChangesConfirmationDialog portal label="MCP personal values"
      copy={{ title: "Discard unsaved changes?", body: "Changes to your personal MCP connection will be lost.",
        dialogLabel: "Unsaved MCP changes", cancelLabel: "Keep editing", confirmLabel: "Discard changes" }}
      onCancel={() => setConfirmDiscard(false)} onConfirm={() => {
        for (const slotKey of Object.keys(edits)) onEdit(slotKey, undefined);
        close();
      }} /> : null}
    </>
  );
}

export function McpSettingsSection({
  onBusyChange,
  onOpenDefaults
}: {
  onBusyChange?(busy: boolean): void;
  onOpenDefaults?(): void;
} = {}) {
  const error = useMcpSettingsStore((state) => state.error);
  const loadState = useMcpSettingsStore((state) => state.loadState);
  const oauthOutcome = useMcpSettingsStore((state) => state.oauthOutcome);
  const servers = useMcpSettingsStore((state) => state.servers);
  const setOAuthOutcome = useMcpSettingsStore((state) => state.setOAuthOutcome);
  const [edits, setEdits] = useState<ServerEdits>({});
  const [filter, setFilter] = useState<"all" | "enabled" | "setup">("all");
  const [query, setQuery] = useState("");
  const [busyServerIds, setBusyServerIds] = useState<ReadonlySet<string>>(() => new Set());
  const enabledServers = servers.filter((server) => server.enabled);
  const enabledCount = enabledServers.length;
  // The same count the rows show: reported tool names when the runtime has
  // them, the administrator's catalog size until then.
  const enabledToolCount = enabledServers
    .reduce((total, server) => total + (server.tools.length || server.knownToolCount), 0);
  const dirty = Object.values(edits).some((serverEdits) => Object.keys(serverEdits).length > 0);
  const needsSetupCount = servers.filter(server => mcpSetupAttention(server)).length;
  const activeFilter = filter === "setup" && !needsSetupCount ? "all" : filter;
  const normalizedQuery = query.trim().toLowerCase();
  const visibleIds = new Set(servers.filter(server =>
    (activeFilter === "all" || (activeFilter === "enabled" ? server.enabled : mcpSetupAttention(server))) &&
    (!normalizedQuery || [server.name, server.description ?? ""].some(value => value.toLowerCase().includes(normalizedQuery)))
  ).map(server => server.id));
  useBeforeUnloadGuard(dirty || busyServerIds.size > 0);

  useEffect(() => observeMcpSettings(), []);

  useEffect(() => {
    onBusyChange?.(busyServerIds.size > 0);
    return () => onBusyChange?.(false);
  }, [busyServerIds, onBusyChange]);

  function setServerBusy(serverId: string, busy: boolean) {
    setBusyServerIds((current) => {
      const next = new Set(current);
      if (busy) next.add(serverId);
      else next.delete(serverId);
      return next;
    });
  }

  function setServerEdit(serverId: string, slotKey: string, value: McpSlotValue | null | undefined) {
    const field = servers.find(server => server.id === serverId)?.fields.find(field => field.slotKey === slotKey);
    // Erasing a write-only replacement restores the untouched field. Removing
    // the saved value remains the separate, explicit null mutation.
    const nextValue = field?.sensitive && value === "" ? undefined : value;
    setEdits((current) => {
      const server = { ...(current[serverId] ?? {}) };
      if (nextValue === undefined) delete server[slotKey];
      else server[slotKey] = nextValue;
      return { ...current, [serverId]: server };
    });
  }

  return (
    <section className="v2-settings-mcp v2-studio-settings-page" aria-label="MCP servers">
      <SectionHeading
        description="Enabled servers join your private tool catalog for chats and authorized MCP Hub apps. A chat uses them in Auto or Load all mode. Policy, secrets, and the full inventory stay with the administrator."
        action={<UiV2Button busy={loadState === "loading"} disabled={loadState === "loading"} onClick={() => void refreshMcpSettings(true).catch(() => undefined)}>Refresh status</UiV2Button>}
      >MCP servers</SectionHeading>
      {servers.length ? <p className="v2-settings-note">{enabledCount} of {servers.length} server{servers.length === 1 ? "" : "s"} enabled{enabledCount && enabledToolCount ? ` · ${toolCountLabel(enabledToolCount)}` : ""}</p> : null}

      {oauthOutcome ? (
        <div
          className="v2-settings-banner"
          data-tone={oauthOutcome.kind === "connected" ? "ok" : oauthOutcome.kind === "cancelled" ? "warn" : "danger"}
          role={oauthOutcome.kind === "failed" ? "alert" : "status"}
        >
          <span>
            {oauthOutcome.kind === "connected"
              ? "External account connected and MCP enabled."
              : oauthOutcome.kind === "cancelled"
                ? "Authorization was cancelled."
                : "Authorization or automatic MCP enablement failed. Try connecting again."}
          </span>
          <UiV2Button onClick={() => setOAuthOutcome(null)}>Dismiss</UiV2Button>
        </div>
      ) : null}

      {loadState === "loading" && servers.length === 0 ? (
        <p className="v2-settings-mcp-state" role="status">
          <Spinner />
          Loading MCP servers…
        </p>
      ) : loadState === "error" && servers.length === 0 ? (
        <div className="v2-settings-mcp-state" data-tone="danger">
          <p role="alert">MCP settings could not be loaded.</p>
          <span className="v2-settings-field-note">Try again.</span>
          <UiV2Button onClick={() => void refreshMcpSettings(true).catch(() => undefined)}>Retry</UiV2Button>
        </div>
      ) : servers.length === 0 ? (
        <div className="v2-settings-mcp-state">
          <p>No MCP servers available</p>
          <span className="v2-settings-field-note">
            Ask an administrator to grant your account or group access to an installation MCP server.
          </span>
        </div>
      ) : (
        <>
        <div className="v2-settings-mcp-toolbar">
          <div aria-label="Filter MCP servers" className="v2-resource-filters" role="group">
            {(["all", "enabled", ...(needsSetupCount ? ["setup" as const] : [])] as const).map(candidate => (
              <button aria-pressed={activeFilter === candidate} className="v2-resource-filter v2-focusable"
                data-selected={activeFilter === candidate || undefined} key={candidate} type="button"
                onClick={() => setFilter(candidate)}>
                {candidate === "all" ? "All" : candidate === "enabled" ? "Enabled" : "Needs setup"}
                {" "}<span>{candidate === "all" ? servers.length : candidate === "enabled" ? enabledCount : needsSetupCount}</span>
              </button>
            ))}
          </div>
          <label className="v2-resource-search">
            <UiV2Icon name="search" />
            <input aria-label="Search MCP servers" placeholder="Search servers…" type="search" value={query}
              onChange={event => setQuery(event.currentTarget.value)} />
          </label>
        </div>
        <div className="v2-settings-server-list">
          {servers.map((server) => (
            <ServerRow
              edits={edits[server.id] ?? {}}
              enableIssue={!server.enabled && enabledCount >= MCP_RUN_PLAN_LIMITS.maxEnabledServers
                ? `You can enable at most ${MCP_RUN_PLAN_LIMITS.maxEnabledServers} MCP servers.`
                : null}
              key={server.id}
              onBusyChange={(busy) => setServerBusy(server.id, busy)}
              onEdit={(slotKey, value) => setServerEdit(server.id, slotKey, value)}
              oauthBlockedReason={dirty ? "Save or clear your personal values first" : busyServerIds.size ? "Wait for the current update to finish." : null}
              server={server}
              visible={visibleIds.has(server.id)}
            />
          ))}
        </div>
        {!visibleIds.size ? <p className="v2-settings-mcp-state" role="status">No servers match your search or filter.</p> : null}
        </>
      )}

      {error && servers.length > 0 ? (
        <p className="v2-settings-field-note" role="status">Status could not be refreshed. Try again.</p>
      ) : null}

      {/* Footnote: how a chat consumes the enabled catalog (A13). */}
      <McpHubConnection />
      <details className="v2-settings-footnote">
        <summary className="v2-focusable">How tools use data</summary>
        <div className="v2-settings-disclosure-body">
          <p>Auto starts with a small schema-free catalog and loads only matching tools when the model asks.</p>
          <p>Load all eagerly loads every enabled server for that chat; Off loads none.</p>
          <p>
            You can enable up to {MCP_RUN_PLAN_LIMITS.maxEnabledServers} servers. Enabled runtimes stay asleep
            until a chat or MCP Hub request needs them.
          </p>
        </div>
      </details>
      {onOpenDefaults ? <p className="v2-settings-note">New chats start in Auto mode: a small catalog first, matching tools on demand. <button className="v2-studio-inline-link v2-focusable" type="button" onClick={onOpenDefaults}>Change in Chat defaults</button></p> : null}
    </section>
  );
}
