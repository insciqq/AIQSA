import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpSettingsSection } from "./McpSettingsSection";
import { followMcpOAuthStart } from "./mcpSettingsApi";
import { isMcpOAuthAuthorizing, markMcpOAuthAuthorizing } from "./mcpSettingsStore";
import { MCP_RUN_PLAN_LIMITS, type UserMcpServer } from "@/lib/contracts/mcp";
import { resetMcpSettingsStoreForTest } from "@/tests/support/appShellStores";

// jsdom cannot navigate; the start answer is observed where the browser would follow it.
vi.mock("./mcpSettingsApi", async (importOriginal) => ({
  ...await importOriginal<typeof import("./mcpSettingsApi")>(),
  followMcpOAuthStart: vi.fn()
}));

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status
  });
}

function oauthStarts(fetchMock: Readonly<{ mock: Readonly<{ calls: readonly (readonly unknown[])[] }> }>): string[] {
  return fetchMock.mock.calls
    .filter(([input, init]) => String(input).includes("/oauth/") && (init as RequestInit | undefined)?.method === "POST")
    .map(([input]) => String(input));
}

function userServer(id: string, name: string): UserMcpServer {
  return {
    accountLabel: null,
    description: `${name} team integration`,
    enabled: false,
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

async function openServer(name: string) {
  fireEvent.click(await screen.findByRole("button", { name: `Open ${name}` }));
  return screen.findByRole("dialog", { name });
}

type McpPatch = { enabled?: boolean; values?: Record<string, unknown> };

/** A user catalog whose PATCH applies saved values and enablement like the server does. */
function patchableCatalog(initial: UserMcpServer[], options: Readonly<{ refuseEnable?: Response }> = {}) {
  let servers = initial;
  const patches: Array<{ id: string; body: McpPatch }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!init?.method || init.method === "GET") return response({ servers });
    const id = decodeURIComponent(String(input).split("/").at(-1) ?? "");
    const body = JSON.parse(String(init.body)) as McpPatch;
    patches.push({ id, body });
    if (body.enabled === true && options.refuseEnable) return options.refuseEnable.clone();
    servers = servers.map((server) => server.id !== id ? server : {
      ...server,
      ...(body.enabled !== undefined ? { enabled: body.enabled, readiness: body.enabled ? "queued" as const : "disabled" as const } : {}),
      fields: server.fields.map((field) => body.values && Object.hasOwn(body.values, field.slotKey)
        ? { ...field, configured: true, source: "personal" as const } : field)
    });
    return response({ server: servers.find((server) => server.id === id) });
  });
  return { fetchMock, patches, servers: () => servers };
}

const secondKey = { configured: false, label: "Workspace ID", sensitive: false, slotKey: "workspace_id",
  source: "missing" as const, valueType: "string" as const };

