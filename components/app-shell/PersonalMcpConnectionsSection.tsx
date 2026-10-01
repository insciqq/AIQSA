"use client";

import { UiV2Button, UiV2Monogram, UiV2Switch } from "@/components/ui-v2";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { ConnectorCatalogEntry } from "@/lib/contracts/connectors";
import type { UserMcpServer } from "@/lib/contracts/mcp";
import { followMcpOAuthStart, startMcpOAuth } from "./mcpSettingsApi";
import {
  connectConnector,
  createPersonalMcp,
  deletePersonalMcp,
  disconnectConnector,
  loadConnectorCatalog,
  loadPersonalMcpConnections,
  PersonalMcpApiError,
  updatePersonalMcp
} from "./personalMcpApi";

function endpoint(value: UserMcpServer): string {
  return value.endpoint ?? "Remote MCP";
}

function isInsecureHttp(value: string): boolean {
  return /^http:\/\//iu.test(value.trim());
}

function providerStatus(value: ConnectorCatalogEntry): string {
  if (value.status === "unavailable") return "Needs setup";
  return value.status === "preview" ? "Preview" : "Available";
}

function connectorAuthAction(connection: UserMcpServer | undefined): "Connect" | "Reconnect" | null {
  if (!connection?.oauthAvailable || connection.oauthState === "ready") return null;
  return connection.oauthState === "reauthorization_required" ? "Reconnect" : "Connect";
}

function toolIsSelected(connection: UserMcpServer, name: string): boolean {
  return connection.selectedToolNames === undefined || connection.selectedToolNames.includes(name);
}

