"use client";

import { UiV2Button, UiV2Switch } from "@/components/ui-v2";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useChatRoutePath } from "./chatRoute";
import { followMcpOAuthStart, startMcpOAuth, withMcpOAuthReturn } from "./mcpSettingsApi";
import { mcpReadinessPresentation, mcpSetupAttention } from "./mcpReadiness";
import {
  createPersonalMcp,
  deletePersonalMcp,
  PersonalMcpApiError,
  personalMcpAuthorizationValue,
  personalMcpOAuthConnectAction,
  updatePersonalMcp,
  type PersonalMcpAuthMode,
  type PersonalMcpConnection
} from "./personalMcpApi";
import {
  PERSONAL_MCP_LOCAL_ADDRESS_HINT,
  presentPersonalMcpError,
  presentPersonalMcpOAuthStartError,
  type PersonalMcpErrorPresentation,
  type PersonalMcpField
} from "./personalMcpErrors";
import {
  applyPersonalMcpConnection,
  observePersonalMcpReadiness,
  refreshPersonalMcp,
  removePersonalMcpConnection,
  setPersonalMcpOAuthOutcome,
  usePersonalMcpStore
} from "./personalMcpStore";

/** Tool lists longer than this get a filter. */
const TOOL_FILTER_THRESHOLD = 12;
const NAME_MAX_LENGTH = 120;
const HEADER_NAME_MAX_LENGTH = 128;
const CREATE_FIELDS: readonly PersonalMcpField[] = ["auth", "headerName", "insecure", "name", "token", "url"];

type Draft = {
  authMode: PersonalMcpAuthMode;
  headerName: string;
  insecureAcknowledged: boolean;
  name: string;
  token: string;
  url: string;
};

const EMPTY_DRAFT: Draft = { authMode: "none", headerName: "", insecureAcknowledged: false, name: "", token: "", url: "" };

type RowNotice = Readonly<{ readd?: boolean; text: string; tone: "danger" | "ok" | "warn" }>;

/** Settings busy is reported only for create, OAuth start and delete. */
export type PersonalMcpBusyReporter = (message: string | null) => void;

function isInsecureHttp(value: string): boolean {
  return /^http:\/\//iu.test(value.trim());
}

/** An unnamed connection is called after its host. */
export function defaultPersonalMcpName(url: string): string {
  try {
    return new URL(url.trim()).hostname || "Custom MCP";
  } catch {
    return "Custom MCP";
  }
}

function errorId(field: PersonalMcpField, scope: string): string {
  return `${scope}-${field}-error`;
}

function describedBy(...ids: (string | false | null | undefined)[]): string | undefined {
  const value = ids.filter(Boolean).join(" ");
  return value || undefined;
}

function FieldError({ errors, field, scope }: Readonly<{ errors: PersonalMcpErrorPresentation | null; field: PersonalMcpField; scope: string }>) {
  const text = errors?.fields[field];
  return text ? <span className="v2-settings-field-note" data-tone="danger" id={errorId(field, scope)}>{text}</span> : null;
}

function connectionNeedsOAuth(connection: PersonalMcpConnection): boolean {
  if (connection.authMode !== "oauth" || connection.oauthState === "disconnecting") return false;
  return connection.oauthState !== "ready" || connection.readiness === "reauthorization_required" ||
    connection.runtimeErrorCode === "mcp_authorization_required";
}

