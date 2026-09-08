import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { useState } from "react";
import { AdminSectionTopbarProvider, type AdminShellTopbar } from "@/components/admin/AdminShell";
import type { AdminConfirmationRequest } from "@/components/admin/useAdminConfirmationController";
import { useAdminMcpController } from "@/components/admin/useAdminMcpController";
import type { AdminGroup, AdminUserRecord } from "@/lib/contracts/admin";
import type {
  AdminMcpCreateRequest,
  AdminMcpServer,
  AdminMcpUpdateRequest,
  McpDraftTestSummary,
  McpRevisionSummary,
  McpToolInventoryEntry
} from "@/lib/contracts/mcp";
import { AdminMcpSection } from "./AdminMcpSection";

const NOW = "2026-09-07T10:00:00.000Z";
const bannedWords = /\bdraft\b|revision|pending|probe|evidence|adapter|fingerprint|\bversion\b|\bCAS\b|tuple/iu;

const tools: McpToolInventoryEntry[] = [
  { description: "Store a note for the team", name: "remember" },
  { description: "Drop a stored note", name: "forget" }
];

function testedDraft(identityHash: string, inventory: McpToolInventoryEntry[] = tools): McpDraftTestSummary {
  return {
    draftHash: `hash-${identityHash}`,
    evidence: {},
    identityHash,
    resolvedArtifact: null,
    testedAt: NOW,
    toolInventory: inventory
  };
}

function configuration(
  id: string,
  revisionNumber: number,
  identityHash: string,
  artifactStatus: McpRevisionSummary["artifactStatus"] = "not_applicable",
  disabledToolNames?: string[]
): McpRevisionSummary {
  return {
    artifactStatus,
    createdAt: NOW,
    ...(disabledToolNames ? { disabledToolNames } : {}),
    draftHash: `hash-${identityHash}`,
    id,
    identityHash,
    resolvedArtifact: null,
    revisionNumber,
    validationEvidence: { evidence: {}, testedAt: NOW, toolInventory: tools }
  };
}

function workingServer(overrides: Partial<AdminMcpServer> = {}): AdminMcpServer {
  const active = configuration("configuration-1", 1, "identity-1");
  return {
    activePersonalSlots: [],
    activeRevision: active,
    activation: null,
    archivedAt: null,
    description: "Team memory tools",
    draft: {
      auth: { mode: "none" },
      runtime: { callTimeoutMs: 60_000, startupTimeoutMs: 60_000 },
      slots: [],
      source: { kind: "remote", url: "https://memory.example/mcp" },
      transport: "streamable_http"
    },
    draftTest: testedDraft("identity-1"),
    draftTested: true,
    enabled: true,
    grants: [],
    id: "server-1",
    name: "Working Tools",
    namespace: "working_tools",
    revisions: [active],
    sharedValues: {},
    updatedAt: NOW,
    validationOAuth: null,
    ...overrides
  };
}

function oauthServer(): AdminMcpServer {
  return workingServer({
    activeRevision: null,
    description: "Hosted workspace tools",
    draft: {
      ...workingServer().draft,
      auth: { allowedAuthorizationServerOrigins: ["https://auth.example"], mode: "oauth", scopes: [] },
      source: { kind: "remote", url: "https://workspace.example/mcp" }
    },
    draftTest: null,
    draftTested: false,
    enabled: false,
    id: "server-oauth",
    name: "Workspace tools",
    namespace: "workspace_tools",
    revisions: []
  });
}

const groups: AdminGroup[] = [
  { accessGrants: [], archivedAt: null, id: "group-1", name: "operators", systemRole: null, userCount: 2 },
  { accessGrants: [], archivedAt: null, id: "group-full", name: "Full access", systemRole: "full_access", userCount: 1 }
];

const users: AdminUserRecord[] = [
  {
    displayName: "Alice",
    directGrants: [],
    effectiveEntitlements: { models: [], providers: [], searchStrategies: [] },
    email: "alice@example.com",
    groups: [],
    hasVerifiedIdentity: true,
    id: "user-1",
    lastSessionAt: null,
    role: "user",
    status: "active"
  }
];

type Call = { body: Record<string, unknown> | null; method: string; url: string };

type ApiState = { failNextCheck: boolean; servers: AdminMcpServer[] };

