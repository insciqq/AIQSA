import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpSettingsSection } from "./McpSettingsSection";
import { isMcpOAuthAuthorizing, resetMcpSettingsStoreForTest } from "./mcpSettingsStore";
import { MCP_RUN_PLAN_LIMITS, type UserMcpServer } from "@/lib/contracts/mcp";

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status: 200
  });
}

function userServer(id: string, name: string): UserMcpServer {
  return {
    accountLabel: null,
    description: `${name} team integration`,
    enabled: false,
    errorCode: null,
    fields: id === "mem0" ? [{
      configured: false,
      label: "API key",
      minLength: 8,
      sensitive: true,
      slotKey: "api_key",
      source: "missing",
      valueType: "secret"
    }] : [],
    id,
    knownToolCount: 1,
    name,
    oauthAvailable: false,
    oauthState: null,
    readiness: "disabled",
    tools: [{ description: `${name} tool`, name: `${id}_tool` }]
  };
}

describe("McpSettingsSection", () => {
  afterEach(() => {
    cleanup();
    resetMcpSettingsStoreForTest();
    vi.unstubAllGlobals();
  });

  it("keeps the data warning visible and collapses exact tool and run details until requested", async () => {
    const todoist = userServer("todoist", "Todoist");
    vi.stubGlobal("fetch", vi.fn(async () => response({ servers: [todoist] })));

    render(<McpSettingsSection />);
    await screen.findByRole("heading", { name: "Todoist" });

    expect(
      screen.getByText(/The model may pass conversation-derived data to an enabled tool/)
    ).toBeVisible();
    const disclosure = screen.getByText("How tools use data").closest("details");
    expect(disclosure).not.toHaveAttribute("open");
    expect(screen.getByRole("heading", { name: "Todoist" })).toBeVisible();

    fireEvent.click(screen.getByText("How tools use data"));

    expect(disclosure).toHaveAttribute("open");
    expect(screen.getByText("Every ready tool is automatically available to your normal AIQSA runs.")).toBeVisible();
    expect(screen.getByText("One tool’s output may influence a later call to another enabled server.")).toBeVisible();
    expect(screen.getByText(
      `Up to ${MCP_RUN_PLAN_LIMITS.maxEnabledServers} servers and ${MCP_RUN_PLAN_LIMITS.maxTools} discovered tools can enter one run; exact schema and context fit is checked again before the model starts.`
    )).toBeVisible();
  });

  it("lets a user independently enable multiple granted MCPs and save a write-only value", async () => {
    let servers = [userServer("mem0", "Mem0"), userServer("todoist", "Todoist")];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") return response({ servers });
      const id = decodeURIComponent(String(input).split("/").at(-1) ?? "");
      const update = JSON.parse(String(init.body)) as { enabled?: boolean; values?: Record<string, unknown> };
      servers = servers.map((server) => server.id === id
        ? {
            ...server,
            ...(update.enabled !== undefined ? {
              enabled: update.enabled,
              readiness: update.enabled ? "queued" as const : "disabled" as const
            } : {}),
            ...(update.values?.api_key ? {
              fields: server.fields.map((field) => ({ ...field, configured: true, source: "personal" as const }))
            } : {})
          }
        : server);
      return response({ server: servers.find((server) => server.id === id) });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<McpSettingsSection />);
    await screen.findByRole("heading", { name: "Mem0" });

    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "personal-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Save personal values" }));
    await waitFor(() => expect(servers[0]?.fields[0]?.source).toBe("personal"));

    fireEvent.click(screen.getByRole("button", { name: "Enable Mem0" }));
    fireEvent.click(screen.getByRole("button", { name: "Enable Todoist" }));
    await waitFor(() => expect(servers.every((server) => server.enabled)).toBe(true));

    const patchBodies = fetchMock.mock.calls
      .filter(([, init]) => init?.method === "PATCH")
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(patchBodies).toContainEqual({ enabled: true });
    expect(patchBodies).toContainEqual({ values: { api_key: "personal-token" } });
    expect(screen.getAllByText(/available tool/)).toHaveLength(2);
  });

  it("shows the transient authorizing state while an OAuth redirect is in flight", async () => {
    const notion: UserMcpServer = {
      ...userServer("notion", "Notion"),
      enabled: true,
      oauthAvailable: true,
      oauthState: "disconnected",
      readiness: "needs_authorization"
    };
    vi.stubGlobal("fetch", vi.fn(async () => response({ servers: [notion] })));

    render(<McpSettingsSection />);
    await screen.findByRole("heading", { name: "Notion" });
    const connect = screen.getByRole("button", { name: "Connect" });
    const form = connect.closest("form");
    expect(form).toHaveAttribute("action", "/api/me/mcp/notion/oauth/connect");
    expect(form).toHaveAttribute("method", "post");
    form?.addEventListener("submit", (event) => event.preventDefault());
    fireEvent.click(connect);

    expect(screen.getByText("Authorizing in your browser…")).toBeVisible();
    expect(screen.getByRole("button", { name: "Authorizing" })).toBeVisible();
    expect(isMcpOAuthAuthorizing("notion")).toBe(true);
  });

  it("routes a disconnected OAuth server through Connect instead of sending an invalid enable patch", async () => {
    const notion: UserMcpServer = {
      ...userServer("notion", "Notion"),
      oauthAvailable: true,
      oauthState: "disconnected"
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      response({ servers: [notion] }));
    vi.stubGlobal("fetch", fetchMock);

    render(<McpSettingsSection />);
    await screen.findByRole("heading", { name: "Notion" });
    const connectToEnable = screen.getByRole("button", { name: "Connect Notion to enable" });
    const form = connectToEnable.closest("form");
    expect(form).toHaveAttribute("action", "/api/me/mcp/notion/oauth/connect");
    expect(form).toHaveAttribute("method", "post");
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    form?.addEventListener("submit", (event) => event.preventDefault());
    fireEvent.click(connectToEnable);

    expect(screen.getAllByText("Authorizing in your browser…")).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    expect(screen.queryByText(/invalid_mcp_values/u)).not.toBeInTheDocument();
  });

  it("turns a raced OAuth enable rejection into an actionable reconnect path", async () => {
    const notion: UserMcpServer = {
      ...userServer("notion", "Notion"),
      oauthAvailable: true,
      oauthState: "ready"
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") return response({ servers: [notion] });
      return new Response(JSON.stringify({
        error: "invalid_mcp_values",
        issues: [{ code: "oauth_required", path: "oauth" }]
      }), {
        headers: { "content-type": "application/json" },
        status: 400
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<McpSettingsSection />);
    await screen.findByRole("heading", { name: "Notion" });
    fireEvent.click(screen.getByRole("button", { name: "Enable Notion" }));

    expect(await screen.findByText("Connect Notion to an external account before enabling it.")).toBeVisible();
    const reconnect = screen.getByRole("button", { name: "Reconnect" });
    expect(reconnect.closest("form")).toHaveAttribute("action", "/api/me/mcp/notion/oauth/reconnect");
    expect(reconnect.closest("form")).toHaveAttribute("method", "post");
    expect(screen.queryByText(/invalid_mcp_values/u)).not.toBeInTheDocument();
  });

  it("directs a missing personal value to setup without sending an invalid enable patch", async () => {
    const mem0 = userServer("mem0", "Mem0");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      response({ servers: [mem0] }));
    vi.stubGlobal("fetch", fetchMock);

    render(<McpSettingsSection />);
    await screen.findByRole("heading", { name: "Mem0" });
    fireEvent.click(screen.getByRole("button", { name: "Complete setup for Mem0" }));

    expect(screen.getByText("Add and save the required personal values before enabling this server.")).toBeVisible();
    expect(screen.getByLabelText("API key")).toHaveFocus();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  });

  it("prevents enabling more servers than the shared run-plan limit", async () => {
    const servers = Array.from({ length: MCP_RUN_PLAN_LIMITS.maxEnabledServers + 1 }, (_, index) => ({
      ...userServer(`server-${index}`, `Server ${index}`),
      enabled: index < MCP_RUN_PLAN_LIMITS.maxEnabledServers,
      readiness: index < MCP_RUN_PLAN_LIMITS.maxEnabledServers ? "ready" as const : "disabled" as const
    }));
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response({ servers }));
    vi.stubGlobal("fetch", fetchMock);

    render(<McpSettingsSection />);
    await screen.findByRole("heading", { name: `Server ${MCP_RUN_PLAN_LIMITS.maxEnabledServers}` });
    fireEvent.click(screen.getByRole("button", {
      name: `Enable Server ${MCP_RUN_PLAN_LIMITS.maxEnabledServers}`
    }));

    expect(screen.getByText(
      `You can enable at most ${MCP_RUN_PLAN_LIMITS.maxEnabledServers} MCP servers.`
    )).toBeVisible();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  });

  it("prevents a known discovered-tool set from exceeding the shared limit", async () => {
    const full = {
      ...userServer("full", "Full catalog"),
      enabled: true,
      readiness: "ready" as const,
      knownToolCount: MCP_RUN_PLAN_LIMITS.maxTools,
      tools: Array.from({ length: MCP_RUN_PLAN_LIMITS.maxTools }, (_, index) => ({
        description: null,
        name: `tool_${index}`
      }))
    };
    const candidate = userServer("candidate", "Candidate");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      response({ servers: [full, candidate] }));
    vi.stubGlobal("fetch", fetchMock);

    render(<McpSettingsSection />);
    await screen.findByRole("heading", { name: "Candidate" });
    fireEvent.click(screen.getByRole("button", { name: "Enable Candidate" }));

    expect(screen.getByText(
      `This would expose ${MCP_RUN_PLAN_LIMITS.maxTools + 1} known tools, above the ${MCP_RUN_PLAN_LIMITS.maxTools}-tool run limit.`
    )).toBeVisible();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  });

  it("uses the saved known count when a disabled server has no live runtime tools", async () => {
    const full = {
      ...userServer("full", "Full catalog"),
      enabled: true,
      knownToolCount: MCP_RUN_PLAN_LIMITS.maxTools,
      readiness: "idle" as const,
      tools: []
    };
    const candidate = {
      ...userServer("candidate", "Candidate"),
      knownToolCount: 1,
      tools: []
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      response({ servers: [full, candidate] }));
    vi.stubGlobal("fetch", fetchMock);

    render(<McpSettingsSection />);
    await screen.findByRole("heading", { name: "Candidate" });
    fireEvent.click(screen.getByRole("button", { name: "Enable Candidate" }));

    expect(screen.getByText(
      `This would expose ${MCP_RUN_PLAN_LIMITS.maxTools + 1} known tools, above the ${MCP_RUN_PLAN_LIMITS.maxTools}-tool run limit.`
    )).toBeVisible();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  });
});