/** Readiness copy for one row: progress, attention and failure only. */
function rowStatus(connection: PersonalMcpConnection): { hint: string | null; label: string; tone: "danger" | "neutral" | "warn" } | null {
  const presentation = mcpReadinessPresentation(mcpSetupAttention(connection) ?? connection.readiness, connection.runtimeErrorCode);
  if (presentation.kind !== "progress" && presentation.kind !== "attention" && presentation.kind !== "failed") return null;
  if (presentation.kind === "progress") return { hint: null, label: presentation.label, tone: "neutral" };
  if (connection.runtimeErrorCode === "mcp_authorization_required" && connection.readiness === "unavailable") {
    return connection.authMode === "static"
      ? { hint: null, label: "The server rejected the stored token.", tone: "danger" }
      : { hint: null, label: "Authorization is no longer valid. Reconnect to continue.", tone: "warn" };
  }
  return {
    hint: connection.runtimeErrorCode === "mcp_internal_address_forbidden" ? PERSONAL_MCP_LOCAL_ADDRESS_HINT : null,
    label: presentation.label,
    tone: presentation.kind === "attention" ? "warn" : "danger"
  };
}

function outcomeNotice(kind: "cancelled" | "connected" | "failed", name: string): RowNotice {
  if (kind === "connected") return { text: `${name} is connected and on.`, tone: "ok" };
  if (kind === "cancelled") return { text: "Authorization was cancelled. Use Connect to try again.", tone: "warn" };
  return { text: "Authorization failed. Use Reconnect to try again.", tone: "danger" };
}

