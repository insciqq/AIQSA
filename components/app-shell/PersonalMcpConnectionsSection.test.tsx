import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PersonalMcpConnectionsSection } from "./PersonalMcpConnectionsSection";
import { followMcpOAuthStart, startMcpOAuth } from "./mcpSettingsApi";

vi.mock("./mcpSettingsApi", async (importOriginal) => ({
  ...await importOriginal<typeof import("./mcpSettingsApi")>(),
  followMcpOAuthStart: vi.fn(),
  startMcpOAuth: vi.fn(async () => "https://auth.example.test/authorize?state=test")
}));

function server(overrides: Record<string, unknown> = {}) {
  return {
    accountLabel: null,
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

describe("PersonalMcpConnectionsSection", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.mocked(followMcpOAuthStart).mockClear();
    vi.mocked(startMcpOAuth).mockClear();
  });

  it("shows only personal connections with the add form and an empty state", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/me/mcp-connections") return response({ servers: [] });
      return response({ error: "unexpected" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<PersonalMcpConnectionsSection />);
    expect(await screen.findByText("No personal connections yet.")).toBeVisible();
    expect(screen.getByText("Add any remote MCP server by URL above.")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Connect your MCP" })).toBeVisible();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual(["/api/me/mcp-connections"]);
  });

  it("always offers Disconnect, including for an OAuth connection awaiting authorization", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ servers: [
      server({ id: "oauth-1", name: "Notion", oauthAvailable: true, oauthState: "disconnected", readiness: "needs_authorization" })
    ] })));

    render(<PersonalMcpConnectionsSection />);
    const row = (await screen.findByRole("heading", { name: "Notion" })).closest("article")!;
    expect(within(row).getByRole("button", { name: "Disconnect Notion" })).toBeEnabled();
    expect(screen.queryByText("No personal connections yet.")).not.toBeInTheDocument();
  });

  it("creates a personal OAuth connection and starts its authorization", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/me/mcp-connections" && init?.method === "POST") {
        return response({ server: server({ id: "oauth-1", name: "Notion", oauthAvailable: true, oauthState: "disconnected", readiness: "needs_authorization" }) }, 201);
      }
      return response({ servers: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<PersonalMcpConnectionsSection />);
    await screen.findByText("No personal connections yet.");
    fireEvent.change(document.getElementById("personal-mcp-url")!, { target: { value: "https://mcp.notion.example/mcp" } });
    fireEvent.change(document.getElementById("personal-mcp-auth")!, { target: { value: "oauth" } });
    fireEvent.click(screen.getByRole("button", { name: "Add MCP" }));
    await waitFor(() => expect(followMcpOAuthStart).toHaveBeenCalledWith("https://auth.example.test/authorize?state=test"));
    expect(startMcpOAuth).toHaveBeenCalledWith("/api/me/mcp-connections/oauth-1/oauth/connect");
  });

  it("requires the explicit warning for plain HTTP and keeps deselected tools visible", async () => {
    let current = server();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/me/mcp-connections" && (!init?.method || init.method === "GET")) return response({ servers: [current] });
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