export function PersonalMcpConnectionsSection() {
  const [connectors, setConnectors] = useState<ConnectorCatalogEntry[]>([]);
  const [connections, setConnections] = useState<UserMcpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [authMode, setAuthMode] = useState<"none" | "oauth" | "static">("none");
  const [token, setToken] = useState("");
  const [insecureAcknowledged, setInsecureAcknowledged] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [nextConnections, nextConnectors] = await Promise.all([
        loadPersonalMcpConnections(),
        loadConnectorCatalog()
      ]);
      setConnections(nextConnections);
      setConnectors(nextConnectors);
    } catch (cause) {
      setError(cause instanceof PersonalMcpApiError && cause.status === 401
        ? "Sign in to manage personal MCP connections."
        : "MCP connections could not be loaded. Try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh(); }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  const connectorConnections = useMemo(
    () => new Map(connections.flatMap((connection) => connection.connectorKey
      ? [[connection.connectorKey, connection] as const]
      : [])),
    [connections]
  );

  async function startOAuth(action: string, key: string) {
    setBusy(key);
    setError(null);
    try {
      const location = await startMcpOAuth(action);
      followMcpOAuthStart(location);
    } catch {
      setError("Authorization could not be started. Try again.");
      setBusy(null);
    }
  }

  async function connect(id: string) {
    setBusy(id);
    setError(null);
    try {
      const result = await connectConnector(id);
      setConnections((current) => [
        result.server,
        ...current.filter((connection) => connection.id !== result.server.id)
      ]);
      await startOAuth(result.oauthAction, id);
    } catch {
      setError("This connector could not be connected. Check its provider setup and try again.");
      setBusy(null);
    }
  }

  async function addCustom(event: FormEvent) {
    event.preventDefault();
    setBusy("custom");
    setError(null);
    try {
      const result = await createPersonalMcp({
        auth: { mode: authMode },
        ...(authMode === "static" ? { values: { authorization: token } } : {}),
        insecureHttpAcknowledged: insecureAcknowledged,
        name: name.trim() || "Custom MCP",
        url: url.trim()
      });
      setConnections((current) => [result.server, ...current]);
      setName("");
      setUrl("");
      setToken("");
      setInsecureAcknowledged(false);
      if (authMode === "oauth") {
        await startOAuth(`/api/me/mcp-connections/${encodeURIComponent(result.server.id)}/oauth/connect`, "custom");
      } else {
        setBusy(null);
      }
    } catch (cause) {
      setError(cause instanceof PersonalMcpApiError && cause.message === "insecure_http_acknowledgement_required"
        ? "Confirm the insecure HTTP warning before connecting this URL."
        : "This MCP server could not be connected. Check the URL and authorization details.");
      setBusy(null);
    }
  }

  async function toggle(connection: UserMcpServer, enabled: boolean) {
    setBusy(connection.id);
    setError(null);
    try {
      const updated = await updatePersonalMcp(connection.id, { enabled });
      setConnections((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch {
      setError("The connection could not be updated. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function toggleTool(connection: UserMcpServer, nameValue: string, enabled: boolean) {
    setBusy(`${connection.id}:${nameValue}`);
    setError(null);
    try {
      const updated = await updatePersonalMcp(connection.id, { tool: { enabled, name: nameValue } });
      setConnections((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch {
      setError("The tool selection could not be updated. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function remove(connection: UserMcpServer) {
    setBusy(connection.id);
    setError(null);
    try {
      await deletePersonalMcp(connection.id);
      setConnections((current) => current.filter((item) => item.id !== connection.id));
    } catch {
      setError("The connection could not be disconnected. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function disconnect(id: string) {
    setBusy(id);
    setError(null);
    try {
      await disconnectConnector(id);
      setConnections((current) => current.filter((item) => item.connectorKey !== id));
    } catch {
      setError("The connector could not be disconnected. Try again.");
    } finally {
      setBusy(null);
    }
  }

  const canSubmitCustom = Boolean(url.trim()) &&
    (!isInsecureHttp(url) || insecureAcknowledged) &&
    (authMode !== "static" || Boolean(token));

  return (
    <section
      aria-busy={loading || busy !== null}
      aria-label="Personal MCP connections"
      className="v2-settings-mcp v2-studio-settings-page"
    >
      <div className="v2-settings-section-heading">
        <div>
          <h2 className="v2-settings-section-title">Personal connections</h2>
          <p className="v2-settings-section-description">
            Connect services for your chats. Enabled connections are available automatically in MCP Auto.
          </p>
        </div>
        <UiV2Button disabled={busy !== null || loading} onClick={() => void refresh()}>Refresh</UiV2Button>
      </div>

      {error ? <p className="v2-settings-field-note" data-tone="danger" role="alert">{error}</p> : null}

      {loading ? (
        <div className="v2-settings-mcp-state" role="status">
          <p>Loading personal connections…</p>
        </div>
      ) : (
        <>
          <div className="v2-settings-connector-grid" aria-label="Connectors">
            {connectors.map((connector) => {
              const connection = connectorConnections.get(connector.id);
              const authAction = connectorAuthAction(connection);
              const unavailable = connector.status === "unavailable";
              return (
                <article className="v2-settings-connector-card" key={connector.id}>
                  <div className="v2-settings-connector-card-head">
                    <UiV2Monogram label={connector.label} />
                    <div className="min-w-0">
                      <div className="v2-settings-connector-card-title">
                        <h3>{connector.label}</h3>
                        <span className="v2-settings-connector-status" data-tone={connector.status}>
                          {providerStatus(connector)}
                        </span>
                      </div>
                      <p>{connector.description}</p>
                      {unavailable ? <p className="v2-settings-connector-note">This connector is waiting for administrator OAuth setup.</p> : null}
                    </div>
                  </div>
                  {connection ? (
                    <div className="v2-settings-connector-card-actions">
                      {authAction ? (
                        <UiV2Button
                          busy={busy === connector.id}
                          disabled={busy !== null}
                          onClick={() => void startOAuth(`/api/me/connectors/oauth/connect?server=${encodeURIComponent(connection.id)}`, connector.id)}
                          tone="primary"
                        >
                          {authAction}
                        </UiV2Button>
                      ) : (
                        <UiV2Switch
                          checked={connection.enabled}
                          disabled={busy !== null}
                          label={`${connection.enabled ? "Disable" : "Enable"} ${connector.label}`}
                          onChange={(next) => void toggle(connection, next)}
                        />
                      )}
                      {connection.accountLabel ? <span className="v2-settings-connector-account">{connection.accountLabel}</span> : null}
                      <UiV2Button
                        disabled={busy !== null}
                        onClick={() => void disconnect(connector.id)}
                        tone="destructive"
                      >
                        Disconnect
                      </UiV2Button>
                    </div>
                  ) : (
                    <UiV2Button
                      busy={busy === connector.id}
                      disabled={busy !== null || unavailable}
                      onClick={() => void connect(connector.id)}
                      tone="primary"
                    >
                      {unavailable ? "Unavailable" : "Connect"}
                    </UiV2Button>
                  )}
                </article>
              );
            })}
          </div>

          <form className="v2-settings-personal-mcp-form" onSubmit={(event) => void addCustom(event)}>
            <div>
              <h3>Connect your MCP</h3>
              <p>Paste a remote MCP URL. HTTP is allowed when you explicitly acknowledge that the connection is unencrypted.</p>
            </div>
            <div className="v2-settings-personal-mcp-fields">
              <label htmlFor="personal-mcp-name">
                Name
                <input
                  className="v2-settings-input"
                  id="personal-mcp-name"
                  onChange={(event) => setName(event.currentTarget.value)}
                  placeholder="My MCP"
                  value={name}
                />
              </label>
              <label htmlFor="personal-mcp-url">
                Server URL
                <input
                  aria-describedby="personal-mcp-url-help"
                  className="v2-settings-input"
                  id="personal-mcp-url"
                  onChange={(event) => {
                    const next = event.currentTarget.value;
                    setUrl(next);
                    if (!isInsecureHttp(next)) setInsecureAcknowledged(false);
                  }}
                  placeholder="https://example.com/mcp"
                  required
                  type="url"
                  value={url}
                />
                <span className="v2-settings-input-help" id="personal-mcp-url-help">The server stays on its own host; AIQSA stores only your connection settings.</span>
              </label>
            </div>
            <div className="v2-settings-personal-mcp-options">
              <label htmlFor="personal-mcp-auth">
                Authorization
                <select
                  className="v2-settings-input"
                  id="personal-mcp-auth"
                  onChange={(event) => {
                    const next = event.currentTarget.value as typeof authMode;
                    setAuthMode(next);
                    if (next !== "static") setToken("");
                  }}
                  value={authMode}
                >
                  <option value="none">No authorization</option>
                  <option value="oauth">OAuth</option>
                  <option value="static">Bearer/API key header</option>
                </select>
              </label>
              {authMode === "static" ? (
                <label htmlFor="personal-mcp-token">
                  Bearer or API key
                  <input
                    autoComplete="off"
                    className="v2-settings-input"
                    id="personal-mcp-token"
                    onChange={(event) => setToken(event.currentTarget.value)}
                    required
                    type="password"
                    value={token}
                  />
                </label>
              ) : null}
              {isInsecureHttp(url) ? (
                <label className="v2-settings-http-warning" htmlFor="personal-mcp-http-warning">
                  <input
                    checked={insecureAcknowledged}
                    id="personal-mcp-http-warning"
                    onChange={(event) => setInsecureAcknowledged(event.currentTarget.checked)}
                    type="checkbox"
                  />
                  <span>I understand this connection is unencrypted.</span>
                </label>
              ) : null}
              <UiV2Button busy={busy === "custom"} disabled={busy !== null || !canSubmitCustom} type="submit" tone="primary">
                Add MCP
              </UiV2Button>
            </div>
          </form>

          {connections.length ? (
            <div aria-label="Your MCP connections" className="v2-settings-server-list">
              <div className="v2-settings-server-list-heading">
                <h3>Your MCP connections</h3>
                <p>Choose which tools each connection can use in MCP Auto.</p>
              </div>
              {connections.map((connection) => (
                <article className="v2-settings-server-row" key={connection.id}>
                  <div className="min-w-0 flex-1">
                    <div className="v2-settings-server-row-title">
                      <h3>{connection.name}</h3>
                      <span data-tone={connection.enabled ? "ok" : "neutral"}>{connection.enabled ? "Enabled" : "Disabled"}</span>
                    </div>
                    <p className="break-all text-xs text-ink-muted">{endpoint(connection)}</p>
                    {connection.oauthState && connection.oauthState !== "ready" ? (
                      <p className="v2-settings-field-note" data-tone="warn">Authorization is required before this connection can run.</p>
                    ) : null}
                    {(connection.availableTools ?? connection.tools).length ? (
                      <fieldset className="v2-settings-tool-selection">
                        <legend>Tools available in MCP Auto</legend>
                        <div className="v2-settings-tool-grid">
                          {(connection.availableTools ?? connection.tools).map((tool) => (
                            <label className="v2-settings-tool-option" key={tool.name}>
                              <input
                                checked={toolIsSelected(connection, tool.name)}
                                disabled={busy !== null}
                                onChange={(event) => void toggleTool(connection, tool.name, event.currentTarget.checked)}
                                type="checkbox"
                              />
                              <span>
                                <span className="v2-settings-tool-name">{tool.name}</span>
                                {tool.description ? <span className="v2-settings-tool-description">{tool.description}</span> : null}
                              </span>
                            </label>
                          ))}
                        </div>
                      </fieldset>
                    ) : connection.readiness === "ready" ? (
                      <p className="v2-settings-field-note">No tools reported yet. Refresh after the server is authorized.</p>
                    ) : null}
                  </div>
                  <div className="v2-settings-server-row-actions">
                    <UiV2Switch
                      checked={connection.enabled}
                      disabled={busy !== null}
                      label={`${connection.enabled ? "Disable" : "Enable"} ${connection.name}`}
                      onChange={(next) => void toggle(connection, next)}
                    />
                    {connection.connectorKey ? null : (
                      <UiV2Button
                        aria-label={`Disconnect ${connection.name}`}
                        disabled={busy !== null}
                        onClick={() => void remove(connection)}
                        tone="destructive"
                      >
                        Disconnect
                      </UiV2Button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          ) : null}
          {!connectors.length && !connections.length ? (
            <div className="v2-settings-mcp-state" data-tone="neutral">
              <p>No personal connections yet.</p>
              <span>Connect a service above or add any remote MCP server by URL.</span>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