export function PersonalMcpConnectionsSection({ onBusyChange }: Readonly<{ onBusyChange?: PersonalMcpBusyReporter }> = {}) {
  const connections = usePersonalMcpStore((state) => state.connections);
  const loadState = usePersonalMcpStore((state) => state.loadState);
  const loadError = usePersonalMcpStore((state) => state.error);
  const oauthOutcome = usePersonalMcpStore((state) => state.oauthOutcome);
  const returnPath = useChatRoutePath();
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [createErrors, setCreateErrors] = useState<PersonalMcpErrorPresentation | null>(null);
  const [confirmation, setConfirmation] = useState<readonly string[] | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [rowNotices, setRowNotices] = useState<Readonly<Record<string, RowNotice>>>({});
  const [toolFilters, setToolFilters] = useState<Readonly<Record<string, string>>>({});
  const [announcement, setAnnouncement] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const pendingRef = useRef(new Set<string>());
  const mountedRef = useRef(false);
  const headingRefs = useRef(new Map<string, HTMLHeadingElement>());
  const formHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const confirmHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const urlRef = useRef<HTMLInputElement | null>(null);
  const focusAfterRender = useRef<(() => void) | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void refreshPersonalMcp({ background: true }).catch(() => undefined); }, 0);
    const stopObserving = observePersonalMcpReadiness();
    return () => {
      window.clearTimeout(timer);
      stopObserving();
    };
  }, []);

  useEffect(() => {
    const focus = focusAfterRender.current;
    focusAfterRender.current = null;
    focus?.();
  });

  const settingsBusyMessage = pending.has("create")
    ? "Adding connection…"
    : [...pending].some((key) => key.endsWith(":oauth"))
      ? "Opening authorization…"
      : [...pending].some((key) => key.endsWith(":delete")) ? "Disconnecting…" : null;
  useEffect(() => { onBusyChange?.(settingsBusyMessage); }, [onBusyChange, settingsBusyMessage]);
  useEffect(() => () => onBusyChange?.(null), [onBusyChange]);

  const begin = useCallback((key: string): boolean => {
    if (pendingRef.current.has(key)) return false;
    pendingRef.current.add(key);
    setPending(new Set(pendingRef.current));
    return true;
  }, []);
  const end = useCallback((key: string) => {
    pendingRef.current.delete(key);
    if (mountedRef.current) setPending(new Set(pendingRef.current));
  }, []);
  const setRowNotice = (id: string, notice: RowNotice | null) => {
    setRowNotices((current) => {
      const next = { ...current };
      if (notice) next[id] = notice;
      else delete next[id];
      return next;
    });
  };
  const announce = (text: string) => setAnnouncement(text);
  const focusHeading = (id: string) => {
    focusAfterRender.current = () => headingRefs.current.get(id)?.focus();
  };

  async function refresh() {
    setRefreshing(true);
    try {
      await refreshPersonalMcp({ background: true });
    } catch {
      // The store keeps the failure code; the section renders it.
    } finally {
      if (mountedRef.current) setRefreshing(false);
    }
  }

  async function authorize(connection: PersonalMcpConnection): Promise<void> {
    const key = `${connection.id}:oauth`;
    if (!begin(key)) return;
    setRowNotice(connection.id, null);
    try {
      const location = await startMcpOAuth(withMcpOAuthReturn(personalMcpOAuthConnectAction(connection.id), returnPath));
      // Settings closed or the account changed meanwhile: never navigate later.
      if (!mountedRef.current) {
        end(key);
        return;
      }
      followMcpOAuthStart(location);
      // The document is leaving; the control stays busy until it does.
    } catch (error) {
      end(key);
      if (!mountedRef.current) return;
      const notice = presentPersonalMcpOAuthStartError(error);
      setRowNotice(connection.id, { readd: notice.readd, text: notice.text, tone: "danger" });
      focusHeading(connection.id);
    }
  }

  async function submitCreate(acknowledged?: readonly string[]) {
    if (!begin("create")) return;
    setCreateErrors(null);
    const url = draft.url.trim();
    const headerName = draft.headerName.trim() || "Authorization";
    try {
      const created = await createPersonalMcp({
        auth: draft.authMode === "static" ? { headerName, mode: "static" } : { mode: draft.authMode },
        ...(acknowledged ? { authorizationOriginsAcknowledged: [...acknowledged] } : {}),
        insecureHttpAcknowledged: isInsecureHttp(url) && draft.insecureAcknowledged,
        name: draft.name.trim() || defaultPersonalMcpName(url),
        url,
        ...(draft.authMode === "static"
          ? { values: { authorization: personalMcpAuthorizationValue(headerName, draft.token) } }
          : {})
      });
      applyPersonalMcpConnection(created);
      if (!mountedRef.current) return;
      setDraft(EMPTY_DRAFT);
      setConfirmation(null);
      if (created.authMode === "oauth" && created.oauthState !== "ready") {
        announce(`${created.name} added. Opening authorization…`);
        // Starting authorization takes over the busy state synchronously.
        void authorize(created);
        return;
      }
      announce(`${created.name} added.`);
      focusHeading(created.id);
    } catch (error) {
      if (!mountedRef.current) return;
      if (error instanceof PersonalMcpApiError && error.code === "oauth_authorization_origin_confirmation_required") {
        setConfirmation(error.authorizationOrigins);
        focusAfterRender.current = () => confirmHeadingRef.current?.focus();
        return;
      }
      setConfirmation(null);
      setCreateErrors(presentPersonalMcpError(error, {
        authMode: draft.authMode,
        fallback: "This connection could not be added. Try again.",
        fields: CREATE_FIELDS
      }));
    } finally {
      end("create");
    }
  }

  async function setEnabled(connection: PersonalMcpConnection, enabled: boolean) {
    const key = `${connection.id}:enabled`;
    if (!begin(key)) return;
    setRowNotice(connection.id, null);
    try {
      applyPersonalMcpConnection(await updatePersonalMcp(connection.id, { enabled }));
      announce(`${connection.name} turned ${enabled ? "on" : "off"}.`);
    } catch (error) {
      const code = error instanceof PersonalMcpApiError ? error.code : null;
      setRowNotice(connection.id, {
        text: code === "mcp_enabled_server_limit_reached"
          ? presentPersonalMcpError(error, { authMode: connection.authMode, fallback: "", fields: [] }).general ?? ""
          : "The connection could not be updated. Try again.",
        tone: "danger"
      });
    } finally {
      end(key);
    }
  }

  async function setToolEnabled(connection: PersonalMcpConnection, name: string, enabled: boolean) {
    const key = `${connection.id}:tool:${name}`;
    if (!begin(key)) return;
    setRowNotice(connection.id, null);
    try {
      applyPersonalMcpConnection(await updatePersonalMcp(connection.id, { tool: { enabled, name } }));
      announce(`${name} turned ${enabled ? "on" : "off"}.`);
    } catch {
      setRowNotice(connection.id, { text: "The tool could not be updated. Try again.", tone: "danger" });
    } finally {
      end(key);
    }
  }

  async function remove(connection: PersonalMcpConnection, readd = false) {
    const key = `${connection.id}:delete`;
    if (!begin(key)) return;
    setRowNotice(connection.id, null);
    const index = connections.findIndex((item) => item.id === connection.id);
    try {
      try {
        await deletePersonalMcp(connection.id);
      } catch (error) {
        if (!(error instanceof PersonalMcpApiError && error.code === "mcp_not_found")) throw error;
      }
      removePersonalMcpConnection(connection.id);
      if (oauthOutcome?.serverId === connection.id) setPersonalMcpOAuthOutcome(null);
      if (!mountedRef.current) return;
      announce(`${connection.name} disconnected.`);
      if (readd) {
        setDraft({ ...EMPTY_DRAFT, authMode: connection.authMode, name: connection.name, url: connection.endpoint ?? "" });
        setCreateErrors(null);
        setConfirmation(null);
        focusAfterRender.current = () => urlRef.current?.focus();
        return;
      }
      const remaining = connections.filter((item) => item.id !== connection.id);
      const next = remaining[Math.min(index, remaining.length - 1)];
      focusAfterRender.current = () => (next ? headingRefs.current.get(next.id) : formHeadingRef.current)?.focus();
    } catch {
      setRowNotice(connection.id, { text: "The connection could not be disconnected. Try again.", tone: "danger" });
    } finally {
      end(key);
    }
  }

  const createBusy = pending.has("create");
  const canSubmit = Boolean(draft.url.trim()) &&
    (!isInsecureHttp(draft.url) || draft.insecureAcknowledged) &&
    (draft.authMode !== "static" || Boolean(draft.token.trim()));
  const outcomeRow = oauthOutcome?.serverId ? connections.find((item) => item.id === oauthOutcome.serverId) ?? null : null;
  const scope = "personal-mcp";

  let body: ReactNode;
  if (loadState === "idle" || (loadState === "loading" && connections.length === 0)) {
    body = (
      <div className="v2-settings-mcp-state">
        <p>Loading personal connections…</p>
      </div>
    );
  } else if (loadState === "error") {
    body = (
      <div className="v2-settings-mcp-state" data-tone="danger">
        <p role="alert">{loadError === "unauthorized"
          ? "Sign in to manage personal MCP connections."
          : "Your connections could not be loaded."}</p>
        <span className="v2-settings-field-note">Nothing was changed. Try loading them again.</span>
        <UiV2Button busy={refreshing} onClick={() => void refresh()}>Retry</UiV2Button>
      </div>
    );
  } else {
    body = (
      <>
        {confirmation ? (
          <div aria-labelledby="personal-mcp-confirm-heading" className="v2-settings-personal-mcp-form" role="group">
            <div>
              <h4 id="personal-mcp-confirm-heading" ref={confirmHeadingRef} tabIndex={-1}>Confirm the sign-in site</h4>
              <p>
                {draft.name.trim() || defaultPersonalMcpName(draft.url)} sends you to another site to sign in.
                The account you use there will authorize this connection.
              </p>
            </div>
            <ul className="v2-settings-personal-mcp-origins">
              {confirmation.map((origin) => <li key={origin}><code>{origin}</code></li>)}
            </ul>
            <div className="v2-settings-personal-mcp-options">
              <UiV2Button busy={createBusy} onClick={() => void submitCreate(confirmation)} tone="primary">Continue</UiV2Button>
              <UiV2Button
                disabled={createBusy}
                onClick={() => {
                  setConfirmation(null);
                  focusAfterRender.current = () => urlRef.current?.focus();
                }}
              >
                Cancel
              </UiV2Button>
            </div>
          </div>
        ) : (
          <form
            aria-labelledby="personal-mcp-form-heading"
            className="v2-settings-personal-mcp-form"
            noValidate
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              if (canSubmit) void submitCreate();
            }}
          >
            <div>
              <h4 id="personal-mcp-form-heading" ref={formHeadingRef} tabIndex={-1}>Connect your MCP</h4>
              <p>Paste a remote MCP URL. HTTP is allowed when you explicitly acknowledge that the connection is unencrypted.</p>
            </div>
            {createErrors?.general ? (
              <p className="v2-settings-field-note" data-tone="danger" role="alert">{createErrors.general}</p>
            ) : null}
            <div className="v2-settings-personal-mcp-fields">
              <label htmlFor="personal-mcp-name">
                Name
                <input
                  aria-describedby={describedBy(createErrors?.fields.name && errorId("name", scope))}
                  aria-invalid={Boolean(createErrors?.fields.name) || undefined}
                  className="v2-settings-input"
                  id="personal-mcp-name"
                  maxLength={NAME_MAX_LENGTH}
                  onChange={(event) => {
                    const name = event.currentTarget.value;
                    setDraft((current) => ({ ...current, name }));
                  }}
                  placeholder={draft.url.trim() ? defaultPersonalMcpName(draft.url) : "My MCP"}
                  value={draft.name}
                />
                <FieldError errors={createErrors} field="name" scope={scope} />
              </label>
              <label htmlFor="personal-mcp-url">
                Server URL
                <input
                  aria-describedby={describedBy("personal-mcp-url-help", createErrors?.fields.url && errorId("url", scope))}
                  aria-invalid={Boolean(createErrors?.fields.url) || undefined}
                  className="v2-settings-input"
                  id="personal-mcp-url"
                  onChange={(event) => {
                    const url = event.currentTarget.value;
                    setDraft((current) => ({ ...current, insecureAcknowledged: isInsecureHttp(url) && current.insecureAcknowledged, url }));
                  }}
                  placeholder="https://example.com/mcp"
                  ref={urlRef}
                  required
                  type="url"
                  value={draft.url}
                />
                <FieldError errors={createErrors} field="url" scope={scope} />
                <span className="v2-settings-input-help" id="personal-mcp-url-help">
                  The server stays on its own host; AIQSA stores only your connection settings. {PERSONAL_MCP_LOCAL_ADDRESS_HINT}
                </span>
              </label>
            </div>
            <div className="v2-settings-personal-mcp-options">
              <label htmlFor="personal-mcp-auth">
                Authorization
                <select
                  aria-describedby={describedBy(createErrors?.fields.auth && errorId("auth", scope))}
                  aria-invalid={Boolean(createErrors?.fields.auth) || undefined}
                  className="v2-settings-input"
                  id="personal-mcp-auth"
                  onChange={(event) => {
                    const authMode = event.currentTarget.value as PersonalMcpAuthMode;
                    setDraft((current) => ({ ...current, authMode, ...(authMode === "static" ? {} : { headerName: "", token: "" }) }));
                  }}
                  value={draft.authMode}
                >
                  <option value="none">No authorization</option>
                  <option value="oauth">OAuth</option>
                  <option value="static">Token or API key</option>
                </select>
                <FieldError errors={createErrors} field="auth" scope={scope} />
              </label>
              {draft.authMode === "static" ? (
                <>
                  <label htmlFor="personal-mcp-token">
                    Token or API key
                    <input
                      aria-describedby={describedBy("personal-mcp-token-help", createErrors?.fields.token && errorId("token", scope))}
                      aria-invalid={Boolean(createErrors?.fields.token) || undefined}
                      autoCapitalize="none"
                      autoComplete="off"
                      autoCorrect="off"
                      className="v2-settings-input v2-settings-input-masked"
                      id="personal-mcp-token"
                      onChange={(event) => {
                        const token = event.currentTarget.value;
                        setDraft((current) => ({ ...current, token }));
                      }}
                      required
                      spellCheck={false}
                      type="text"
                      value={draft.token}
                    />
                    <FieldError errors={createErrors} field="token" scope={scope} />
                    <span className="v2-settings-input-help" id="personal-mcp-token-help">
                      A bare token is sent as “Bearer &lt;token&gt;”. Stored values are write-only.
                    </span>
                  </label>
                  <label htmlFor="personal-mcp-header">
                    Header name
                    <input
                      aria-describedby={describedBy("personal-mcp-header-help", createErrors?.fields.headerName && errorId("headerName", scope))}
                      aria-invalid={Boolean(createErrors?.fields.headerName) || undefined}
                      autoCapitalize="none"
                      autoComplete="off"
                      autoCorrect="off"
                      className="v2-settings-input"
                      id="personal-mcp-header"
                      maxLength={HEADER_NAME_MAX_LENGTH}
                      onChange={(event) => {
                        const headerName = event.currentTarget.value;
                        setDraft((current) => ({ ...current, headerName }));
                      }}
                      placeholder="Authorization"
                      spellCheck={false}
                      value={draft.headerName}
                    />
                    <FieldError errors={createErrors} field="headerName" scope={scope} />
                    <span className="v2-settings-input-help" id="personal-mcp-header-help">
                      Change it only if the server asks for another header, such as X-API-Key.
                    </span>
                  </label>
                </>
              ) : null}
              {isInsecureHttp(draft.url) ? (
                <label className="v2-settings-http-warning" htmlFor="personal-mcp-http-warning">
                  <input
                    aria-describedby={describedBy(createErrors?.fields.insecure && errorId("insecure", scope))}
                    checked={draft.insecureAcknowledged}
                    id="personal-mcp-http-warning"
                    onChange={(event) => {
                      const insecureAcknowledged = event.currentTarget.checked;
                      setDraft((current) => ({ ...current, insecureAcknowledged }));
                    }}
                    type="checkbox"
                  />
                  <span>I understand this connection is unencrypted.</span>
                  <FieldError errors={createErrors} field="insecure" scope={scope} />
                </label>
              ) : null}
              <UiV2Button busy={createBusy} disabled={!canSubmit} type="submit" tone="primary">
                Add MCP
              </UiV2Button>
            </div>
          </form>
        )}

        {oauthOutcome && !outcomeRow ? (
          <div
            className="v2-settings-banner"
            data-tone={oauthOutcome.kind === "connected" ? "ok" : oauthOutcome.kind === "cancelled" ? "warn" : "danger"}
            role={oauthOutcome.kind === "failed" ? "alert" : "status"}
          >
            <span>{outcomeNotice(oauthOutcome.kind, "The connection").text}</span>
            <UiV2Button onClick={() => setPersonalMcpOAuthOutcome(null)}>Dismiss</UiV2Button>
          </div>
        ) : null}

        {loadError && loadState === "ready" ? (
          <p className="v2-settings-field-note" data-tone="warn" role="status">
            The latest status could not be loaded. Showing the last known state.
          </p>
        ) : null}

        {connections.length ? (
          <section aria-labelledby="personal-mcp-list-heading" className="v2-settings-server-list">
            <div className="v2-settings-server-list-heading">
              <h4 id="personal-mcp-list-heading">Your MCP connections</h4>
              <p>Turned-on connections are available in MCP Auto. Every tool is on unless you switch it off.</p>
            </div>
            <ul aria-label="Your MCP connections" className="v2-settings-personal-mcp-list">
              {connections.map((connection) => (
                <li key={connection.id}>
                  <ConnectionRow
                    connection={connection}
                    filter={toolFilters[connection.id] ?? ""}
                    headingRef={(node) => {
                      if (node) headingRefs.current.set(connection.id, node);
                      else headingRefs.current.delete(connection.id);
                    }}
                    notice={rowNotices[connection.id] ?? (outcomeRow?.id === connection.id && oauthOutcome
                      ? outcomeNotice(oauthOutcome.kind, connection.name)
                      : null)}
                    onAuthorize={() => void authorize(connection)}
                    onDismissNotice={() => {
                      setRowNotice(connection.id, null);
                      if (oauthOutcome?.serverId === connection.id) setPersonalMcpOAuthOutcome(null);
                    }}
                    onFilterChange={(value) => setToolFilters((current) => ({ ...current, [connection.id]: value }))}
                    onReadd={() => void remove(connection, true)}
                    onRemove={() => void remove(connection)}
                    onToggle={(enabled) => void setEnabled(connection, enabled)}
                    onToggleTool={(name, enabled) => void setToolEnabled(connection, name, enabled)}
                    pending={pending}
                  />
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <div className="v2-settings-mcp-state" data-tone="neutral">
            <p>No personal connections yet.</p>
            <span>Add any remote MCP server by URL above.</span>
          </div>
        )}
      </>
    );
  }

  return (
    <section
      aria-labelledby="personal-mcp-heading"
      className="v2-settings-mcp v2-studio-settings-page"
    >
      <div className="v2-settings-section-heading">
        <div>
          <h3 className="v2-settings-section-title" id="personal-mcp-heading">Personal connections</h3>
          <p className="v2-settings-section-description">
            Connect services for your chats. Turned-on connections are available automatically in MCP Auto.
          </p>
        </div>
        {loadState === "ready" ? (
          <UiV2Button busy={refreshing} onClick={() => void refresh()}>Refresh</UiV2Button>
        ) : null}
      </div>
      <p aria-live="polite" className="sr-only" role="status">{announcement}</p>
      {body}
    </section>
  );
}

