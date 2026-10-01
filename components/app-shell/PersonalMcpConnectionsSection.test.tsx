import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PersonalMcpConnectionsSection } from "./PersonalMcpConnectionsSection";
import { followMcpOAuthStart, startMcpOAuth } from "./mcpSettingsApi";
import { useMcpSettingsStore } from "./mcpSettingsStore";
import { deactivatePersonalMcp, setPersonalMcpOAuthOutcome, usePersonalMcpStore } from "./personalMcpStore";

vi.mock("./mcpSettingsApi", async (importOriginal) => ({
  ...await importOriginal<typeof import("./mcpSettingsApi")>(),
  followMcpOAuthStart: vi.fn(),
  startMcpOAuth: vi.fn(async () => "https://auth.example.test/authorize?state=test")
}));

function server(overrides: Record<string, unknown> = {}) {
  return {
    accountLabel: null,
    authHeaderName: null,
    authMode: "none",
    availableTools: [
      { description: "Search things", name: "search" },
      { description: "Delete things", name: "delete" }
    ],
    description: "A personal test MCP",
    enabled: true,
    endpoint: "https://mcp.example/mcp",
    fields: [],
    id: "custom-1",
    knownToolCount: 1,
    name: "Test MCP",
    oauthAvailable: false,
    oauthState: null,
    readiness: "ready",
    runtimeErrorCode: null,
    sourceType: "personal",
    tools: [{ description: "Search things", name: "search" }],
    userDisabledToolNames: ["delete"],
    ...overrides
  };
}

function oauthServer(overrides: Record<string, unknown> = {}) {
  return server({ authMode: "oauth", id: "oauth-1", name: "Notion", oauthAvailable: true, oauthState: "disconnected", readiness: "needs_authorization", ...overrides });
}

function response(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json", ...headers }, status });
}

type Handler = (path: string, init: RequestInit | undefined) => Response | Promise<Response> | undefined;

