import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpSettingsSection } from "./McpSettingsSection";
import { isMcpOAuthAuthorizing } from "./mcpSettingsStore";
import { MCP_RUN_PLAN_LIMITS, type UserMcpServer } from "@/lib/contracts/mcp";
import { resetMcpSettingsStoreForTest } from "@/tests/support/appShellStores";

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
      screen.getByText(/Enabled servers join your private tool catalog/)
    ).toBeVisible();
    const disclosure = screen.getByText("How tools use data").closest("details");
    expect(disclosure).not.toHaveAttribute("open");
    expect(screen.getByRole("heading", { name: "Todoist" })).toBeVisible();

    fireEvent.click(screen.getByText("How tools use data"));

    expect(disclosure).toHaveAttribute("open");
    expect(screen.getByText(/Auto starts with a small schema-free catalog/)).toBeVisible();
    expect(screen.getByText(/Selected eagerly loads the servers you choose/)).toBeVisible();
    expect(screen.getByText(/Enabled runtimes stay asleep until a run actually needs them/)).toBeVisible();
  });

  it("keeps availability separate from the enable and disable actions", async () => {
    let todoist = userServer("todoist", "Todoist");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") return response({ servers: [todoist] });
      const update = JSON.parse(String(init.body)) as { enabled?: boolean };
      todoist = {
        ...todoist,
        enabled: Boolean(update.enabled),
        readiness: update.enabled ? "ready" : "disabled"
      };
      return response({ server: todoist });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<McpSettingsSection />);
    const heading = await screen.findByRole("heading", { name: "Todoist" });
    const card = heading.closest("article");
    expect(card).not.toBeNull();
    const initial = within(card!);
    const disabledStatus = initial.getByText("Disabled", {
      selector: "[data-resource-availability]"
    });
    const enable = initial.getByRole("button", { name: "Enable Todoist" });
    expect(disabledStatus.closest("button")).toBeNull();
    expect(disabledStatus).toHaveAttribute("data-resource-availability", "disabled");
    expect(enable).toHaveAttribute("data-tone", "primary");

    fireEvent.click(enable);
    await waitFor(() => expect(todoist.enabled).toBe(true));
    expect(within(card!).getByText("Enabled", {
      selector: "[data-resource-availability]"
    })).toHaveAttribute("data-resource-availability", "enabled");
    const disable = within(card!).getByRole("button", { name: "Disable Todoist" });
    expect(disable).toHaveAttribute("data-tone", "ghost");

    fireEvent.click(disable);
    await waitFor(() => expect(todoist.enabled).toBe(false));
    expect(within(card!).getByText("Disabled", {
      selector: "[data-resource-availability]"
    })).toBeVisible();
    expect(within(card!).getByRole("button", { name: "Enable Todoist" })).toBeVisible();
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
    const connect = screen.getByRole("link", { name: "Connect" });
    expect(connect).toHaveAttribute("href", "/api/me/mcp/notion/oauth/connect");
    connect.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(connect);

    expect(screen.getByText("Authorizing in your browser…")).toBeVisible();
    expect(screen.getByRole("link", { name: "Authorizing" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("link", { name: "Authorizing" })).toHaveAttribute("aria-busy", "true");
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
    const connectToEnable = screen.getByRole("link", { name: "Connect Notion to enable" });
    expect(screen.getByText("Disabled", { selector: "[data-resource-availability]" })).toBeVisible();
    expect(connectToEnable).toHaveAttribute("data-tone", "primary");
    expect(connectToEnable).toHaveAttribute("href", "/api/me/mcp/notion/oauth/connect");
    connectToEnable.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(connectToEnable);

    expect(screen.getAllByText("Authorizing in your browser…")).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    expect(screen.queryByText(/invalid_mcp_values/u)).not.toBeInTheDocument();
  });

  it("orders personal setup before OAuth connection when both are required", async () => {
    let notion: UserMcpServer = {
      ...userServer("mem0", "Notion"),
      id: "notion",
      oauthAvailable: true,
      oauthState: "disconnected"
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") return response({ servers: [notion] });
      notion = {
        ...notion,
        fields: notion.fields.map((field) => ({
          ...field,
          configured: true,
          source: "personal" as const
        }))
      };
      return response({ server: notion });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<McpSettingsSection />);
    await screen.findByRole("heading", { name: "Notion" });
    expect(screen.getByRole("button", { name: "Complete setup for Notion" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Connect Notion to enable" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "personal-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Save personal values" }));

    expect(await screen.findByRole("link", { name: "Connect Notion to enable" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Complete setup for Notion" })).not.toBeInTheDocument();
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
    const reconnect = screen.getByRole("link", { name: "Reconnect" });
    expect(reconnect).toHaveAttribute("href", "/api/me/mcp/notion/oauth/reconnect");
    expect(screen.queryByText(/invalid_mcp_values/u)).not.toBeInTheDocument();
  });

  it("directs a missing personal value to setup without sending an invalid enable patch", async () => {
    const mem0 = userServer("mem0", "Mem0");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      response({ servers: [mem0] }));
    vi.stubGlobal("fetch", fetchMock);

    render(<McpSettingsSection />);
    await screen.findByRole("heading", { name: "Mem0" });
    expect(screen.getByText("Disabled", { selector: "[data-resource-availability]" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Complete setup for Mem0" })).toHaveAttribute("data-tone", "primary");
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

  it("does not treat the enabled catalog size as schemas loaded into every run", async () => {
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
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "PATCH"
        ? response({ server: { ...candidate, enabled: true, readiness: "idle" } })
        : response({ servers: [full, candidate] }));
    vi.stubGlobal("fetch", fetchMock);

    render(<McpSettingsSection />);
    await screen.findByRole("heading", { name: "Candidate" });
    fireEvent.click(screen.getByRole("button", { name: "Enable Candidate" }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
    expect(screen.queryByText(/above the .*tool run limit/)).not.toBeInTheDocument();
  });

  it("keeps dormant catalog counts informational rather than blocking enablement", async () => {
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
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "PATCH"
        ? response({ server: { ...candidate, enabled: true, readiness: "idle" } })
        : response({ servers: [full, candidate] }));
    vi.stubGlobal("fetch", fetchMock);

    render(<McpSettingsSection />);
    await screen.findByRole("heading", { name: "Candidate" });
    fireEvent.click(screen.getByRole("button", { name: "Enable Candidate" }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
    expect(screen.queryByText(/above the .*tool run limit/)).not.toBeInTheDocument();
  });

  it("shows queued readiness as progress and idle readiness as on-demand availability", async () => {
    const authorizing = {
      ...userServer("authorizing", "Authorizing server"),
      enabled: true,
      readiness: "authorizing" as const
    };
    const queued = {
      ...userServer("queued", "Queued server"),
      enabled: true,
      readiness: "queued" as const
    };
    const idle = {
      ...userServer("idle", "Idle server"),
      enabled: true,
      readiness: "idle" as const
    };
    vi.stubGlobal("fetch", vi.fn(async () => response({ servers: [authorizing, queued, idle] })));

    render(<McpSettingsSection />);
    await screen.findByRole("heading", { name: "Authorizing server" });

    const authorizingReadiness = screen.getByText("Authorizing").closest("p");
    const queuedReadiness = screen.getByText("Activating").closest("p");
    const idleReadiness = screen.getByText("Available on demand").closest("p");
    // Progress states show the spinner; ready states the check with the "ok" tone.
    expect(authorizingReadiness?.querySelector(".v2-spinner")).not.toBeNull();
    expect(queuedReadiness?.querySelector(".v2-spinner")).not.toBeNull();
    expect(idleReadiness?.querySelector(".v2-spinner")).toBeNull();
    expect(idleReadiness).toHaveAttribute("data-tone", "ok");
    expect(screen.queryByText("Queued")).not.toBeInTheDocument();
    expect(screen.queryByText("Needs setup")).not.toBeInTheDocument();
  });

  it("keeps enabled availability visible beside authorization readiness", async () => {
    const notion = {
      ...userServer("notion", "Notion"),
      enabled: true,
      oauthAvailable: true,
      oauthState: "disconnected" as const,
      readiness: "needs_authorization" as const
    };
    vi.stubGlobal("fetch", vi.fn(async () => response({ servers: [notion] })));

    render(<McpSettingsSection />);
    const heading = await screen.findByRole("heading", { name: "Notion" });
    const card = heading.closest<HTMLElement>("article");
    expect(card).not.toBeNull();
    expect(within(card!).getByText("Enabled", {
      selector: "[data-resource-availability]"
    })).toBeVisible();
    expect(within(card!).getByText("Needs authorization")).toHaveAttribute("data-tone", "warn");
    expect(within(card!).getByRole("link", { name: "Connect" })).toBeVisible();
  });
});