function ConnectionRow({
  connection,
  filter,
  headingRef,
  notice,
  onAuthorize,
  onDismissNotice,
  onFilterChange,
  onReadd,
  onRemove,
  onToggle,
  onToggleTool,
  pending
}: Readonly<{
  connection: PersonalMcpConnection;
  filter: string;
  headingRef(node: HTMLHeadingElement | null): void;
  notice: RowNotice | null;
  onAuthorize(): void;
  onDismissNotice(): void;
  onFilterChange(value: string): void;
  onReadd(): void;
  onRemove(): void;
  onToggle(enabled: boolean): void;
  onToggleTool(name: string, enabled: boolean): void;
  pending: ReadonlySet<string>;
}>) {
  const id = connection.id;
  const deleting = pending.has(`${id}:delete`);
  const authorizing = pending.has(`${id}:oauth`);
  const toggling = pending.has(`${id}:enabled`);
  const status = rowStatus(connection);
  const disabledTools = new Set(connection.userDisabledToolNames);
  const tools = connection.availableTools;
  const onCount = tools.filter((tool) => !disabledTools.has(tool.name)).length;
  const query = filter.trim().toLocaleLowerCase();
  const visibleTools = query
    ? tools.filter((tool) => tool.name.toLocaleLowerCase().includes(query) || tool.description?.toLocaleLowerCase().includes(query))
    : tools;
  const headingId = `personal-mcp-${id}-heading`;
  const oauthLabel = connection.oauthState === "disconnected" || connection.oauthState === null ? "Connect" : "Reconnect";

  return (
    <article aria-labelledby={headingId} className="v2-settings-server-row" data-busy={deleting || undefined}>
      <div className="min-w-0 flex-1">
        <div className="v2-settings-server-row-title">
          <h5 id={headingId} ref={headingRef} tabIndex={-1}>{connection.name}</h5>
        </div>
        <p className="break-all text-xs text-ink-muted">{connection.endpoint ?? "Remote MCP"}</p>
        {tools.length ? <p className="v2-settings-field-note">{onCount} of {tools.length} tools on</p> : null}
        <div className="v2-settings-personal-mcp-status" role="status">
          {status ? (
            <p className="v2-settings-field-note" data-tone={status.tone}>
              {status.tone === "neutral" ? <span aria-hidden="true" className="v2-spinner" /> : null}
              <span>{status.label}</span>
            </p>
          ) : null}
          {status?.hint ? <p className="v2-settings-field-note">{status.hint}</p> : null}
        </div>
        {notice ? (
          <div className="v2-settings-personal-mcp-notice" role={notice.tone === "danger" ? "alert" : "status"}>
            <p className="v2-settings-field-note" data-tone={notice.tone}>{notice.text}</p>
            <div className="v2-settings-personal-mcp-options">
              {notice.readd ? (
                <UiV2Button busy={deleting} onClick={onReadd} tone="destructive">Disconnect and add again</UiV2Button>
              ) : null}
              <UiV2Button disabled={deleting} onClick={onDismissNotice}>Dismiss</UiV2Button>
            </div>
          </div>
        ) : null}
        {tools.length ? (
          <fieldset className="v2-settings-tool-selection">
            <legend>Tools available in MCP Auto</legend>
            {tools.length > TOOL_FILTER_THRESHOLD ? (
              <input
                aria-label={`Filter tools of ${connection.name}`}
                autoComplete="off"
                className="v2-settings-input v2-settings-tool-filter"
                onChange={(event) => onFilterChange(event.currentTarget.value)}
                placeholder="Filter tools"
                type="search"
                value={filter}
              />
            ) : null}
            <div className="v2-settings-tool-grid">
              {visibleTools.map((tool) => {
                const busy = pending.has(`${id}:tool:${tool.name}`);
                return (
                  <label className="v2-settings-tool-option" data-busy={busy || undefined} key={tool.name}>
                    <input
                      aria-busy={busy || undefined}
                      aria-disabled={busy || undefined}
                      checked={!disabledTools.has(tool.name)}
                      onChange={(event) => {
                        if (!busy) onToggleTool(tool.name, event.currentTarget.checked);
                      }}
                      type="checkbox"
                    />
                    <span>
                      <span className="v2-settings-tool-name">{tool.name}</span>
                      {tool.description ? <span className="v2-settings-tool-description">{tool.description}</span> : null}
                    </span>
                    {busy ? <span aria-hidden="true" className="v2-spinner" /> : null}
                  </label>
                );
              })}
            </div>
            {visibleTools.length === 0 ? <p className="v2-settings-field-note">No tools match “{filter.trim()}”.</p> : null}
          </fieldset>
        ) : connection.readiness === "ready" ? (
          <p className="v2-settings-field-note">No tools reported yet. Refresh after the server is authorized.</p>
        ) : null}
      </div>
      <div className="v2-settings-server-row-actions">
        <UiV2Switch
          aria-busy={toggling || undefined}
          aria-disabled={toggling || deleting || undefined}
          checked={connection.enabled}
          label={`Use ${connection.name}`}
          onChange={(next) => {
            if (!toggling && !deleting) onToggle(next);
          }}
        />
        {connectionNeedsOAuth(connection) ? (
          <UiV2Button
            aria-label={`${oauthLabel} ${connection.name}`}
            busy={authorizing}
            disabled={deleting}
            icon="lock"
            onClick={onAuthorize}
            tone={connection.enabled ? "primary" : "ghost"}
          >
            {oauthLabel}
          </UiV2Button>
        ) : null}
        <UiV2Button
          aria-label={`Disconnect ${connection.name}`}
          busy={deleting}
          disabled={authorizing}
          onClick={onRemove}
          tone="destructive"
        >
          Disconnect
        </UiV2Button>
      </div>
    </article>
  );
}