describe("McpSettingsSection", () => {
  afterEach(() => {
    cleanup();
    resetMcpSettingsStoreForTest();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.mocked(followMcpOAuthStart).mockClear();
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
    expect(screen.getByText(/Load all eagerly loads every enabled server/)).toBeVisible();
    expect(screen.getByText(/Enabled runtimes stay asleep until a chat or MCP Hub request needs them/)).toBeVisible();
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
    const status = () => within(card!).getByRole("status");
    expect(status()).toHaveTextContent(/^1 tool$/);
    const control = initial.getByRole("switch", { name: "Enable Todoist" });
    expect(control).toHaveAttribute("aria-checked", "false");
    fireEvent.click(control);
    await waitFor(() => expect(todoist.enabled).toBe(true));
    expect(within(card!).getByRole("switch", { name: "Enable Todoist" })).toHaveAttribute("aria-checked", "true");
    // A healthy enabled row presents only its tool count, never runtime-session warmth.
    expect(status()).toHaveTextContent(/^1 tool$/);
    fireEvent.click(control);
    await waitFor(() => expect(todoist.enabled).toBe(false));
    expect(status()).toHaveTextContent(/^1 tool$/);
    expect(card).not.toHaveTextContent(/Inactive|Active|Checking/);
    expect(control).toHaveAttribute("aria-checked", "false");
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
    const sheet = await openServer("Mem0");
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "personal-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Save personal values" }));
    await waitFor(() => expect(servers[0]?.fields[0]?.source).toBe("personal"));
    // Saving the last missing value completes setup, which enables the server.
    await waitFor(() => expect(servers[0]?.enabled).toBe(true));
    await waitFor(() => expect(within(sheet).getByRole("button", { name: "Cancel" })).toBeEnabled());
    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));

    expect(await screen.findByRole("switch", { name: "Enable Mem0" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("switch", { name: "Enable Todoist" }));
    await waitFor(() => expect(servers.every((server) => server.enabled)).toBe(true));

    const patchBodies = (id: string) => fetchMock.mock.calls
      .filter(([input, init]) => init?.method === "PATCH" && String(input).endsWith(`/${id}`))
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(patchBodies("mem0")).toEqual([{ values: { api_key: "personal-token" } }, { enabled: true }]);
    expect(patchBodies("todoist")).toEqual([{ enabled: true }]);
    // The status line counts tools once per enabled server; no separate
    // "available tools" line contradicts the catalog count.
    expect(screen.getAllByText("1 tool")).toHaveLength(2);
    expect(screen.getByText("2 of 2 servers enabled · 2 tools")).toBeVisible();
  });

  it("starts OAuth with a same-origin POST and follows the returned location", async () => {
    const notion: UserMcpServer = {
      ...userServer("notion", "Notion"),
      enabled: true,
      oauthAvailable: true,
      oauthState: "disconnected",
      readiness: "needs_authorization"
    };
    let answer: (value: Response) => void = () => undefined;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === "POST"
      ? new Promise<Response>((resolve) => { answer = resolve; })
      : response({ servers: [notion] }));
    vi.stubGlobal("fetch", fetchMock);

    render(<McpSettingsSection />);
    await screen.findByRole("heading", { name: "Notion" });
    await openServer("Notion");
    const connect = screen.getByRole("button", { name: "Connect" });
    expect(connect).not.toHaveAttribute("href");
    fireEvent.click(connect);

    expect(screen.getByText("Authorizing in your browser…")).toBeVisible();
    const authorizing = screen.getByRole("button", { name: "Authorizing" });
    expect(authorizing).toHaveAttribute("aria-disabled", "true");
    expect(authorizing).toHaveAttribute("aria-busy", "true");
    expect(isMcpOAuthAuthorizing("notion")).toBe(true);
    // A second press while the start request is in flight sends nothing.
    fireEvent.click(authorizing);
    expect(oauthStarts(fetchMock)).toEqual(["/api/me/mcp/notion/oauth/connect"]);
    const init = fetchMock.mock.calls.find(([, candidate]) => candidate?.method === "POST")?.[1];
    expect(init).toMatchObject({ credentials: "same-origin", method: "POST" });
    expect(init?.body).toBeUndefined();

    await act(async () => { answer(response({ location: "https://auth.example.test/authorize?state=s" })); });
    await waitFor(() => expect(followMcpOAuthStart).toHaveBeenCalledWith("https://auth.example.test/authorize?state=s"));
    expect(screen.getByRole("button", { name: "Authorizing" })).toBeVisible();
  });

  it.each([
    ["an error answer", () => response({ error: "mcp_oauth_unavailable" }, 503)],
    ["a location outside http(s)", () => response({ location: "javascript:alert(1)" })],
    ["a network failure", () => { throw new TypeError("Failed to fetch"); }]
  ])("restores the OAuth control with a visible error after %s", async (_label, answer) => {
    const notion: UserMcpServer = {
      ...userServer("notion", "Notion"), enabled: true, oauthAvailable: true,
      oauthState: "disconnected", readiness: "needs_authorization"
    };
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "POST" ? answer() : response({ servers: [notion] })));

    render(<McpSettingsSection />);
    await screen.findByRole("heading", { name: "Notion" });
    const sheet = await openServer("Notion");
    fireEvent.click(within(sheet).getByRole("button", { name: "Connect" }));

    expect(await within(sheet).findByRole("alert")).toHaveTextContent("Authorization for Notion could not be started. Try again.");
    expect(within(sheet).getByRole("button", { name: "Connect" })).not.toHaveAttribute("aria-disabled");
    expect(isMcpOAuthAuthorizing("notion")).toBe(false);
    expect(followMcpOAuthStart).not.toHaveBeenCalled();
  });

  it("recovers OAuth controls when the current document survives navigation", async () => {
    const notion: UserMcpServer = {
      ...userServer("notion", "Notion"), enabled: true, oauthAvailable: true,
      oauthState: "disconnected", readiness: "needs_authorization"
    };
    vi.stubGlobal("fetch", vi.fn(async () => response({ servers: [notion] })));
    vi.useFakeTimers();
    markMcpOAuthAuthorizing("notion");
    await act(async () => { render(<McpSettingsSection />); });
    expect(isMcpOAuthAuthorizing("notion")).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(isMcpOAuthAuthorizing("notion")).toBe(false);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Open Notion" })); });
    expect(screen.getByRole("button", { name: "Connect" })).not.toHaveAttribute("aria-disabled");
  });

  it("blocks OAuth on every server while any personal values have an unsaved draft", async () => {
    const notion: UserMcpServer = {
      ...userServer("notion", "Notion"), oauthAvailable: true,
      oauthState: "disconnected", readiness: "needs_authorization"
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      response({ servers: [userServer("mem0", "Mem0"), notion] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<McpSettingsSection />);
    await screen.findByRole("heading", { name: "Notion" });
    await openServer("Mem0");
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "synthetic-draft" } });
    const connect = screen.getByRole("button", { name: "Connect Notion to enable", hidden: true });
    expect(connect).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("Save or clear your personal values first")).toBeVisible();
    fireEvent.click(connect);
    expect(isMcpOAuthAuthorizing("notion")).toBe(false);
    expect(oauthStarts(fetchMock)).toEqual([]);
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "" } });
    expect(connect).not.toHaveAttribute("aria-disabled");
  });

  it("routes a disconnected OAuth server through Connect instead of sending an invalid enable patch", async () => {
    const notion: UserMcpServer = {
      ...userServer("notion", "Notion"),
      oauthAvailable: true,
      oauthState: "disconnected"
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === "POST"
      ? response({ location: "https://auth.example.test/authorize?state=s" })
      : response({ servers: [notion] }));
    vi.stubGlobal("fetch", fetchMock);

    render(<McpSettingsSection />);
    await screen.findByRole("heading", { name: "Notion" });
    const connectToEnable = screen.getByRole("button", { name: "Connect Notion to enable" });
    expect(screen.getByRole("status")).toHaveTextContent(/^1 tool$/);
    expect(connectToEnable).toHaveAttribute("data-tone", "primary");
    fireEvent.click(connectToEnable);

    expect(screen.getAllByText("Authorizing in your browser…")).toHaveLength(1);
    await waitFor(() => expect(followMcpOAuthStart).toHaveBeenCalledOnce());
    expect(oauthStarts(fetchMock)).toEqual(["/api/me/mcp/notion/oauth/connect"]);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    expect(screen.queryByText(/invalid_mcp_values/u)).not.toBeInTheDocument();
    // A navigation that never leaves this document releases the control again.
    await waitFor(() => expect(screen.queryByText("Authorizing in your browser…")).toBeNull(), { timeout: 3_000 });
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
    expect(screen.queryByRole("button", { name: "Connect Notion to enable" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Complete setup for Notion" }));
    const sheet = await screen.findByRole("dialog", { name: "Notion" });
    expect(within(sheet).getByRole("button", { name: "Connect" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "personal-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Save personal values" }));
    await waitFor(() => expect(within(sheet).getByRole("button", { name: "Connect" })).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("button", { name: "Connect Notion to enable" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Complete setup for Notion" })).not.toBeInTheDocument();
    // Authorization remains, so saving the values never sends an enable request.
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")
      .map(([, init]) => JSON.parse(String(init?.body)))).toEqual([{ values: { api_key: "personal-token" } }]);
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
    fireEvent.click(screen.getByRole("switch", { name: "Enable Notion" }));

    expect(await screen.findByText("Connect Notion to an external account before enabling it.")).toBeVisible();
    await openServer("Notion");
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(oauthStarts(fetchMock)).toEqual(["/api/me/mcp/notion/oauth/reconnect"]));
    expect(screen.queryByText(/invalid_mcp_values/u)).not.toBeInTheDocument();
  });

  it("directs a missing personal value to setup without sending an invalid enable patch", async () => {
    const mem0 = userServer("mem0", "Mem0");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      response({ servers: [mem0] }));
    vi.stubGlobal("fetch", fetchMock);

    render(<McpSettingsSection />);
    await screen.findByRole("heading", { name: "Mem0" });
    expect(screen.getByRole("status")).toHaveTextContent(/^1 tool$/);
    expect(screen.getByRole("button", { name: "Complete setup for Mem0" })).toHaveAttribute("data-tone", "primary");
    fireEvent.click(screen.getByRole("button", { name: "Complete setup for Mem0" }));

    expect(screen.getByText("Add and save the required personal values before enabling this server.")).toBeVisible();
    await waitFor(() => expect(screen.getByLabelText("API key")).toHaveFocus());
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
    fireEvent.click(screen.getByRole("switch", {
      name: `Enable Server ${MCP_RUN_PLAN_LIMITS.maxEnabledServers}`
    }));

    expect(screen.getByText(
      `You can enable at most ${MCP_RUN_PLAN_LIMITS.maxEnabledServers} MCP servers.`
    )).toBeVisible();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  });

  it("explains a server-side enabled-server limit that personal connections also count toward", async () => {
    const todoist = userServer("todoist", "Todoist");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => !init?.method || init.method === "GET"
      ? response({ servers: [todoist] })
      : response({ error: "mcp_enabled_server_limit_reached" }, 409));
    vi.stubGlobal("fetch", fetchMock);

    render(<McpSettingsSection />);
    await screen.findByRole("heading", { name: "Todoist" });
    fireEvent.click(screen.getByRole("switch", { name: "Enable Todoist" }));

    expect(await screen.findByText(
      `You can enable at most ${MCP_RUN_PLAN_LIMITS.maxEnabledServers} MCP servers, including your personal connections. Turn one off first.`
    )).toBeVisible();
    expect(screen.getByRole("switch", { name: "Enable Todoist" })).toHaveAttribute("aria-checked", "false");
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
    fireEvent.click(screen.getByRole("switch", { name: "Enable Candidate" }));

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
    fireEvent.click(screen.getByRole("switch", { name: "Enable Candidate" }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
    expect(screen.queryByText(/above the .*tool run limit/)).not.toBeInTheDocument();
  });

  it("presents tool counts, transitions and problems but never runtime-session warmth", async () => {
    const servers: UserMcpServer[] = [
      { ...userServer("live", "Live server"), enabled: true, readiness: "ready" },
      { ...userServer("idle", "Idle server"), enabled: true, readiness: "idle", knownToolCount: 9, tools: [] },
      { ...userServer("off", "Off server"), knownToolCount: 3, tools: [] },
      { ...userServer("empty", "Empty server"), enabled: true, readiness: "idle", knownToolCount: 0, tools: [] },
      { ...userServer("booting", "Booting server"), enabled: true, readiness: "starting" },
      { ...userServer("queued", "Queued server"), enabled: true, readiness: "queued", knownToolCount: 0, tools: [] },
      { ...userServer("setup", "Setup server"), enabled: true, readiness: "needs_setup" },
      { ...userServer("down", "Down server"), enabled: true, readiness: "unavailable", knownToolCount: 0, tools: [],
        runtimeErrorCode: "mcp_health_check_failed" }
    ];
    vi.stubGlobal("fetch", vi.fn(async () => response({ servers })));
    const { container } = render(<McpSettingsSection />);
    await screen.findByRole("heading", { name: "Down server" });
    const status = (name: string) => within(screen.getByRole("heading", { name }).closest("article")!).getByRole("status");
    expect(status("Live server")).toHaveTextContent(/^1 tool$/);
    expect(status("Idle server")).toHaveTextContent(/^9 tools$/);
    expect(status("Off server")).toHaveTextContent(/^3 tools$/);
    // The live region stays mounted while empty so later transitions are announced.
    expect(status("Empty server")).toBeEmptyDOMElement();
    expect(status("Empty server")).toHaveAttribute("aria-live", "polite");
    expect(status("Booting server")).toHaveTextContent(/^Starting runtime · 1 tool$/);
    expect(within(status("Booting server")).getByText("Starting runtime").querySelector(".v2-spinner")).not.toBeNull();
    expect(status("Queued server")).toHaveTextContent(/^Activating$/);
    expect(within(status("Queued server")).getByText("Activating").querySelector(".v2-spinner")).not.toBeNull();
    expect(status("Setup server")).toHaveTextContent(/^1 toolNeeds setup$/);
    expect(within(status("Setup server")).getByText("Needs setup")).toHaveAttribute("data-tone", "warn");
    expect(within(status("Down server")).getByText(/MCP health check failed/)).toHaveAttribute("data-tone", "danger");
    for (const element of container.querySelectorAll(".v2-settings-server-status")) {
      expect(element.textContent ?? "").not.toMatch(/^\s*·|·\s*$|·\s*·/);
    }
    expect(container).not.toHaveTextContent(/\b(Inactive|Active|Checking)\b/);
  });

  it("marks exactly the rows that need setup, authorization or a runtime with the attention signal", async () => {
    const servers: UserMcpServer[] = [
      userServer("mem0", "Setup server"),
      { ...userServer("connect", "Connect server"), oauthAvailable: true, oauthState: "disconnected" },
      { ...userServer("reconnect", "Reconnect server"), enabled: true, oauthAvailable: true,
        oauthState: "reauthorization_required", readiness: "reauthorization_required" },
      { ...userServer("down", "Down server"), enabled: true, readiness: "unavailable" },
      { ...userServer("ready", "Ready server"), enabled: true, readiness: "ready" },
      userServer("off", "Off server")
    ];
    vi.stubGlobal("fetch", vi.fn(async () => response({ servers })));
    render(<McpSettingsSection />);
    await screen.findByRole("heading", { name: "Off server" });
    const signal = (name: string) => screen.getByRole("heading", { name }).closest("article")!
      .querySelector(".v2-settings-server-signal");
    for (const name of ["Setup server", "Connect server", "Reconnect server", "Down server"]) {
      expect(signal(name), name).toHaveAttribute("aria-hidden", "true");
    }
    for (const name of ["Ready server", "Off server"]) expect(signal(name), name).toBeNull();
  });

  it("lists every unavailable tool with its reason beside the usable ones", async () => {
    const server: UserMcpServer = {
      ...userServer("repos", "Repositories"),
      enabled: true,
      readiness: "ready",
      unavailableTools: [
        { name: "delete_repo", reason: "unpublished_addition" },
        { name: "list_repos", reason: "definition_drift" },
        { name: "merge", reason: "restricted" },
        { name: "search", reason: "missing_upstream" },
        { name: "transfer", reason: "disabled_by_policy" }
      ]
    };
    vi.stubGlobal("fetch", vi.fn(async () => response({ servers: [server] })));
    render(<McpSettingsSection />);
    const sheet = await openServer("Repositories");

    expect(within(within(sheet).getByRole("list", { name: "Repositories tools" })).getByText("repos_tool")).toBeVisible();
    expect(within(sheet).getByRole("heading", { name: "Unavailable · 5" })).toBeVisible();
    const unavailable = within(within(sheet).getByRole("list", { name: "Repositories unavailable tools" })).getAllByRole("listitem");
    expect(unavailable.map((item) => item.textContent)).toEqual([
      "delete_repoNew on the server; waiting for an administrator to check it",
      "list_reposChanged on the server; waiting for an administrator to check it",
      "mergeRestricted by an administrator",
      "searchThe server does not offer it right now",
      "transferTurned off by an administrator"
    ]);
  });

  it("explains an empty usable list when every reported tool is unavailable", async () => {
    const server: UserMcpServer = {
      ...userServer("locked", "Locked"),
      enabled: true,
      readiness: "ready",
      tools: [],
      unavailableTools: [{ name: "merge", reason: "restricted" }]
    };
    vi.stubGlobal("fetch", vi.fn(async () => response({ servers: [server] })));
    render(<McpSettingsSection />);
    const sheet = await openServer("Locked");

    expect(within(sheet).getByText("None of this server's tools are available to you right now.")).toBeVisible();
    expect(within(sheet).queryByText("Tool names appear after the server reports them.")).not.toBeInTheDocument();
    expect(within(sheet).getByText("Restricted by an administrator")).toBeVisible();
  });

  it("omits internal failure details from ordinary settings", async () => {
    const server = { ...userServer("missing", "Unavailable server"), enabled: true,
      readiness: "unavailable", errorCode: "mcp_private_runtime_failure", runtime: "private-runtime-host", artifact: "private-image" };
    vi.stubGlobal("fetch", vi.fn(async () => response({ servers: [server] })));
    const { container } = render(<McpSettingsSection />);
    await screen.findByText("Runtime unavailable");
    expect(container).not.toHaveTextContent(/mcp_private_runtime_failure|private-image|private-runtime-host|rebuild|container/i);
  });

  it("shows a runtime health failure beside valid OAuth without asking for reconnection", async () => {
    const server = { ...userServer("health", "Health server"), enabled: true, oauthAvailable: true,
      oauthState: "ready" as const, readiness: "unavailable" as const, runtimeErrorCode: "mcp_health_check_failed" as const };
    vi.stubGlobal("fetch", vi.fn(async () => response({ servers: [server] })));
    render(<McpSettingsSection />);
    expect(await screen.findByText(/MCP health check failed/)).toBeVisible();
    expect(screen.queryByText("Activation failed")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Reconnect/ })).not.toBeInTheDocument();
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
    expect(within(card!).getByRole("status")).toHaveTextContent(/^1 toolNeeds authorization$/);
    expect(within(card!).getByRole("switch", { name: "Enable Notion" })).toHaveAttribute("aria-checked", "true");
    expect(within(card!).getByText("Needs authorization")).toHaveAttribute("data-tone", "warn");
    const sheet = await openServer("Notion");
    expect(within(sheet).getByRole("button", { name: "Connect" })).toBeVisible();
  });

  it("filters the catalog locally, opens details without fetching or starting servers, and keeps Hub lazy", async () => {
    const servers: UserMcpServer[] = [userServer("mem0", "Mem0"), {
      ...userServer("active", "Active server"), enabled: true, readiness: "ready"
    }, { ...userServer("idle", "Idle server"), description: "Search this description" }];
    const fetchMock = vi.fn(async () => response({ servers }));
    vi.stubGlobal("fetch", fetchMock);
    render(<McpSettingsSection />);
    await screen.findByRole("heading", { name: "Idle server" });
    expect(screen.getByRole("button", { name: "All 3" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Enabled 1" }));
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Active server" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Needs setup 1" }));
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Mem0" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "All 3" }));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "  DESCRIPTION " } });
    expect(screen.getAllByRole("article")).toHaveLength(1);
    const sheet = await openServer("Idle server");
    expect(within(sheet).getByText("Search this description")).toBeVisible();
    expect(within(sheet).getByText("idle_tool")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/me/mcp", expect.objectContaining({ cache: "no-store" }));
  });

  it("preserves personal drafts across refresh, protects closing, and settles failed saves before discarding", async () => {
    let server = userServer("mem0", "Mem0");
    let finishSave!: (response: Response) => void;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === "PATCH"
      ? new Promise<Response>(resolve => { finishSave = resolve; }) : response({ servers: [server] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<McpSettingsSection />);
    const sheet = await openServer("Mem0");
    const input = within(sheet).getByLabelText("API key");
    fireEvent.change(input, { target: { value: "synthetic-personal-value" } });
    input.focus();
    server = { ...server, description: "Refreshed description" };
    fireEvent.click(within(sheet).getByRole("button", { name: "Refresh status" }));
    await within(sheet).findByText("Refreshed description");
    expect(within(sheet).getByLabelText("API key")).toBe(input);
    expect(input).toHaveValue("synthetic-personal-value");
    const beforeUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(beforeUnload);
    expect(beforeUnload.defaultPrevented).toBe(true);
    fireEvent.keyDown(sheet, { key: "Escape" });
    const confirmation = await screen.findByRole("dialog", { name: "Unsaved MCP changes" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Keep editing" }));
    expect(input).toHaveValue("synthetic-personal-value");
    fireEvent.click(within(sheet).getByRole("button", { name: "Save personal values" }));
    await waitFor(() => expect(finishSave).toBeTypeOf("function"));
    expect(within(sheet).getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(within(sheet).getByRole("button", { name: "Close" })).toBeDisabled();
    fireEvent.keyDown(sheet, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Unsaved MCP changes" })).toBeNull();
    await act(async () => { finishSave(new Response("{}", { status: 503 })); });
    expect(within(sheet).getByRole("alert")).toHaveTextContent("The MCP server could not be updated. Try again.");
    expect(input).toHaveValue("synthetic-personal-value");
    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Unsaved MCP changes" }))
      .getByRole("button", { name: "Confirm discard changes" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(screen.getByRole("button", { name: "Open Mem0" })).toHaveFocus());
    // The sheet and its portaled confirmation close in one commit; the page must not stay isolated.
    for (const child of document.body.children) {
      expect((child as HTMLElement).inert).not.toBe(true);
      expect(child).not.toHaveAttribute("aria-hidden");
    }
    expect(document.body.style.overflow).toBe("");
    expect(within(await openServer("Mem0")).getByLabelText("API key")).toHaveValue("");
  });

  it("renders third-party secrets as masked text that the password manager ignores", async () => {
    const server: UserMcpServer = {
      ...userServer("mem0", "Mem0"),
      fields: [
        userServer("mem0", "Mem0").fields[0]!,
        { ...secondKey, slotKey: "token", label: "Token", valueType: "secret" },
        secondKey,
        { ...secondKey, slotKey: "limit", label: "Limit", valueType: "number" }
      ]
    };
    vi.stubGlobal("fetch", vi.fn(async () => response({ servers: [server] })));
    const { container } = render(<McpSettingsSection />);
    expect(await screen.findByRole("searchbox", { name: "Search MCP servers" })).toHaveAttribute("autocomplete", "off");
    const sheet = await openServer("Mem0");
    for (const label of ["API key", "Token"]) {
      const input = within(sheet).getByLabelText(label);
      expect(input).toHaveAttribute("type", "text");
      expect(input).toHaveAttribute("autocomplete", "off");
      expect(input).toHaveAttribute("autocapitalize", "none");
      expect(input).toHaveAttribute("autocorrect", "off");
      expect(input).toHaveAttribute("spellcheck", "false");
      expect(input).toHaveClass("v2-settings-input-masked");
    }
    expect(within(sheet).getByLabelText("Workspace ID")).toHaveAttribute("type", "text");
    expect(within(sheet).getByLabelText("Workspace ID")).not.toHaveClass("v2-settings-input-masked");
    expect(within(sheet).getByLabelText("Limit")).toHaveAttribute("type", "number");
    expect(container.ownerDocument.querySelector('input[type="password"]')).toBeNull();
    expect(within(sheet).getByRole("region", { name: "Personal values" })).toBeVisible();
  });

  it("enables a server once Complete setup saves its last missing value", async () => {
    const catalog = patchableCatalog([userServer("mem0", "Mem0")]);
    vi.stubGlobal("fetch", catalog.fetchMock);
    render(<McpSettingsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Complete setup for Mem0" }));
    const sheet = await screen.findByRole("dialog", { name: "Mem0" });
    fireEvent.change(within(sheet).getByLabelText("API key"), { target: { value: "personal-token" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Save personal values" }));
    expect(await within(sheet).findByText("Connection enabled")).toBeVisible();
    expect(catalog.patches).toEqual([
      { id: "mem0", body: { values: { api_key: "personal-token" } } },
      { id: "mem0", body: { enabled: true } }
    ]);
    expect(within(sheet).queryByRole("alert")).toBeNull();
    await waitFor(() => expect(within(sheet).getByRole("button", { name: "Cancel" })).toBeEnabled());
    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("switch", { name: "Enable Mem0" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(/^1 of 1 server enabled/)).toBeVisible();
  });

  it("never re-enables a server the user turned off after its setup was complete", async () => {
    const mem0 = userServer("mem0", "Mem0");
    const catalog = patchableCatalog([{
      ...mem0, fields: mem0.fields.map((field) => ({ ...field, configured: true, source: "personal" as const }))
    }]);
    vi.stubGlobal("fetch", catalog.fetchMock);
    render(<McpSettingsSection />);
    const sheet = await openServer("Mem0");
    fireEvent.change(within(sheet).getByLabelText("API key"), { target: { value: "replacement-token" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Save personal values" }));
    await waitFor(() => expect(within(sheet).getByRole("button", { name: "Cancel" })).toBeEnabled());
    expect(catalog.patches).toEqual([{ id: "mem0", body: { values: { api_key: "replacement-token" } } }]);
    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("switch", { name: "Enable Mem0" })).toHaveAttribute("aria-checked", "false");
  });

  it("keeps the server off while another personal value is still missing", async () => {
    const mem0 = userServer("mem0", "Mem0");
    const catalog = patchableCatalog([{ ...mem0, fields: [...mem0.fields, secondKey] }]);
    vi.stubGlobal("fetch", catalog.fetchMock);
    render(<McpSettingsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Complete setup for Mem0" }));
    const sheet = await screen.findByRole("dialog", { name: "Mem0" });
    fireEvent.change(within(sheet).getByLabelText("API key"), { target: { value: "personal-token" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Save personal values" }));
    await waitFor(() => expect(within(sheet).getByRole("button", { name: "Cancel" })).toBeEnabled());
    expect(catalog.patches).toEqual([{ id: "mem0", body: { values: { api_key: "personal-token" } } }]);
    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("button", { name: "Complete setup for Mem0" })).toBeVisible();
  });

  it("keeps saved values and explains a refused enable after setup", async () => {
    const catalog = patchableCatalog([userServer("mem0", "Mem0")], {
      refuseEnable: response({
        error: "invalid_mcp_values",
        issues: [{ code: "slot_value_required", path: "values.admin_endpoint" }]
      }, 400)
    });
    vi.stubGlobal("fetch", catalog.fetchMock);
    render(<McpSettingsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Complete setup for Mem0" }));
    const sheet = await screen.findByRole("dialog", { name: "Mem0" });
    const input = within(sheet).getByLabelText("API key");
    fireEvent.change(input, { target: { value: "personal-token" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Save personal values" }));
    expect(await within(sheet).findByRole("alert")).toHaveTextContent(
      "This server needs additional administrator configuration before it can be enabled."
    );
    expect(catalog.patches.map(({ body }) => body)).toEqual([{ values: { api_key: "personal-token" } }, { enabled: true }]);
    expect(within(sheet).getByText("Personal value configured")).toBeVisible();
    expect(input).toHaveValue("");
    expect(within(sheet).queryByText("Unsaved personal values")).toBeNull();
    expect(within(sheet).getByText("Connection disabled")).toBeVisible();
    expect(within(sheet).getByRole("button", { name: "Cancel" })).toBeEnabled();
    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("switch", { name: "Enable Mem0" })).toHaveAttribute("aria-checked", "false");
  });

  it("keeps Save busy and every exit blocked across both setup requests, then releases them after a failed enable", async () => {
    const mem0 = userServer("mem0", "Mem0");
    const answers: Array<(answer: Response) => void> = [];
    const patches: McpPatch[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") return response({ servers: [mem0] });
      patches.push(JSON.parse(String(init.body)) as McpPatch);
      return new Promise<Response>((resolve) => { answers.push(resolve); });
    }));
    const onBusyChange = vi.fn();
    render(<McpSettingsSection onBusyChange={onBusyChange} />);
    fireEvent.click(await screen.findByRole("button", { name: "Complete setup for Mem0" }));
    const sheet = await screen.findByRole("dialog", { name: "Mem0" });
    fireEvent.change(within(sheet).getByLabelText("API key"), { target: { value: "personal-token" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Save personal values" }));

    const expectBlocked = () => {
      expect(within(sheet).getByRole("button", { name: "Save personal values" })).toHaveAttribute("aria-busy", "true");
      expect(within(sheet).getByRole("button", { name: "Cancel" })).toBeDisabled();
      expect(within(sheet).getByRole("button", { name: "Close" })).toBeDisabled();
      expect(within(sheet).getByLabelText("API key")).toBeDisabled();
      expect(onBusyChange).toHaveBeenLastCalledWith(true);
      const leave = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(leave);
      expect(leave.defaultPrevented).toBe(true);
      // Escape and the scrim are ignored: no close, no discard confirmation.
      fireEvent.keyDown(sheet, { key: "Escape" });
      fireEvent.click(screen.getByRole("button", { name: "Dismiss", hidden: true }));
      expect(screen.getByRole("dialog", { name: "Mem0" })).toBe(sheet);
      expect(screen.queryByRole("dialog", { name: "Unsaved MCP changes" })).toBeNull();
    };

    await waitFor(() => expect(answers).toHaveLength(1));
    expect(patches).toEqual([{ values: { api_key: "personal-token" } }]);
    expectBlocked();
    await act(async () => {
      answers[0]!(response({ server: { ...mem0, fields: mem0.fields.map((field) => ({
        ...field, configured: true, source: "personal" as const })) } }));
    });

    await waitFor(() => expect(answers).toHaveLength(2));
    expect(patches).toEqual([{ values: { api_key: "personal-token" } }, { enabled: true }]);
    // The saved values cleared the draft; only the enable request keeps the sheet busy.
    expect(within(sheet).queryByText("Unsaved personal values")).toBeNull();
    expectBlocked();
    await act(async () => { answers[1]!(new Response("{}", { status: 503 })); });

    expect(await within(sheet).findByRole("alert")).toHaveTextContent("The MCP server could not be updated. Try again.");
    expect(within(sheet).getByRole("button", { name: "Save personal values" })).not.toHaveAttribute("aria-busy");
    expect(within(sheet).getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(within(sheet).getByRole("button", { name: "Close" })).toBeEnabled();
    expect(within(sheet).getByRole("button", { name: "Refresh status" })).toBeEnabled();
    expect(within(sheet).getByLabelText("API key")).toBeEnabled();
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
    const leave = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leave);
    expect(leave.defaultPrevented).toBe(false);
    fireEvent.keyDown(sheet, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Mem0" })).toBeNull());
    expect(screen.getByRole("switch", { name: "Enable Mem0" })).toHaveAttribute("aria-checked", "false");
  });

  it("saves setup values without enabling past the enabled-server limit", async () => {
    const enabled = Array.from({ length: MCP_RUN_PLAN_LIMITS.maxEnabledServers }, (_, index) => ({
      ...userServer(`server-${index}`, `Server ${index}`), enabled: true, readiness: "ready" as const
    }));
    const catalog = patchableCatalog([...enabled, userServer("mem0", "Mem0")]);
    vi.stubGlobal("fetch", catalog.fetchMock);
    render(<McpSettingsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Complete setup for Mem0" }));
    const sheet = await screen.findByRole("dialog", { name: "Mem0" });
    fireEvent.change(within(sheet).getByLabelText("API key"), { target: { value: "personal-token" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Save personal values" }));
    expect(await within(sheet).findByRole("alert")).toHaveTextContent(
      `You can enable at most ${MCP_RUN_PLAN_LIMITS.maxEnabledServers} MCP servers.`
    );
    expect(catalog.patches).toEqual([{ id: "mem0", body: { values: { api_key: "personal-token" } } }]);
    expect(within(sheet).getByText("Connection disabled")).toBeVisible();
  });

  it.each(["reauthorization_required", "needs_setup"] as const)("keeps the switch when an enabled server needs %s", async readiness => {
    const server: UserMcpServer = { ...userServer("mem0", "Mem0"), enabled: true, readiness,
      oauthAvailable: true, oauthState: "reauthorization_required" };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === "PATCH"
      ? response({ server: { ...server, enabled: false } }) : response({ servers: [server] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<McpSettingsSection />);
    fireEvent.click(await screen.findByRole("switch", { name: "Enable Mem0" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/me/mcp/mem0", expect.objectContaining({
      method: "PATCH", body: JSON.stringify({ enabled: false })
    })));
  });
});
