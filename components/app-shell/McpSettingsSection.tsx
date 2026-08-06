import {
  MCP_RUN_PLAN_LIMITS,
  type McpSlotValue,
  type UserMcpConfigurationField,
  type UserMcpServer
} from "@/lib/contracts/mcp";
import {
  AvailabilityStatus,
  availabilityRowClass,
  enableActionTone
} from "@/components/resource-lifecycle/AvailabilityStatus";
import {
  CircleAlert,
  CircleCheck,
  KeyRound,
  LoaderCircle,
  Plug,
  RefreshCw,
  Save,
  Unplug,
  Wrench
} from "lucide-react";
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

const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-overlay-surface";
const touchTarget = "[@media(hover:none)]:!min-h-touch [@media(pointer:coarse)]:!min-h-touch";
const actionButtonBase = `inline-flex min-h-touch items-center justify-center gap-2 rounded-control px-3 text-sm font-medium disabled:cursor-not-allowed disabled:text-ink-disabled disabled:opacity-60 sm:min-h-control ${touchTarget} ${focusRing}`;
const neutralButton = `${actionButtonBase} bg-control-surface text-ink-secondary hover:bg-control-hover hover:text-ink`;
const enableButton = `${actionButtonBase} ${enableActionTone}`;

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

function readinessTone(kind: McpReadinessPresentation["kind"]): string {
  if (kind === "ready") return "text-positive";
  if (kind === "failed") return "text-critical";
  if (kind === "attention") return "text-caution";
  return "text-ink-secondary";
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
  const inputClass = `min-h-touch w-full rounded-control border border-control-boundary bg-answer-paper px-3 text-sm text-ink placeholder:text-ink-muted aria-[invalid=true]:border-critical disabled:cursor-not-allowed disabled:border-trace-subtle disabled:text-ink-disabled sm:min-h-control ${touchTarget} ${focusRing}`;

  return (
    <div className="min-w-0 border-l border-trace-subtle pl-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <label className="min-w-0 flex-1 text-sm font-medium text-ink" htmlFor={inputId}>
          {field.label}
        </label>
        <span className="text-xs text-ink-muted">{status}</span>
      </div>
      {field.description ? <p className="mt-1 text-xs leading-5 text-ink-muted">{field.description}</p> : null}
      <div className="mt-2 flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
        {field.valueType === "boolean" ? (
          <button
            aria-pressed={value === true}
            className={`${neutralButton} justify-between sm:min-w-36`}
            disabled={disabled}
            id={inputId}
            onClick={() => onChange(value !== true)}
            type="button"
          >
            Personal override
            <span className={value === true ? "text-proof" : "text-ink-muted"}>
              {value === true ? "On" : "Off"}
            </span>
          </button>
        ) : field.valueType === "enum" && field.enumValues?.length ? (
          <select
            className={inputClass}
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
            className={inputClass}
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
        <button
          className={`${neutralButton} shrink-0`}
          disabled={disabled || (!field.configured && !Object.hasOwn(edits, field.slotKey))}
          onClick={() => onChange(null)}
          type="button"
        >
          Clear personal value
        </button>
      </div>
      {field.sensitive ? (
        <p className="mt-2 flex items-start gap-1.5 text-xs leading-5 text-ink-muted">
          <KeyRound className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          Stored values are write-only and are never shown again.
        </p>
      ) : null}
    </div>
  );
}

function ServerCard({
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

  return (
    <article
      aria-labelledby={`mcp-server-${server.id}`}
      className={`border-t border-trace-subtle px-3 py-5 first:border-t-0 ${availabilityRowClass(server.enabled)}`}
      data-resource-availability-row={server.enabled ? "enabled" : "disabled"}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="break-words text-sm font-semibold text-ink" id={`mcp-server-${server.id}`}>
              {server.name}
            </h4>
            <AvailabilityStatus enabled={server.enabled} />
          </div>
          {server.description ? <p className="mt-1 max-w-3xl text-sm leading-6 text-ink-secondary">{server.description}</p> : null}
          {server.enabled ? (
            <p
              aria-live="polite"
              className={`mt-2 flex items-center gap-1.5 text-xs font-medium ${readinessTone(readiness.kind)}`}
              role="status"
            >
              {readiness.kind === "ready"
                ? <CircleCheck className="size-3.5" aria-hidden="true" />
                : readiness.kind === "progress"
                  ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
                  : <CircleAlert className="size-3.5" aria-hidden="true" />}
              {readiness.label}
              {server.errorCode ? ` · ${readableCode(server.errorCode)}` : ""}
            </p>
          ) : null}
        </div>
        {!server.enabled && needsOAuth && !missingPersonalField ? (
          <a
            aria-disabled={authorizing || undefined}
            aria-label={`${server.oauthState === "reauthorization_required" ? "Reconnect" : "Connect"} ${server.name} to enable`}
            aria-busy={authorizing || undefined}
            className={`${enableButton} shrink-0 ${authorizing ? "pointer-events-none opacity-60" : ""}`}
            href={userMcpOAuthAction(server.id, server.oauthState === "reauthorization_required")}
            onClick={(event) => {
              if (authorizing) {
                event.preventDefault();
                return;
              }
              markMcpOAuthAuthorizing(server.id);
              setAuthorizing(true);
              setError(null);
            }}
            tabIndex={authorizing ? -1 : undefined}
          >
            {authorizing ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <KeyRound className="size-4" aria-hidden="true" />}
            {authorizing
              ? "Authorizing"
              : server.oauthState === "reauthorization_required" ? "Reconnect to enable" : "Connect to enable"}
          </a>
        ) : (
          <button
            aria-busy={busy === "toggle" || undefined}
            aria-label={`${server.enabled ? "Disable" : missingPersonalField ? "Complete setup for" : "Enable"} ${server.name}`}
            className={`${server.enabled ? neutralButton : enableButton} shrink-0`}
            disabled={busy !== null}
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
            type="button"
          >
            {busy === "toggle"
              ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              : server.enabled
                ? <Unplug className="size-4" aria-hidden="true" />
                : <Plug className="size-4" aria-hidden="true" />}
            {lifecycleActionLabel}
          </button>
        )}
      </div>

      {server.oauthAvailable ? (
        <section className="mt-4 border-t border-trace-subtle pt-4" aria-label={`${server.name} authorization`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-ink">External account</p>
              <p className="mt-1 break-words text-xs text-ink-muted">
                {authorizing ? "Authorizing in your browser…" : server.accountLabel ?? "No external account connected"}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {!server.enabled && needsOAuth ? null : (
                <a
                  aria-disabled={authorizing || undefined}
                  aria-busy={authorizing || undefined}
                  className={`${neutralButton} ${authorizing ? "pointer-events-none opacity-60" : ""}`}
                  href={userMcpOAuthAction(server.id, connected)}
                  onClick={(event) => {
                    if (authorizing) {
                      event.preventDefault();
                      return;
                    }
                    markMcpOAuthAuthorizing(server.id);
                    setAuthorizing(true);
                  }}
                  tabIndex={authorizing ? -1 : undefined}
                >
                  {authorizing ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <KeyRound className="size-4" aria-hidden="true" />}
                  {authorizing ? "Authorizing" : connected ? "Reconnect" : "Connect"}
                </a>
              )}
              {connected ? (
                <button
                  className={neutralButton}
                  disabled={busy !== null || authorizing}
                  onClick={() => void run("disconnect", async () => {
                    await disconnectUserMcpServer(server.id);
                    await refreshMcpSettings(true);
                  })}
                  type="button"
                >
                  {busy === "disconnect" ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <Unplug className="size-4" aria-hidden="true" />}
                  Disconnect
                </button>
              ) : null}
            </div>
          </div>
        </section>
      ) : null}

      {server.fields.length ? (
        <section className="mt-4 border-t border-trace-subtle pt-4" aria-label={`${server.name} personal configuration`}>
          <div className="mb-3">
            <h5 className="text-sm font-medium text-ink">Personal configuration</h5>
            <p className="mt-1 text-xs leading-5 text-ink-muted">
              You can change only the fields your administrator made personal. Server endpoints and launch settings remain installation-owned.
            </p>
            {hasEdits ? <p className="mt-1 text-xs font-medium text-caution">Unsaved personal values</p> : null}
          </div>
          <div className="space-y-2">
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
          <button
            className={`${neutralButton} mt-3 bg-proof text-proof-contrast hover:bg-proof-hover hover:text-proof-contrast`}
            disabled={!hasEdits || busy !== null}
            onClick={() => void run("save", async () => {
              replaceServer(await updateUserMcpServer(server.id, { values: edits }));
              for (const slotKey of Object.keys(edits)) onEdit(slotKey, undefined);
            })}
            type="button"
          >
            {busy === "save" ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <Save className="size-4" aria-hidden="true" />}
            Save personal values
          </button>
        </section>
      ) : null}

      <details className="mt-4 border-t border-trace-subtle pt-4">
        <summary className={`flex min-h-touch cursor-pointer list-none items-center gap-2 rounded-control px-2 text-sm font-medium text-ink-secondary hover:bg-control-hover hover:text-ink sm:min-h-control ${touchTarget} ${focusRing}`}>
          <Wrench className="size-4" aria-hidden="true" />
          {server.tools.length} available tool{server.tools.length === 1 ? "" : "s"}
        </summary>
        {server.tools.length ? (
          <ul className="mt-2 space-y-1 pl-2" aria-label={`${server.name} tools`}>
            {server.tools.map((tool) => (
              <li className="px-2 py-2 text-sm text-ink-secondary" key={tool.name}>
                <span className="break-words font-medium text-ink [overflow-wrap:anywhere]">{tool.name}</span>
                {tool.description ? <span className="mt-1 block break-words text-xs leading-5 text-ink-muted">{tool.description}</span> : null}
              </li>
            ))}
          </ul>
        ) : <p className="mt-2 px-2 text-xs text-ink-muted">Tools appear after this server is ready.</p>}
      </details>

      {error ? <p className="mt-3 break-words text-sm text-critical" role="alert">{error}</p> : null}
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
  const disabledCount = servers.length - enabledCount;
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
    <section className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:px-6" aria-labelledby="mcp-settings-heading">
      <div className="mx-auto max-w-3xl">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-ink" id="mcp-settings-heading">MCP &amp; tools</h3>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-ink-secondary">
              Enable any combination of servers your administrator granted.
            </p>
            <p className="mt-1 text-xs leading-5 text-ink-muted">
              {enabledCount} enabled · {disabledCount} disabled · {enabledToolCount} known tool{enabledToolCount === 1 ? "" : "s"}
            </p>
            <p className="mt-3 flex max-w-3xl items-start gap-2 border-l-2 border-caution/45 bg-caution/[0.05] px-3 py-2 text-xs leading-5 text-ink-secondary">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-caution" aria-hidden="true" />
              <span>
                The model may pass conversation-derived data to an enabled tool. Review the servers before enabling
                them.
              </span>
            </p>
            <details className="mt-2 max-w-3xl border-y border-trace-subtle">
              <summary className={`flex min-h-touch cursor-pointer list-none items-center gap-2 rounded-control px-3 text-xs font-medium text-ink-secondary hover:bg-control-hover hover:text-ink sm:min-h-control ${touchTarget} ${focusRing}`}>
                <Wrench className="size-3.5 shrink-0" aria-hidden="true" />
                How tools use data
              </summary>
              <div className="space-y-2 border-t border-trace-subtle px-3 py-3 text-xs leading-5 text-ink-muted">
                <p>Every ready tool is automatically available to your chats.</p>
                <p>One tool’s output may influence a later call to another enabled server.</p>
                <p>
                  Up to {MCP_RUN_PLAN_LIMITS.maxEnabledServers} servers and {MCP_RUN_PLAN_LIMITS.maxTools} discovered
                  tools can enter one run; exact schema and context fit is checked again before the model starts.
                </p>
              </div>
            </details>
          </div>
          <button className={neutralButton} disabled={loadState === "loading"} onClick={() => void refreshMcpSettings(true).catch(() => undefined)} type="button">
            <RefreshCw className={`size-4 ${loadState === "loading" ? "animate-spin" : ""}`} aria-hidden="true" />
            Refresh status
          </button>
        </div>

        {oauthOutcome ? (
          <div className={`mt-4 border-l-2 px-3 py-2 text-sm ${oauthOutcome.kind === "connected" ? "border-positive/45 bg-positive/[0.05] text-positive" : oauthOutcome.kind === "cancelled" ? "border-caution/45 bg-caution/[0.05] text-caution" : "border-critical/45 bg-critical/[0.05] text-critical"}`} role={oauthOutcome.kind === "failed" ? "alert" : "status"}>
            <div className="flex items-start justify-between gap-3">
              <span>{oauthOutcome.kind === "connected" ? "External account connected and MCP enabled." : oauthOutcome.kind === "cancelled" ? "Authorization was cancelled." : "Authorization or automatic MCP enablement failed. Try connecting again."}</span>
              <button className={`shrink-0 rounded-control px-2 text-xs ${focusRing}`} onClick={() => setOAuthOutcome(null)} type="button">Dismiss</button>
            </div>
          </div>
        ) : null}

        {enabledToolCount > MCP_RUN_PLAN_LIMITS.maxTools ? (
          <p className="mt-4 border-l-2 border-critical/45 bg-critical/[0.05] px-3 py-2 text-sm text-critical" role="alert">
            Your enabled MCPs have {enabledToolCount} known tools, above the {MCP_RUN_PLAN_LIMITS.maxTools}-tool run limit. Disable at least one server before sending a run.
          </p>
        ) : null}

        {loadState === "loading" && servers.length === 0 ? (
          <div className="grid min-h-48 place-items-center" role="status">
            <p className="flex items-center gap-2 text-sm text-ink-secondary"><LoaderCircle className="size-4 animate-spin text-proof" aria-hidden="true" />Loading MCP servers…</p>
          </div>
        ) : loadState === "error" && servers.length === 0 ? (
          <div className="mt-6 border-y border-critical/35 px-4 py-5 text-center">
            <p className="text-sm font-medium text-critical" role="alert">MCP settings could not be loaded.</p>
            <p className="mt-1 text-xs text-ink-muted">{error ? readableCode(error) : "Try again."}</p>
            <button className={`${neutralButton} mt-3`} onClick={() => void refreshMcpSettings(true).catch(() => undefined)} type="button">Retry</button>
          </div>
        ) : servers.length === 0 ? (
          <div className="mt-6 border-y border-trace-subtle px-4 py-6 text-center">
            <p className="text-sm font-medium text-ink">No MCP servers available</p>
            <p className="mt-1 text-xs leading-5 text-ink-muted">Ask an administrator to grant your account or group access to an installation MCP server.</p>
          </div>
        ) : (
          <div className="mt-5 border-b border-trace-subtle">
            {servers.map((server) => (
              <ServerCard
                edits={edits[server.id] ?? {}}
                enableIssue={!server.enabled && enabledCount >= MCP_RUN_PLAN_LIMITS.maxEnabledServers
                  ? `You can enable at most ${MCP_RUN_PLAN_LIMITS.maxEnabledServers} MCP servers.`
                  : !server.enabled && server.knownToolCount > 0 &&
                      enabledToolCount + server.knownToolCount > MCP_RUN_PLAN_LIMITS.maxTools
                    ? `This would expose ${enabledToolCount + server.knownToolCount} known tools, above the ${MCP_RUN_PLAN_LIMITS.maxTools}-tool run limit.`
                  : null}
                key={server.id}
                onBusyChange={(busy) => setServerBusy(server.id, busy)}
                onEdit={(slotKey, value) => setServerEdit(server.id, slotKey, value)}
                server={server}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
