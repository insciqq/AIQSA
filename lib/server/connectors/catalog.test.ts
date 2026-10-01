import { describe, expect, it } from "vitest";
import { connectorById, connectorConfigured, connectorDraft, listConnectorCatalog } from "./catalog";

describe("connector catalog", () => {
  it("keeps the first-party endpoints server-owned", () => {
    const entries = listConnectorCatalog();
    expect(entries.map((entry) => entry.id)).toEqual(["gmail", "google_calendar", "google_drive", "github", "notion"]);
    expect(entries.every((entry) => entry.endpoint.startsWith("https://"))).toBe(true);
    expect(entries.every((entry) => connectorDraft(entry).source.kind === "remote")).toBe(true);
  });

  it("creates OAuth-only drafts with fixed origins and scopes", () => {
    const notion = connectorById("notion");
    expect(notion).not.toBeNull();
    const draft = connectorDraft(notion!);
    expect(draft.auth).toMatchObject({ mode: "oauth", allowedAuthorizationServerOrigins: ["https://mcp.notion.com"] });
    expect(draft.slots).toEqual([]);
    expect(draft.source).toMatchObject({ kind: "remote", url: "https://mcp.notion.com/mcp" });
  });

  it("marks a provider unavailable when its server-side OAuth client is absent", () => {
    const entries = listConnectorCatalog({ gmail: false, github: true });
    expect(entries.find((entry) => entry.id === "gmail")).toMatchObject({
      status: "unavailable",
      statusReason: "oauth_client_missing"
    });
    expect(entries.find((entry) => entry.id === "github")?.status).toBe("available");
    expect(connectorConfigured("gmail", { gmail: false })).toBe(false);
    expect(connectorConfigured("gmail", { gmail: true })).toBe(true);
  });
});