function serverFromCreate(body: AdminMcpCreateRequest): AdminMcpServer {
  return {
    ...workingServer(),
    activeRevision: null,
    activation: body.activate ? {
      completedAt: null,
      errorCode: null,
      id: "activation-1",
      issues: [],
      requestedAt: NOW,
      stage: "queued",
      startedAt: null,
      updatedAt: NOW
    } : null,
    description: body.description ?? "",
    draft: body.draft,
    draftTest: null,
    draftTested: false,
    enabled: false,
    id: "created-server",
    name: body.name,
    namespace: "created_server",
    revisions: [],
    sharedValues: Object.fromEntries(body.draft.slots
      .filter((slot) => slot.policy.kind === "shared")
      .map((slot) => [slot.slotKey, { configured: Boolean(body.sharedValues?.[slot.slotKey]), updatedAt: null }]))
  };
}

function fakeApi(state: ApiState) {
  const calls: Call[] = [];
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
    calls.push({ body, method, url });
    if (method === "GET" && url === "/api/admin/mcp") return json({ servers: state.servers });
    if (method === "POST" && url === "/api/admin/mcp") {
      const created = serverFromCreate(body as unknown as AdminMcpCreateRequest);
      state.servers = [...state.servers, created];
      return json({ server: created }, 202);
    }
    const match = /^\/api\/admin\/mcp\/([^/]+)(?:\/(.+))?$/u.exec(url);
    const current = match ? state.servers.find((server) => server.id === decodeURIComponent(match[1]!)) : undefined;
    if (!match || !current) return json({ error: "mcp_not_found" }, 404);
    const action = match[2];
    const replace = (next: AdminMcpServer) => {
      state.servers = state.servers.map((server) => server.id === next.id ? next : server);
      return next;
    };
    if (method === "PATCH" && !action) {
      const update = body as AdminMcpUpdateRequest;
      const disabledToolNames = new Set(current.activeRevision?.disabledToolNames ?? []);
      if (update.tool?.enabled) disabledToolNames.delete(update.tool.name);
      else if (update.tool) disabledToolNames.add(update.tool.name);
      return json({ server: replace({
        ...current,
        ...(typeof update.enabled === "boolean" ? { enabled: update.enabled } : {}),
        ...(update.draft ? { draft: update.draft, draftTested: false } : {}),
        ...(update.name ? { name: update.name } : {}),
        ...(update.description !== undefined ? { description: update.description } : {}),
        ...(update.tool && current.activeRevision ? {
          activeRevision: { ...current.activeRevision, disabledToolNames: [...disabledToolNames] },
          draft: { ...current.draft, disabledToolNames: [...disabledToolNames] }
        } : {}),
        updatedAt: "2026-09-07T10:05:00.000Z"
      }) });
    }
    if (method === "DELETE" && !action) {
      state.servers = state.servers.filter((server) => server.id !== current.id);
      return json({ server: { ...current, archivedAt: NOW, enabled: false } });
    }
    if (action === "test") {
      if (state.failNextCheck) {
        state.failNextCheck = false;
        return json({ error: "mcp_draft_test_failed", issues: [{ code: "mcp_remote_validation_failed", path: "source" }] }, 400);
      }
      const update = body as AdminMcpUpdateRequest;
      const nextDraft = update.draft ?? current.draft;
      const active = configuration("configuration-next", (current.activeRevision?.revisionNumber ?? 0) + 1, "identity-next", "not_applicable", nextDraft.disabledToolNames);
      return json({ server: replace({
        ...current,
        activeRevision: active,
        draft: nextDraft,
        ...(update.name ? { name: update.name } : {}),
        ...(update.description !== undefined ? { description: update.description } : {}),
        draftTest: testedDraft("identity-next"),
        draftTested: true,
        enabled: true,
        revisions: [active, ...current.revisions]
      }) });
    }
    if (action === "check-update") {
      return json({ server: replace({
        ...current,
        draftTest: testedDraft("identity-checked", [...tools, { description: "Find notes", name: "search" }]),
        draftTested: true
      }) });
    }
    if (action === "activate") return json({ server: replace({ ...current, activation: null }) });
    if (action === "rollback") {
      const target = current.revisions.find((candidate) => candidate.id === body?.revisionId)!;
      return json({ server: replace({ ...current, activeRevision: target, draftTest: testedDraft(target.identityHash), draftTested: true }) });
    }
    if (action === "rebuild") return json({ server: replace({ ...current }) });
    if (action === "grants") {
      const grant = {
        canUse: Boolean(body?.canUse),
        groupId: (body?.groupId as string | undefined) ?? null,
        groupName: null,
        id: `grant-${calls.length}`,
        personalSlotKeys: (body?.personalSlotKeys as string[] | undefined) ?? [],
        userId: (body?.userId as string | undefined) ?? null,
        userName: null
      };
      return json({ server: replace({
        ...current,
        grants: [...current.grants.filter((existing) => existing.groupId !== grant.groupId || existing.userId !== grant.userId), grant]
      }) });
    }
    if (action === "oauth/validation/disconnect") return json({ status: "disconnecting" });
    return json({ error: "unexpected_request" }, 500);
  });
  return { calls, fetcher };
}

