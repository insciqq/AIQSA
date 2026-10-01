import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PersonalMcpConnectionsSection } from "./PersonalMcpConnectionsSection";
import { followMcpOAuthStart } from "./mcpSettingsApi";

vi.mock("./mcpSettingsApi", async (importOriginal) => ({
  ...await importOriginal<typeof import("./mcpSettingsApi")>(),
  followMcpOAuthStart: vi.fn(),
  startMcpOAuth: vi.fn(async () => "https://auth.example.test/authorize?state=test")
}));

function server(overrides: Record<string, unknown> = {}) {
  return {
    accountLabel: null,
    connectorKey: null,
    description: "A personal test MCP",
    enabled: true,
    fields: [],
    id: "custom-1",
    knownToolCount: 2,
    name: "Test MCP",
    oauthAvailable: false,
    oauthState: null,
    operationalStatus: "inactive",
    readiness: "ready",
    selectedToolNames: ["search"],
    sourceType: "personal",
    tools: [
      { description: "Search things", name: "search" },
      { description: "Delete things", name: "delete" }
    ],
    ...overrides
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status
  });
}

const connectors = [
  {
    authOrigins: ["https://accounts.google.com"],
    description: "Read Gmail messages.",
    endpoint: "https://gmailmcp.googleapis.com/mcp/v1",
    id: "gmail",
    label: "Gmail",
    scopes: ["openid"],
    status: "preview"
  },
  {
    authOrigins: ["https://mcp.notion.com"],
    description: "Read Notion pages.",
    endpoint: "https://mcp.notion.com/mcp",
    id: "notion",
    label: "Notion",
    scopes: [],
    status: "available"
  }
];

describe("PersonalMcpConnectionsSection", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.mocked(followMcpOAuthStart).mockClear();
  });

  it("connects a catalog connector in one click and starts OAuth", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/me/mcp-connections") return response({ servers: [] });
      if (path === "/api/me/connectors" && (!init?.method || init.method === "GET")) return response({ connectors });
      if (path === "/api/me/connectors/gmail") return response({
        oauthAction: "/api/me/mcp/gmail-1/oauth/connect",
        server: server({ connectorKey: "gmail", id: "gmail-1", name: "Gmail", oauthAvailable: true, oauthState: "disconnected" })
      }, 201);
      return response({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<PersonalMcpConnectionsSection />);
    expect(await screen.findByRole("heading", { name: "Gmail" })).toBeVisible();
    fireEvent.click(within(screen.getByRole("heading", { name: "Gmail" }).closest("article")!).getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(followMcpOAuthStart).toHaveBeenCalledWith("https://auth.example.test/authorize?state=test"));
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/me/connectors/gmail")).toBe(true);
  });

  it("requires the explicit warning for plain HTTP and keeps deselected tools visible", async () => {
    let current = server();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/me/mcp-connections" && (!init?.method || init.method === "GET")) return response({ servers: [current] });
      if (path === "/api/me/connectors") return response({ connectors: [] });
      if (path === "/api/me/mcp-connections" && init?.method === "POST") return response({ error: "insecure_http_acknowledgement_required" }, 422);
      if (path.endsWith("/custom-1") && init?.method === "PATCH") {
        current = { ...current, selectedToolNames: [] };
        return response({ server: current });
      }
      return response({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<PersonalMcpConnectionsSection />);
    expect(await screen.findByRole("heading", { name: "Test MCP" })).toBeVisible();
    const search = screen.getByRole("checkbox", { name: /search/i });
    const remove = screen.getByRole("checkbox", { name: /delete/i });
    expect(search).toBeChecked();
    expect(remove).not.toBeChecked();
    fireEvent.click(search);
    await waitFor(() => expect(search).not.toBeChecked());
    expect(screen.getByRole("checkbox", { name: /delete/i })).toBeVisible();

    fireEvent.change(document.getElementById("personal-mcp-url")!, { target: { value: "http://127.0.0.1:9000/mcp" } });
    expect(screen.getByText(/^I understand this connection is unencrypted\.$/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Add MCP" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /connection is unencrypted/i }));
    expect(screen.getByRole("button", { name: "Add MCP" })).toBeEnabled();
  });

  it("disconnects without an extra confirmation and preserves a server error", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/me/mcp-connections" && (!init?.method || init.method === "GET")) return response({ servers: [server()] });
      if (path === "/api/me/connectors") return response({ connectors: [] });
      if (path.endsWith("/custom-1") && init?.method === "DELETE") return response({ error: "mcp_unavailable" }, 503);
      return response({});
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", vi.fn(() => { throw new Error("confirm should not be called"); }));

    render(<PersonalMcpConnectionsSection />);
    const row = await screen.findByRole("heading", { name: "Test MCP" });
    fireEvent.click(within(row.closest("article")!).getByRole("button", { name: "Disconnect Test MCP" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be disconnected");
  });
});