function stubApi(servers: unknown[], handler: Handler = () => undefined) {
  const calls: { body: unknown; method: string; path: string }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    calls.push({ body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined, method, path });
    const answer = await handler(path, init);
    if (answer) return answer;
    if (path === "/api/me/mcp-connections" && method === "GET") return response({ servers });
    return response({ error: "unexpected" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

async function renderLoaded(onBusyChange?: (message: string | null) => void) {
  const view = render(<PersonalMcpConnectionsSection onBusyChange={onBusyChange} />);
  await waitFor(() => expect(usePersonalMcpStore.getState().loadState).not.toMatch(/idle|loading/));
  return view;
}

function fill(id: string, value: string) {
  fireEvent.change(document.getElementById(id)!, { target: { value } });
}

function row(name: string): HTMLElement {
  return screen.getByRole("heading", { name }).closest("article")!;
}

beforeEach(() => {
  window.history.replaceState(null, "", "/c/chat-1");
});

afterEach(() => {
  cleanup();
  deactivatePersonalMcp();
  vi.unstubAllGlobals();
  vi.mocked(followMcpOAuthStart).mockClear();
  vi.mocked(startMcpOAuth).mockReset();
  vi.mocked(startMcpOAuth).mockImplementation(async () => "https://auth.example.test/authorize?state=test");
  window.history.replaceState(null, "", "/");
});

describe("PersonalMcpConnectionsSection", () => {
  it("shows the add form and an empty state for an account without connections", async () => {
    const calls = stubApi([]);
    await renderLoaded();
    expect(screen.getByText("No personal connections yet.")).toBeVisible();
    expect(screen.getByRole("heading", { level: 4, name: "Connect your MCP" })).toBeVisible();
    expect(screen.getByRole("heading", { level: 3, name: "Personal connections" })).toBeVisible();
    expect(calls.map((call) => call.path)).toEqual(["/api/me/mcp-connections"]);
  });

  it("shows a load failure with Retry instead of an empty state", async () => {
    let fail = true;
    stubApi([], (path, init) => path === "/api/me/mcp-connections" && !init?.method && fail
      ? response({ error: "mcp_unavailable" }, 503)
      : undefined);
    await renderLoaded();
    expect(screen.getByRole("alert")).toHaveTextContent("Your connections could not be loaded.");
    expect(screen.queryByText("No personal connections yet.")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Connect your MCP" })).not.toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No personal connections yet.")).toBeVisible();
  });

  it("names the readiness of a connection that needs attention and keeps ready rows quiet", async () => {
    stubApi([
      server(),
      server({ id: "lan-1", name: "Home lab", readiness: "unavailable", runtimeErrorCode: "mcp_local_network_disabled" }),
      server({ id: "local-1", name: "Local tools", readiness: "unavailable", runtimeErrorCode: "mcp_internal_address_forbidden" }),
      server({ id: "start-1", name: "Tracker", readiness: "starting" })
    ]);
    await renderLoaded();
    expect(within(row("Test MCP")).queryByText(/Ready|Active|Checking|Inactive/)).not.toBeInTheDocument();
    expect(within(row("Test MCP")).getByText("1 of 2 tools on")).toBeVisible();
    expect(within(row("Home lab")).getByText(/turned off MCP connections to the local network/)).toBeVisible();
    expect(within(row("Local tools")).getByText(/belongs to AIQSA itself/)).toBeVisible();
    expect(within(row("Local tools")).getByText(/localhost means the AIQSA server itself/)).toBeVisible();
    expect(within(row("Tracker")).getByText("Starting runtime")).toBeVisible();
  });

  it("reconnects a custom OAuth connection through the personal route and returns to the origin chat", async () => {
    stubApi([oauthServer({ oauthState: "reauthorization_required", readiness: "reauthorization_required" })]);
    await renderLoaded();
    fireEvent.click(within(row("Notion")).getByRole("button", { name: "Reconnect Notion" }));
    await waitFor(() => expect(followMcpOAuthStart).toHaveBeenCalledWith("https://auth.example.test/authorize?state=test"));
    expect(startMcpOAuth).toHaveBeenCalledWith("/api/me/mcp-connections/oauth-1/oauth/connect?return=%2Fc%2Fchat-1");
  });

  it("never navigates when Settings closes while an authorization is starting", async () => {
    let resolveStart!: (location: string) => void;
    vi.mocked(startMcpOAuth).mockImplementation(() => new Promise((resolve) => { resolveStart = resolve; }));
    stubApi([oauthServer()]);
    const view = await renderLoaded();
    fireEvent.click(within(row("Notion")).getByRole("button", { name: "Connect Notion" }));
    view.unmount();
    await act(async () => resolveStart("https://auth.example.test/authorize"));
    expect(followMcpOAuthStart).not.toHaveBeenCalled();
  });

  it("offers Disconnect and add again when the sign-in details changed and prefills the form", async () => {
    vi.mocked(startMcpOAuth).mockRejectedValue(Object.assign(new Error("mcp_oauth_policy_forbidden"), { code: "mcp_oauth_policy_forbidden" }));
    stubApi([oauthServer({ endpoint: "https://mcp.notion.example/mcp" })], (path, init) =>
      init?.method === "DELETE" ? response({ server: oauthServer() }) : undefined);
    await renderLoaded();
    fireEvent.click(within(row("Notion")).getByRole("button", { name: "Connect Notion" }));
    expect(await within(row("Notion")).findByRole("alert")).toHaveTextContent("sign-in details changed");
    fireEvent.click(within(row("Notion")).getByRole("button", { name: "Disconnect and add again" }));
    await waitFor(() => expect(document.getElementById("personal-mcp-url")).toHaveValue("https://mcp.notion.example/mcp"));
    expect(document.getElementById("personal-mcp-auth")).toHaveValue("oauth");
    expect(document.getElementById("personal-mcp-url")).toHaveFocus();
  });

  it("shows an OAuth outcome on its connection and never in Studio's store", async () => {
    stubApi([oauthServer({ oauthState: "ready", readiness: "ready" })]);
    setPersonalMcpOAuthOutcome({ kind: "cancelled", serverId: "oauth-1" });
    await renderLoaded();
    expect(within(row("Notion")).getByText("Authorization was cancelled. Use Connect to try again.")).toBeVisible();
    expect(useMcpSettingsStore.getState().oauthOutcome).toBeNull();
    fireEvent.click(within(row("Notion")).getByRole("button", { name: "Dismiss" }));
    expect(usePersonalMcpStore.getState().oauthOutcome).toBeNull();
  });

  it("creates an OAuth connection named after its host, starts authorization and reports busy to Settings", async () => {
    const onBusyChange = vi.fn();
    const calls = stubApi([], (path, init) => path === "/api/me/mcp-connections" && init?.method === "POST"
      ? response({ server: oauthServer({ name: "mcp.notion.example" }) }, 201)
      : undefined);
    await renderLoaded(onBusyChange);
    fill("personal-mcp-url", "https://mcp.notion.example/mcp");
    fill("personal-mcp-auth", "oauth");
    fireEvent.click(screen.getByRole("button", { name: "Add MCP" }));
    await waitFor(() => expect(followMcpOAuthStart).toHaveBeenCalled());
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({
      auth: { mode: "oauth" }, insecureHttpAcknowledged: false, name: "mcp.notion.example", url: "https://mcp.notion.example/mcp"
    });
    expect(onBusyChange).toHaveBeenCalledWith("Adding connection…");
    expect(onBusyChange).toHaveBeenLastCalledWith("Opening authorization…");
  });

  it("confirms cross-site sign-in origins, resubmits with the acknowledgement, and Cancel keeps the form", async () => {
    let attempts = 0;
    const calls = stubApi([], (path, init) => {
      if (path !== "/api/me/mcp-connections" || init?.method !== "POST") return undefined;
      attempts += 1;
      if (attempts <= 2) {
        return response({ authorizationOrigins: ["https://login.one.example"], error: "oauth_authorization_origin_confirmation_required",
          issues: [{ code: "oauth_authorization_origin_confirmation_required", path: "authorizationOriginsAcknowledged" }] }, 422);
      }
      if (attempts === 3) {
        return response({ authorizationOrigins: ["https://login.two.example"], error: "oauth_authorization_origin_confirmation_required",
          issues: [{ code: "oauth_authorization_origin_confirmation_required", path: "authorizationOriginsAcknowledged" }] }, 422);
      }
      return response({ server: oauthServer() }, 201);
    });
    await renderLoaded();
    fill("personal-mcp-name", "Work wiki");
    fill("personal-mcp-url", "https://wiki.example/mcp");
    fill("personal-mcp-auth", "oauth");
    fireEvent.click(screen.getByRole("button", { name: "Add MCP" }));
    const confirm = await screen.findByRole("group", { name: "Confirm the sign-in site" });
    expect(within(confirm).getByText("https://login.one.example")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Confirm the sign-in site" })).toHaveFocus();

    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(document.getElementById("personal-mcp-name")).toHaveValue("Work wiki");
    expect(document.getElementById("personal-mcp-url")).toHaveValue("https://wiki.example/mcp");

    fireEvent.click(screen.getByRole("button", { name: "Add MCP" }));
    await screen.findByText("https://login.one.example");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("https://login.two.example")).toBeVisible();
    expect(screen.queryByText("https://login.one.example")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(followMcpOAuthStart).toHaveBeenCalled());
    expect(calls.filter((call) => call.method === "POST" && call.path === "/api/me/mcp-connections").map((call) =>
      (call.body as { authorizationOriginsAcknowledged?: string[] }).authorizationOriginsAcknowledged)).toEqual([
      undefined, undefined, ["https://login.one.example"], ["https://login.two.example"]
    ]);
  });

  it("sends a bare token as Bearer, a custom header verbatim, and masks the secret without engaging password managers", async () => {
    const calls = stubApi([], (path, init) => path === "/api/me/mcp-connections" && init?.method === "POST"
      ? response({ server: server({ authHeaderName: "Authorization", authMode: "static", id: `static-${Math.random()}` }) }, 201)
      : undefined);
    await renderLoaded();
    fill("personal-mcp-url", "https://api.example/mcp");
    fill("personal-mcp-auth", "static");
    const token = document.getElementById("personal-mcp-token")!;
    expect(token).toHaveAttribute("type", "text");
    expect(token).toHaveAttribute("autocomplete", "off");
    expect(token).toHaveAttribute("autocapitalize", "none");
    expect(token).toHaveAttribute("autocorrect", "off");
    expect(token).toHaveAttribute("spellcheck", "false");
    expect(token).toHaveClass("v2-settings-input-masked");
    for (const attribute of ["data-1p-ignore", "data-lpignore", "data-bwignore", "data-form-type"]) expect(token).not.toHaveAttribute(attribute);
    expect(document.getElementById("personal-mcp-header")).toHaveAttribute("maxlength", "128");
    expect(document.getElementById("personal-mcp-name")).toHaveAttribute("maxlength", "120");

    fill("personal-mcp-token", "ghp_secret");
    fireEvent.click(screen.getByRole("button", { name: "Add MCP" }));
    await screen.findByText("Test MCP added.");
    fill("personal-mcp-url", "https://keys.example/mcp");
    fill("personal-mcp-auth", "static");
    fill("personal-mcp-token", "raw-key");
    fill("personal-mcp-header", "X-API-Key");
    fireEvent.click(screen.getByRole("button", { name: "Add MCP" }));
    await waitFor(() => expect(calls.filter((call) => call.method === "POST")).toHaveLength(2));
    expect(calls.filter((call) => call.method === "POST").map((call) => [
      (call.body as { auth: unknown }).auth, (call.body as { values: unknown }).values
    ])).toEqual([
      [{ headerName: "Authorization", mode: "static" }, { authorization: "Bearer ghp_secret" }],
      [{ headerName: "X-API-Key", mode: "static" }, { authorization: "raw-key" }]
    ]);
  });

  it.each([
    ["the connection limit", response({ error: "personal_mcp_limit_reached" }, 409), /25 personal connections/, null],
    ["the rate limit", response({ error: "personal_mcp_rate_limited" }, 429, { "retry-after": "90" }), /Try again in 2 minutes/, null],
    ["an AIQSA-internal address", response({ error: "mcp_draft_test_failed", issues: [{ code: "mcp_internal_address_forbidden", path: "source" }] }, 422), /localhost means/, "personal-mcp-url"],
    ["a disabled local network", response({ error: "mcp_draft_test_failed", issues: [{ code: "mcp_local_network_disabled", path: "source" }] }, 422), /local network/, "personal-mcp-url"],
    ["a rejected token", response({ error: "mcp_draft_test_failed", issues: [{ code: "mcp_authorization_required", endpoint: "https://up.example", httpStatus: 401, path: "oneTimeValues.authorization" }] }, 422), /rejected this token/, "personal-mcp-token"]
  ])("explains %s next to the right field without upstream detail", async (_label, failure, copy, fieldId) => {
    stubApi([], (path, init) => path === "/api/me/mcp-connections" && init?.method === "POST" ? failure.clone() : undefined);
    await renderLoaded();
    fill("personal-mcp-url", "https://api.example/mcp");
    fill("personal-mcp-auth", "static");
    fill("personal-mcp-token", "secret");
    fireEvent.click(screen.getByRole("button", { name: "Add MCP" }));
    const message = await screen.findByText(copy);
    expect(document.body.textContent).not.toMatch(/401|up\.example/);
    if (fieldId) {
      const input = document.getElementById(fieldId)!;
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(input.getAttribute("aria-describedby")).toContain(message.id);
    } else {
      expect(message).toHaveAttribute("role", "alert");
    }
    expect(document.getElementById("personal-mcp-url")).toHaveValue("https://api.example/mcp");
  });

  it("toggles one tool while the rest of the panel stays usable", async () => {
    let resolvePatch!: (value: Response) => void;
    stubApi([server()], (path, init) => init?.method === "PATCH"
      ? new Promise<Response>((resolve) => { resolvePatch = resolve; })
      : undefined);
    await renderLoaded();
    const search = screen.getByRole("checkbox", { name: /search things/i });
    fireEvent.click(search);
    expect(search).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("checkbox", { name: /delete things/i })).not.toHaveAttribute("aria-disabled");
    expect(screen.getByRole("switch", { name: "Use Test MCP" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Disconnect Test MCP" })).toBeEnabled();
    await act(async () => resolvePatch(response({ server: server({ userDisabledToolNames: ["delete", "search"] }) })));
    expect(search).not.toBeChecked();
  });

  it("keeps the switch label stable, focus on the switch, and announces the change", async () => {
    stubApi([server()], (path, init) => init?.method === "PATCH" ? response({ server: server({ enabled: false, readiness: "disabled" }) }) : undefined);
    await renderLoaded();
    const toggle = screen.getByRole("switch", { name: "Use Test MCP" });
    toggle.focus();
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
    expect(screen.getByRole("switch", { name: "Use Test MCP" })).toBe(toggle);
    expect(toggle).toHaveFocus();
    expect(screen.getByText("Test MCP turned off.")).toBeInTheDocument();
  });

  it("explains the enabled-server limit when turning a connection on", async () => {
    stubApi([server({ enabled: false, readiness: "disabled" })], (path, init) => init?.method === "PATCH"
      ? response({ error: "mcp_enabled_server_limit_reached" }, 409)
      : undefined);
    await renderLoaded();
    fireEvent.click(screen.getByRole("switch", { name: "Use Test MCP" }));
    expect(await within(row("Test MCP")).findByRole("alert")).toHaveTextContent("At most 64 MCP servers");
  });

  it("disconnects, reports busy to Settings, and moves focus to the next connection", async () => {
    const onBusyChange = vi.fn();
    stubApi([server(), server({ id: "custom-2", name: "Second MCP" })], (path, init) =>
      init?.method === "DELETE" ? response({ server: server() }) : undefined);
    await renderLoaded(onBusyChange);
    fireEvent.click(within(row("Test MCP")).getByRole("button", { name: "Disconnect Test MCP" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Test MCP" })).not.toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "Second MCP" })).toHaveFocus();
    expect(onBusyChange).toHaveBeenCalledWith("Disconnecting…");
    expect(onBusyChange).toHaveBeenLastCalledWith(null);
  });

  it("keeps a failed disconnect visible on its row", async () => {
    stubApi([server()], (path, init) => init?.method === "DELETE" ? response({ error: "mcp_unavailable" }, 503) : undefined);
    vi.stubGlobal("confirm", vi.fn(() => { throw new Error("confirm should not be called"); }));
    await renderLoaded();
    fireEvent.click(within(row("Test MCP")).getByRole("button", { name: "Disconnect Test MCP" }));
    expect(await within(row("Test MCP")).findByRole("alert")).toHaveTextContent("could not be disconnected");
  });

  it("filters a long tool list without changing the switched-off tools", async () => {
    const availableTools = Array.from({ length: 13 }, (_, index) => ({ description: index === 4 ? "Find invoices" : null, name: `tool_${index}` }));
    stubApi([server({ availableTools, userDisabledToolNames: [] })]);
    await renderLoaded();
    const filter = screen.getByRole("searchbox", { name: "Filter tools of Test MCP" });
    fireEvent.change(filter, { target: { value: "invoice" } });
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    expect(screen.getByRole("checkbox", { name: /tool_4/ })).toBeChecked();
    fireEvent.change(filter, { target: { value: "nothing" } });
    expect(screen.getByText("No tools match “nothing”.")).toBeVisible();
  });

  it("shows no filter for a short tool list", async () => {
    stubApi([server()]);
    await renderLoaded();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  });

  it("requires the explicit warning for plain HTTP", async () => {
    stubApi([]);
    await renderLoaded();
    fill("personal-mcp-url", "http://127.0.0.1:9000/mcp");
    expect(screen.getByText(/^I understand this connection is unencrypted\.$/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Add MCP" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /connection is unencrypted/i }));
    expect(screen.getByRole("button", { name: "Add MCP" })).toBeEnabled();
  });
});