const dashboard = { groups, users };

// Every callback the harness hands to the section is stable, as the panel's
// are; an inline callback here would re-create the topbar on each render.
function Harness({
  feedback,
  fetcher,
  onSelectResource,
  requestConfirmation,
  resource
}: Readonly<{
  feedback: { reportError: Mock<(message: string) => void>; reportNotice: Mock<(message: string) => void> };
  fetcher: ReturnType<typeof fakeApi>["fetcher"];
  onSelectResource: Mock<(resource: string | null) => void>;
  requestConfirmation(config: AdminConfirmationRequest): void;
  resource: string | null;
}>) {
  const [topbar, setTopbar] = useState<AdminShellTopbar | null>(null);
  const controller = useAdminMcpController({
    active: true,
    fetcher,
    onError: feedback.reportError,
    onNotice: feedback.reportNotice
  });
  return (
    <AdminSectionTopbarProvider value={setTopbar}>
      <div data-testid="topbar">
        <h1 data-testid="topbar-title">{topbar?.title}</h1>
        <div data-testid="topbar-actions">{topbar?.actions}</div>
      </div>
      <AdminMcpSection
        controller={controller}
        dashboard={dashboard}
        feedback={feedback}
        onSelectResource={onSelectResource}
        requestConfirmation={requestConfirmation}
        resource={resource}
      />
    </AdminSectionTopbarProvider>
  );
}

function renderSection(state: ApiState, resource: string | null = null) {
  const api = fakeApi(state);
  const confirmations: AdminConfirmationRequest[] = [];
  const feedback = {
    reportError: vi.fn<(message: string) => void>(),
    reportNotice: vi.fn<(message: string) => void>()
  };
  const onSelectResource = vi.fn<(resource: string | null) => void>();
  const requestConfirmation = (config: AdminConfirmationRequest) => { confirmations.push(config); };
  const props = { feedback, fetcher: api.fetcher, onSelectResource, requestConfirmation };
  const view = render(<Harness {...props} resource={resource} />);
  const rerender = (nextResource: string | null) => view.rerender(<Harness {...props} resource={nextResource} />);
  return { calls: api.calls, confirmations, feedback, onSelectResource, rerender, view };
}

