export type ConnectorId = "gmail" | "google_calendar" | "google_drive" | "github" | "notion";

export type ConnectorCatalogEntry = {
  authOrigins: string[];
  description: string;
  endpoint: string;
  id: ConnectorId;
  label: string;
  scopes: string[];
  status: "available" | "preview" | "unavailable";
  statusReason?: "oauth_client_missing";
  connection?: UserMcpServer;
};

export type ConnectorCatalogResponse = { connectors: ConnectorCatalogEntry[] };
import type { UserMcpServer } from "./mcp";
