import type { ConnectorCatalogEntry, ConnectorId } from "@/lib/contracts/connectors";
import type { McpDraftConfiguration } from "@/lib/contracts/mcp";

const CONNECTORS: readonly ConnectorCatalogEntry[] = Object.freeze([
  {
    authOrigins: ["https://accounts.google.com", "https://oauth2.googleapis.com"],
    description: "Search and read Gmail messages through your Google account.",
    endpoint: "https://gmailmcp.googleapis.com/mcp/v1",
    id: "gmail",
    label: "Gmail",
    scopes: ["openid", "email", "profile", "https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"],
    status: "preview"
  },
  {
    authOrigins: ["https://accounts.google.com", "https://oauth2.googleapis.com"],
    description: "Find and read your Google Calendar events.",
    endpoint: "https://calendarmcp.googleapis.com/mcp/v1",
    id: "google_calendar",
    label: "Google Calendar",
    scopes: ["openid", "email", "profile", "https://www.googleapis.com/auth/calendar.events.readonly"],
    status: "preview"
  },
  {
    authOrigins: ["https://accounts.google.com", "https://oauth2.googleapis.com"],
    description: "Search and read files in Google Drive.",
    endpoint: "https://drivemcp.googleapis.com/mcp/v1",
    id: "google_drive",
    label: "Google Drive",
    scopes: ["openid", "email", "profile", "https://www.googleapis.com/auth/drive.readonly"],
    status: "preview"
  },
  {
    authOrigins: ["https://github.com"],
    description: "Search and work with the GitHub resources you authorize.",
    endpoint: "https://api.githubcopilot.com/mcp/",
    id: "github",
    label: "GitHub",
    scopes: ["repo", "read:user"],
    status: "available"
  },
  {
    authOrigins: ["https://mcp.notion.com"],
    description: "Search and work with the Notion pages and databases you authorize.",
    endpoint: "https://mcp.notion.com/mcp",
    id: "notion",
    label: "Notion",
    scopes: [],
    status: "available"
  }
]);

export function listConnectorCatalog(
  availability?: Partial<Record<ConnectorId, boolean>>
): readonly ConnectorCatalogEntry[] {
  if (!availability) return CONNECTORS;
  return CONNECTORS.map((connector) => availability[connector.id] === false
    ? { ...connector, status: "unavailable" as const, statusReason: "oauth_client_missing" as const }
    : connector);
}

export function connectorConfigured(
  id: ConnectorId,
  availability?: Partial<Record<ConnectorId, boolean>>
): boolean {
  return availability?.[id] !== false;
}

export function connectorById(id: string): ConnectorCatalogEntry | null {
  return CONNECTORS.find((connector) => connector.id === id) ?? null;
}

export function connectorDraft(connector: ConnectorCatalogEntry): McpDraftConfiguration {
  return {
    auth: {
      allowedAuthorizationServerOrigins: connector.authOrigins,
      mode: "oauth",
      scopes: connector.scopes
    },
    runtime: { callTimeoutMs: 30_000, startupTimeoutMs: 15_000 },
    slots: [],
    source: { kind: "remote", url: connector.endpoint },
    transport: "streamable_http"
  };
}

export function isConnectorId(value: string): value is ConnectorId {
  return CONNECTORS.some((connector) => connector.id === value);
}