describe("AdminMcpSection", () => {
  const state: ApiState = { failNextCheck: false, servers: [] };

  beforeEach(() => {
    state.failNextCheck = false;
    state.servers = [workingServer(), oauthServer()];
    window.history.replaceState(null, "", "/admin?section=mcp");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists servers with one status word, tools and access, and opens a page through the resource callback", async () => {
    const { onSelectResource, view } = renderSection(state);

    const list = await screen.findByRole("list", { name: "MCP servers" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => within(row).getByTestId("mcp-server-status").textContent))
      .toEqual(["Working", "Setup needed"]);
    expect(rows[0]).toHaveTextContent("2 tools on");
    expect(rows[0]).toHaveTextContent("No access yet");
    expect(rows[1]).toHaveTextContent("Authorization required to check changes");
    expect(within(rows[1]!).getByRole("link", { name: "Connect Workspace tools" }))
      .toHaveAttribute("href", "/api/admin/mcp/server-oauth/oauth/validation/connect");
    await waitFor(() => expect(screen.getByTestId("topbar-title")).toHaveTextContent("MCP servers"));
    expect(view.container.textContent).not.toMatch(bannedWords);

    fireEvent.click(within(rows[0]!).getByRole("link", { name: "Open Working Tools · Working" }));
    expect(onSelectResource).toHaveBeenCalledWith("server-1");

    fireEvent.change(screen.getByRole("searchbox", { name: "Search servers" }), { target: { value: "workspace" } });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
  });

  it("New server opens the settings sheet, parses a pasted configuration and creates the server with activation", async () => {
    const { calls, onSelectResource } = renderSection(state);
    await screen.findByRole("list", { name: "MCP servers" });

    fireEvent.click(await screen.findByTestId("mcp-new-server"));
    const sheet = await screen.findByRole("dialog", { name: "New server" });
    expect(sheet).toHaveAttribute("aria-modal", "true");
    const parse = within(sheet).getByRole("button", { name: "Parse" });
    expect(parse).toBeDisabled();
    fireEvent.change(within(sheet).getByLabelText("Configuration JSON, URL, or install command"), {
      target: { value: "{ not json" }
    });
    fireEvent.click(parse);
    expect(within(sheet).getByRole("alert")).toHaveTextContent("not valid JSON");

    fireEvent.change(within(sheet).getByLabelText("Configuration JSON, URL, or install command"), {
      target: {
        value: `{
  "mcpServers": {
    "browser-mcp": {
      "args": ["-y", "@example/mcp@1.0.0",],
      "command": "npx",
      "env": { "API_KEY": "write-only-secret", },
    },
  },
}`
      }
    });
    fireEvent.click(within(sheet).getByRole("button", { name: "Parse" }));
    expect(within(sheet).getByLabelText("Name")).toHaveValue("browser-mcp");
    expect(within(sheet).getByLabelText("Source")).toHaveValue("npm");
    const secret = within(sheet).getByLabelText("New shared value for API_KEY");
    expect(secret).toHaveAttribute("type", "password");
    expect(secret).toHaveValue("write-only-secret");
    expect(sheet.textContent).not.toMatch(bannedWords);

    fireEvent.click(within(sheet).getByRole("button", { name: "Test & Save" }));
    await waitFor(() => expect(onSelectResource).toHaveBeenCalledWith("created-server"));
    const create = calls.find((call) => call.method === "POST" && call.url === "/api/admin/mcp");
    expect(create?.body).toMatchObject({ activate: true, name: "browser-mcp", sharedValues: { api_key: "write-only-secret" } });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows the server page with immediate tool and access switches", async () => {
    const { calls, view } = renderSection(state, "server-1");

    const page = await screen.findByTestId("mcp-server-page");
    expect(screen.getByTestId("mcp-server-page-status")).toHaveTextContent(/^Working · 2 tools on · checked /u);
    // The shell renders the topbar one commit after the page.
    await waitFor(() => expect(screen.getByTestId("topbar-title")).toHaveTextContent("Working Tools"));
    expect(screen.getByTestId("topbar-title")).toHaveTextContent("MCP servers");
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(within(page).getByTestId("mcp-tools-summary")).toHaveTextContent("2 of 2 on");
    expect(view.container.textContent).not.toMatch(bannedWords);

    const remember = within(page).getByRole("switch", { name: "Use remember" });
    expect(remember).toBeChecked();
    fireEvent.click(remember);
    await waitFor(() => expect(within(page).getByRole("switch", { name: "Use remember" })).not.toBeChecked());
    expect(calls.at(-1)).toMatchObject({
      body: { tool: { enabled: false, name: "remember" }, expectedUpdatedAt: NOW },
      method: "PATCH",
      url: "/api/admin/mcp/server-1"
    });
    expect(within(page).getByTestId("mcp-tools-summary")).toHaveTextContent("1 of 2 on");
    expect(within(page).queryByTestId("mcp-tools-pending")).not.toBeInTheDocument();

    const groupsList = within(page).getByRole("list", { name: "Groups with access to Working Tools" });
    expect(within(groupsList).getByTestId("system-mcp-grant-group-full")).toHaveTextContent("Included");
    fireEvent.click(within(groupsList).getByRole("switch", { name: "Working Tools for operators" }));
    await waitFor(() => expect(within(groupsList).getByRole("switch", { name: "Working Tools for operators" })).toBeChecked());
    expect(calls.at(-1)).toMatchObject({ body: { canUse: true, groupId: "group-1" }, method: "PUT", url: "/api/admin/mcp/server-1/grants" });

    const usersList = within(page).getByRole("list", { name: "Users with access to Working Tools" });
    fireEvent.click(within(usersList).getByRole("switch", { name: "Working Tools for Alice" }));
    await waitFor(() => expect(within(usersList).getByRole("switch", { name: "Working Tools for Alice" })).toBeChecked());
    expect(calls.at(-1)).toMatchObject({ body: { canUse: true, personalSlotKeys: [], userId: "user-1" }, method: "PUT" });
  });

  it("searches and collapses a long inventory, filters enabled tools and keeps focus after disabling a filtered tool", async () => {
    const inventory = Array.from({ length: 12 }, (_, index) => ({ name: `tool_${index + 1}`, description: `Action ${index + 1}` }));
    const server = workingServer();
    state.servers = [{ ...server, activeRevision: { ...server.activeRevision!,
      validationEvidence: { ...server.activeRevision!.validationEvidence, toolInventory: inventory } } }];
    const { calls } = renderSection(state, "server-1");
    const page = await screen.findByTestId("mcp-server-page");
    const list = within(page).getByRole("list", { name: "Tools of Working Tools" });
    expect(within(list).getAllByRole("switch")).toHaveLength(6);
    fireEvent.click(within(page).getByRole("button", { name: "Show all 12" }));
    expect(within(list).getAllByRole("switch")).toHaveLength(12);
    fireEvent.click(within(page).getByRole("button", { name: "Show fewer" }));
    expect(within(list).getAllByRole("switch")).toHaveLength(6);
    const search = within(page).getByRole("searchbox", { name: "Search tools" });
    fireEvent.change(search, { target: { value: "Action 12" } });
    expect(within(list).getAllByRole("switch")).toHaveLength(1);
    fireEvent.click(within(page).getByRole("checkbox", { name: "Only enabled" }));
    const tool = within(list).getByRole("switch", { name: "Use tool_12" });
    tool.focus();
    fireEvent.click(tool);
    await waitFor(() => expect(search).toHaveFocus());
    expect(within(page).getByText("No tools match your filters.")).toBeVisible();
    expect(calls.at(-1)).toMatchObject({ body: { tool: { name: "tool_12", enabled: false }, expectedUpdatedAt: NOW } });
    fireEvent.click(within(page).getByRole("button", { name: "Clear filters" }));
    expect(within(page).getByTestId("mcp-tools-summary")).toHaveTextContent("11 of 12 on");
  });

  it("Test & Save on the page sends the values for this check, clears them on success and reports a failed check", async () => {
    state.servers = [workingServer({
      draft: {
        ...workingServer().draft,
        slots: [{
          label: "Workspace key",
          policy: { kind: "personal", required: true },
          sensitive: true,
          slotKey: "workspace_key",
          target: { kind: "header", name: "X-Workspace-Key" },
          valueType: "secret"
        }]
      }
    })];
    const { calls, feedback } = renderSection(state, "server-1");
    const page = await screen.findByTestId("mcp-server-page");

    const field = within(page).getByLabelText("Workspace key");
    expect(field).toHaveAttribute("type", "password");
    fireEvent.change(field, { target: { value: "one-time-secret" } });
    fireEvent.click(within(page).getByTestId("mcp-test-save"));
    await waitFor(() => expect(calls.at(-1)?.url).toBe("/api/admin/mcp/server-1/test"));
    expect(calls.at(-1)?.body).toEqual({ expectedUpdatedAt: NOW, oneTimeValues: { workspace_key: "one-time-secret" }, publish: true });
    expect(calls.filter((call) => call.method === "PATCH")).toEqual([]);
    await waitFor(() => expect(within(page).getByLabelText("Workspace key")).toHaveValue(""));
    expect(feedback.reportNotice).toHaveBeenCalledWith("Settings checked and applied.");
    expect(page.textContent).not.toContain("one-time-secret");

    state.failNextCheck = true;
    fireEvent.change(within(page).getByLabelText("Workspace key"), { target: { value: "retry-secret" } });
    fireEvent.click(within(page).getByTestId("mcp-test-save"));
    await waitFor(() => expect(feedback.reportError).toHaveBeenCalledWith(expect.stringContaining("Could not connect to this MCP server")));
    expect(within(page).getByLabelText("Workspace key")).toHaveValue("retry-secret");
  });

  it("shows setup progress as a banner without tabs and offers Retry after a failed setup", async () => {
    const activation = {
      completedAt: null,
      errorCode: null,
      id: "activation-1",
      issues: [],
      requestedAt: NOW,
      stage: "queued" as const,
      startedAt: null,
      updatedAt: NOW
    };
    state.servers = [workingServer({ activation })];
    const { calls } = renderSection(state, "server-1");

    const banner = await screen.findByTestId("admin-mcp-activation-progress");
    expect(banner).toHaveTextContent("Updating · Starting");
    expect(banner).toHaveTextContent("Step 1 of 4");
    expect(screen.getByTestId("mcp-server-page-status")).toHaveTextContent("Applying · Updating · Starting (step 1 of 4)");
    expect(screen.getByTestId("mcp-test-save")).toBeDisabled();

    state.servers = [workingServer({ activation: { ...activation, errorCode: "mcp_draft_test_failed", issues: [{ code: "mcp_request_timeout", path: "source" }], stage: "failed" } })];
    const failed = await screen.findByTestId("admin-mcp-activation-failed", undefined, { timeout: 2_500 });
    expect(failed).toHaveTextContent("Setup failed");
    expect(failed).toHaveTextContent("did not respond in time");
    expect(screen.getByTestId("mcp-server-page-status")).toHaveTextContent("Check failed");
    fireEvent.click(within(failed).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(calls.at(-1)?.url).toBe("/api/admin/mcp/server-1/activate"));
  });

  it("turns the OAuth return into the server page and shows the outcome in the banner slot", async () => {
    window.history.replaceState(null, "", "/admin?section=mcp&oauth=connected&server=server-oauth&keep=yes#current");
    const { onSelectResource, rerender } = renderSection(state);

    await waitFor(() => expect(onSelectResource).toHaveBeenCalledWith("server-oauth"));
    expect(window.location.search).toBe("?section=mcp&keep=yes");
    expect(window.location.hash).toBe("#current");

    rerender("server-oauth");
    const banner = await screen.findByTestId("admin-mcp-oauth-return");
    expect(banner).toHaveTextContent("Your account is connected");
    expect(screen.getByTestId("mcp-authorization-state")).toHaveTextContent("Not connected");
    expect(screen.getByRole("link", { name: "Connect" })).toHaveAttribute("href", "/api/admin/mcp/server-oauth/oauth/validation/connect");
    fireEvent.click(within(banner).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("admin-mcp-oauth-return")).not.toBeInTheDocument();
  });

  it("Settings opens a focus-trapped sheet with the form, applies through Test & Save and asks before discarding edits", async () => {
    const { calls } = renderSection(state, "server-1");
    await screen.findByTestId("mcp-server-page");

    fireEvent.click(await screen.findByTestId("mcp-open-settings"));
    const sheet = await screen.findByRole("dialog", { name: "Settings" });
    expect(sheet).toHaveAttribute("aria-modal", "true");
    await waitFor(() => expect(within(sheet).getByRole("button", { name: "Close" })).toHaveFocus());
    expect(screen.getByTestId("admin-mcp-section").closest("[aria-hidden='true']")).not.toBeNull();
    expect(within(sheet).getByLabelText("Name")).toHaveValue("Working Tools");
    expect(sheet.textContent).not.toMatch(bannedWords);

    fireEvent.keyDown(sheet, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    fireEvent.click(await screen.findByTestId("mcp-open-settings"));
    const reopened = await screen.findByRole("dialog", { name: "Settings" });
    fireEvent.change(within(reopened).getByLabelText("Name"), { target: { value: "Renamed Tools" } });
    fireEvent.keyDown(reopened, { key: "Escape" });
    const discard = await screen.findByTestId("mcp-settings-discard");
    fireEvent.click(within(discard).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();

    fireEvent.click(within(reopened).getByRole("button", { name: "Test & Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls.filter((call) => call.method === "PATCH")).toEqual([]);
    expect(calls.at(-1)).toMatchObject({ body: { expectedUpdatedAt: NOW, name: "Renamed Tools", publish: true }, url: "/api/admin/mcp/server-1/test" });
    await waitFor(() => expect(screen.getByTestId("topbar-title")).toHaveTextContent("Renamed Tools"));
  });

  it("keeps a failed check inside the settings sheet with the fields preserved", async () => {
    renderSection(state, "server-1");
    await screen.findByTestId("mcp-server-page");

    fireEvent.click(await screen.findByTestId("mcp-open-settings"));
    const sheet = await screen.findByRole("dialog", { name: "Settings" });
    fireEvent.change(within(sheet).getByLabelText("Name"), { target: { value: "Broken Tools" } });
    state.failNextCheck = true;
    fireEvent.click(within(sheet).getByRole("button", { name: "Test & Save" }));

    const alert = await within(sheet).findByRole("alert");
    expect(alert).toHaveTextContent("Your changes were not applied");
    expect(within(sheet).getByLabelText("Name")).toHaveValue("Broken Tools");
    expect(state.servers[0].name).toBe("Working Tools");
    fireEvent.keyDown(sheet, { key: "Escape" });
    const discard = await screen.findByTestId("mcp-settings-discard");
    fireEvent.click(within(discard).getByRole("button", { name: "Confirm discard changes" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByTestId("topbar-title")).toHaveTextContent("Working Tools");
  });

  it("the ⋯ menu checks for updates, disables, restores an earlier configuration and deletes through the shared confirmation", async () => {
    const older = configuration("configuration-0", 0, "identity-0", "available");
    state.servers = [workingServer({ revisions: [workingServer().activeRevision!, older] })];
    const { calls, confirmations, onSelectResource } = renderSection(state, "server-1");
    await screen.findByTestId("mcp-server-page");
    // The topbar is rendered by the shell one commit after the page.
    await screen.findByRole("button", { name: "More actions for Working Tools" });
    const menu = () => screen.getByRole("button", { name: "More actions for Working Tools" });

    fireEvent.click(menu());
    fireEvent.click(screen.getByRole("menuitem", { name: "Check for update" }));
    await waitFor(() => expect(calls.at(-1)?.url).toBe("/api/admin/mcp/server-1/check-update"));
    await waitFor(() => expect(screen.getByTestId("mcp-server-page-status")).toHaveTextContent("Update ready"));
    expect(screen.getByTestId("mcp-tools-summary")).toHaveTextContent("2 of 2 on");

    fireEvent.click(menu());
    fireEvent.click(screen.getByRole("menuitem", { name: "Disable" }));
    await waitFor(() => expect(screen.getByTestId("mcp-server-page-status")).toHaveTextContent("Disabled"));
    expect(calls.at(-1)).toMatchObject({ body: { enabled: false }, method: "PATCH" });
    expect(confirmations).toHaveLength(0);

    fireEvent.click(menu());
    fireEvent.click(screen.getByRole("menuitem", { name: "Earlier configurations" }));
    const configurations = await screen.findByRole("dialog", { name: "Earlier configurations" });
    const items = within(configurations).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Configuration 1 · Current");
    expect(items[1]).toHaveTextContent("Configuration 0");
    expect(within(items[1]!).getByTestId("mcp-configuration-build")).toHaveTextContent("Ready to restore");
    expect(configurations.textContent).not.toMatch(bannedWords);
    fireEvent.click(within(items[1]!).getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls.at(-1)).toMatchObject({ body: { revisionId: "configuration-0" }, url: "/api/admin/mcp/server-1/rollback" });

    fireEvent.click(menu());
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]).toMatchObject({
      confirmLabel: "Delete server",
      testId: "admin-confirm-delete-mcp-server",
      title: "Delete “Working Tools”?",
      tone: "destructive"
    });
    await act(async () => { await confirmations[0]!.onConfirm(); });
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", url: "/api/admin/mcp/server-1" });
    expect(onSelectResource).toHaveBeenCalledWith(null);
  });

  it("keeps an archived server read-only and explains a missing one", async () => {
    state.servers = [workingServer({ archivedAt: NOW, enabled: false })];
    const { rerender } = renderSection(state, "server-1");
    await screen.findByTestId("mcp-archived-note");
    expect(screen.getByTestId("mcp-server-page-status")).toHaveTextContent("Archived");
    expect(screen.queryByTestId("mcp-test-save")).not.toBeInTheDocument();
    expect(await screen.findByTestId("mcp-open-settings")).toBeDisabled();
    expect(screen.queryByRole("button", { name: /More actions/u })).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Use remember" })).toBeDisabled();

    rerender("missing-server");
    expect(await screen.findByRole("alert")).toHaveTextContent("This MCP server no longer exists.");
  });
});
