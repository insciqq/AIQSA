import {
  MCP_RUN_PLAN_LIMITS,
  type McpSlotValue,
  type UserMcpConfigurationField,
  type UserMcpServer
} from "@/lib/contracts/mcp";
import { UiV2Button, UiV2Icon, UiV2Monogram } from "@/components/ui-v2";
import { useEffect, useState } from "react";
import {
  disconnectUserMcpServer,
  McpSettingsApiError,
  updateUserMcpServer,
  userMcpOAuthAction
} from "./mcpSettingsApi";
import {
  isMcpOAuthAuthorizing,
  markMcpOAuthAuthorizing,
  refreshMcpSettings,
  useMcpSettingsStore
} from "./mcpSettingsStore";
import {
  mcpReadinessPresentation,
  type McpReadinessPresentation
} from "./mcpReadiness";

/*
 * Settings › MCP & tools in the Signal row anatomy (PRD §4.9, UX audit
 * 2026-09-02 #12): one summary row, an optional "How tools use data"
 * disclosure, then one row per server — monogram · name + status ·
 * description · the lifecycle action on the right — with the external
 * account, personal configuration and tool list folded underneath. The
 * behaviour (enable/disable, OAuth, personal values, readiness) is unchanged.
 */

function readableCode(code: string): string {
  const label = code.replace(/^mcp_/u, "").replaceAll("_", " ");
  return `${label.charAt(0).toUpperCase()}${label.slice(1)} (${code})`;
}

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
  href,
  label,
  onStart,
  tone = "ghost",
  ...props
}: Readonly<{
  "aria-label"?: string;
  authorizing: boolean;
  href: string;
  label: string;
  onStart(): void;
  tone?: "ghost" | "primary";
}>) {
  return (
    <a
      aria-busy={authorizing || undefined}
      aria-disabled={authorizing || undefined}
      aria-label={props["aria-label"]}
      className="v2-button v2-focusable"
      data-tone={tone}
      href={href}
      tabIndex={authorizing ? -1 : undefined}
      onClick={(event) => {
        if (authorizing) {
          event.preventDefault();
          return;
        }
        onStart();
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
  server
}: Readonly<{
  edits: Readonly<Record<string, McpSlotValue | null>>;
  enableIssue: string | null;
  onBusyChange(busy: boolean): void;
  onEdit(slotKey: string, value: McpSlotValue | null | undefined): void;
  server: UserMcpServer;
}>) {
  const replaceServer = useMcpSettingsStore((state) => state.replaceServer);
  const [busy, setBusy] = useState<"disconnect" | "save" | "toggle" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [authorizing, setAuthorizing] = useState(() => isMcpOAuthAuthorizing(server.id));
  const hasEdits = Object.keys(edits).length > 0;
  const connected = server.oauthState === "ready" || server.oauthState === "reauthorization_required";
  const needsOAuth = server.oauthAvailable && server.oauthState !== "ready";
  const missingPersonalField = server.fields.find((field) => field.source === "missing");
  const readiness = mcpReadinessPresentation(server.readiness);
  const lifecycleActionLabel = server.enabled
    ? "Disable"
    : missingPersonalField
      ? "Complete setup"
      : "Enable";

  async function run(kind: typeof busy, operation: () => Promise<void>) {
    setBusy(kind);
    onBusyChange(true);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      setError(errorText(cause, server));
    } finally {
      setBusy(null);
      onBusyChange(false);
    }
  }

  const startAuthorization = () => {
    markMcpOAuthAuthorizing(server.id);
    setAuthorizing(true);
    setError(null);
  };

  return (
    <article
      aria-labelledby={`mcp-server-${server.id}`}
      className="v2-settings-server"
      data-enabled={server.enabled || undefined}
      data-resource-availability-row={server.enabled ? "enabled" : "disabled"}
    >
      <div className="v2-settings-server-head">
        <UiV2Monogram className="v2-settings-server-mark" label={server.name} />
        <div className="v2-settings-server-copy">
          <div className="v2-settings-server-title">
            <h4 id={`mcp-server-${server.id}`}>{server.name}</h4>
            <span
              className="v2-settings-server-availability"
              data-resource-availability={server.enabled ? "enabled" : "disabled"}
            >
              {server.enabled ? "Enabled" : "Disabled"}
            </span>
          </div>
          {server.description ? <p className="v2-settings-server-description">{server.description}</p> : null}
          {server.enabled ? (
            <p
              aria-live="polite"
              className="v2-settings-server-readiness"
              data-tone={readinessTone(readiness.kind)}
              role="status"
            >
              {readiness.kind === "ready"
                ? <UiV2Icon name="check" />
                : readiness.kind === "progress"
                  ? <Spinner />
                  : <UiV2Icon name="alert" />}
              {readiness.label}
              {server.errorCode ? ` · ${readableCode(server.errorCode)}` : ""}
            </p>
          ) : null}
        </div>
        <div className="v2-settings-server-action">
          {!server.enabled && needsOAuth && !missingPersonalField ? (
            <OAuthLink
              aria-label={`${server.oauthState === "reauthorization_required" ? "Reconnect" : "Connect"} ${server.name} to enable`}
              authorizing={authorizing}
              href={userMcpOAuthAction(server.id, server.oauthState === "reauthorization_required")}
              label={server.oauthState === "reauthorization_required" ? "Reconnect to enable" : "Connect to enable"}
              tone="primary"
              onStart={startAuthorization}
            />
          ) : (
            <UiV2Button
              aria-label={`${server.enabled ? "Disable" : missingPersonalField ? "Complete setup for" : "Enable"} ${server.name}`}
              busy={busy === "toggle"}
              disabled={busy !== null}
              tone={server.enabled ? "ghost" : "primary"}
              onClick={() => {
                if (!server.enabled && missingPersonalField) {
                  setError("Add and save the required personal values before enabling this server.");
                  document.getElementById(`mcp-field-${server.id}-${missingPersonalField.slotKey}`)?.focus();
                  return;
                }
                if (!server.enabled && enableIssue) {
                  setError(enableIssue);
                  return;
                }
                void run("toggle", async () => {
                  replaceServer(await updateUserMcpServer(server.id, { enabled: !server.enabled }));
                });
              }}
            >
              {lifecycleActionLabel}
            </UiV2Button>
          )}
        </div>
      </div>

      {server.oauthAvailable ? (
        <section className="v2-settings-server-section" aria-label={`${server.name} authorization`}>
          <div className="v2-settings-server-section-copy">
            <span className="v2-settings-server-section-title">External account</span>
            <span className="v2-settings-server-section-note">
              {authorizing ? "Authorizing in your browser…" : server.accountLabel ?? "No external account connected"}
            </span>
          </div>
          <div className="v2-settings-server-section-actions">
            {!server.enabled && needsOAuth ? null : (
              <OAuthLink
                authorizing={authorizing}
                href={userMcpOAuthAction(server.id, connected)}
                label={connected ? "Reconnect" : "Connect"}
                onStart={() => {
                  markMcpOAuthAuthorizing(server.id);
                  setAuthorizing(true);
                }}
              />
            )}
            {connected ? (
              <UiV2Button
                busy={busy === "disconnect"}
                disabled={busy !== null || authorizing}
                onClick={() => void run("disconnect", async () => {
                  await disconnectUserMcpServer(server.id);
                  await refreshMcpSettings(true);
                })}
              >
                Disconnect
              </UiV2Button>
            ) : null}
          </div>
        </section>
      ) : null}

      {server.fields.length ? (
        <section className="v2-settings-server-section v2-settings-server-fields" aria-label={`${server.name} personal configuration`}>
          <div className="v2-settings-server-section-copy">
            <span className="v2-settings-server-section-title">Personal configuration</span>
            <span className="v2-settings-server-section-note">
              You can change only the fields your administrator made personal. Server endpoints and launch settings remain installation-owned.
            </span>
            {hasEdits ? <span className="v2-settings-server-section-note" data-tone="warn">Unsaved personal values</span> : null}
          </div>
          <div className="v2-settings-field-list">
            {server.fields.map((field) => (
              <FieldEditor
                disabled={busy !== null}
                edits={edits}
                field={field}
                inputId={`mcp-field-${server.id}-${field.slotKey}`}
                key={field.slotKey}
                onChange={(value) => onEdit(field.slotKey, value)}
              />
            ))}
          </div>
          <div className="v2-settings-server-section-actions">
            <UiV2Button
              busy={busy === "save"}
              disabled={!hasEdits || busy !== null}
              tone="primary"
              onClick={() => void run("save", async () => {
                replaceServer(await updateUserMcpServer(server.id, { values: edits }));
                for (const slotKey of Object.keys(edits)) onEdit(slotKey, undefined);
              })}
            >
              Save personal values
            </UiV2Button>
          </div>
        </section>
      ) : null}

      <details className="v2-settings-disclosure">
        <summary className="v2-focusable">
          <UiV2Icon name="chevron-right" />
          {server.tools.length} available tool{server.tools.length === 1 ? "" : "s"}
        </summary>
        {server.tools.length ? (
          <ul className="v2-settings-tool-list" aria-label={`${server.name} tools`}>
            {server.tools.map((tool) => (
              <li key={tool.name}>
                <span className="v2-settings-tool-name">{tool.name}</span>
                {tool.description ? <span className="v2-settings-tool-note">{tool.description}</span> : null}
              </li>
            ))}
          </ul>
        ) : <p className="v2-settings-field-note">Tools appear after this server is ready.</p>}
      </details>

      {error ? <p className="v2-settings-error" role="alert">{error}</p> : null}
    </article>
  );
}

export function McpSettingsSection({
  onBusyChange,
  onDirtyChange
}: {
  onBusyChange?(busy: boolean): void;
  onDirtyChange?(dirty: boolean): void;
} = {}) {
  const error = useMcpSettingsStore((state) => state.error);
  const loadState = useMcpSettingsStore((state) => state.loadState);
  const oauthOutcome = useMcpSettingsStore((state) => state.oauthOutcome);
  const servers = useMcpSettingsStore((state) => state.servers);
  const setOAuthOutcome = useMcpSettingsStore((state) => state.setOAuthOutcome);
  const [edits, setEdits] = useState<ServerEdits>({});
  const [busyServerIds, setBusyServerIds] = useState<ReadonlySet<string>>(() => new Set());
  const enabledCount = servers.filter((server) => server.enabled).length;
  const enabledToolCount = servers
    .filter((server) => server.enabled)
    .reduce((total, server) => total + server.knownToolCount, 0);
  const dirty = Object.values(edits).some((serverEdits) => Object.keys(serverEdits).length > 0);

  useEffect(() => {
    void refreshMcpSettings().catch(() => undefined);
  }, []);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    onBusyChange?.(busyServerIds.size > 0);
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
    setEdits((current) => {
      const server = { ...(current[serverId] ?? {}) };
      if (value === undefined) delete server[slotKey];
      else server[slotKey] = value;
      return { ...current, [serverId]: server };
    });
  }

  return (
    <section className="v2-settings-mcp" aria-labelledby="mcp-settings-heading">
      <div className="v2-settings-mcp-summary">
        <div className="v2-settings-row-copy">
          {/* The modal header already reads "MCP & tools": the heading stays
              for the landmark name only. */}
          <h3 className="v2-sr-only" id="mcp-settings-heading">MCP &amp; tools</h3>
          <span className="v2-settings-row-title">
            {enabledCount} of {servers.length} server{servers.length === 1 ? "" : "s"} enabled
            {enabledCount ? ` · ${enabledToolCount} known tool${enabledToolCount === 1 ? "" : "s"}` : ""}
          </span>
          <span className="v2-settings-row-description">
            Enable any combination of servers your administrator granted. Enabled servers join your private tool catalog. A chat uses them only in Auto or Selected tool mode.
          </span>
        </div>
        <div className="v2-settings-row-control">
          <UiV2Button
            busy={loadState === "loading"}
            disabled={loadState === "loading"}
            icon="regenerate"
            onClick={() => void refreshMcpSettings(true).catch(() => undefined)}
          >
            Refresh status
          </UiV2Button>
        </div>
      </div>
      <details className="v2-settings-disclosure">
        <summary className="v2-focusable">
          <UiV2Icon name="chevron-right" />
          How tools use data
        </summary>
        <div className="v2-settings-disclosure-body">
          <p>Auto starts with a small schema-free catalog and loads only matching tools when the model asks.</p>
          <p>Selected eagerly loads the servers you choose for that chat; Off loads none.</p>
          <p>
            You can enable up to {MCP_RUN_PLAN_LIMITS.maxEnabledServers} servers. Enabled runtimes stay asleep
            until a run actually needs them.
          </p>
        </div>
      </details>

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
          <span className="v2-settings-field-note">{error ? readableCode(error) : "Try again."}</span>
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
              server={server}
            />
          ))}
        </div>
      )}
    </section>
  );
}
