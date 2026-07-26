import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminDashboard } from "@/lib/contracts/admin";
import type { AdminEmailState } from "@/lib/contracts/email";
import { StrictMode } from "react";
import { AdminPanel } from "./AdminPanel";

const adminMcpController = vi.hoisted(() => ({
  actions: {
    activate: vi.fn(async () => false),
    checkUpdate: vi.fn(async () => false),
    create: vi.fn(async () => null),
    delete: vi.fn(async () => false),
    disconnectValidationOAuth: vi.fn(async () => false),
    dismissError: vi.fn(),
    dismissNotice: vi.fn(),
    grant: vi.fn(async () => false),
    rebuild: vi.fn(async () => false),
    refresh: vi.fn(async () => undefined),
    rollback: vi.fn(async () => false),
    select: vi.fn(),
    test: vi.fn(async () => false),
    update: vi.fn(async () => false)
  },
  state: {
    busy: false,
    error: null,
    loaded: true,
    loading: false,
    notice: null,
    selectedServer: null,
    servers: []
  }
}));

vi.mock("@/components/admin/useAdminMcpController", () => ({
  useAdminMcpController: () => adminMcpController
}));

const dashboard: AdminDashboard = {
  accessRules: [
    {
      defaultGroups: [
        {
          groupId: "group-1",
          name: "operators",
          role: "member"
        }
      ],
      enabled: true,
      id: "rule-1",
      kind: "email",
      value: "allowed@example.com"
    }
  ],
  catalog: {
    models: [
      {
        displayName: "GPT 5.5",
        modelId: "gpt-5.5",
        provider: "openai"
      },
      {
        displayName: "GPT Mini",
        modelId: "gpt-mini",
        provider: "openai"
      }
    ],
    providers: [
      {
        id: "openai",
        name: "OpenAI"
      }
    ],
    searchStrategies: [
      {
        displayName: "OpenAI web search",
        strategyId: "openai-native-web-search"
      }
    ]
  },
  groups: [
    {
      accessGrants: [],
      archivedAt: null,
      deletion: {
        canDelete: false,
        reason: "group_has_members",
        summary: "Remove 1 member before deleting this group."
      },
      id: "group-1",
      name: "operators",
      userCount: 1
    },
    {
      accessGrants: [],
      archivedAt: null,
      deletion: {
        canDelete: true,
        reason: null,
        summary: "No members or active grants; this group can be deleted."
      },
      id: "group-2",
      name: "reviewers",
      userCount: 0
    },
    {
      accessGrants: [
        {
          enabled: true,
          groupId: "group-archived",
          id: "grant-archived-provider",
          modelId: null,
          provider: "openai",
          searchStrategy: null,
          userId: null
        }
      ],
      archivedAt: "2026-06-02T00:00:00.000Z",
      deletion: {
        canDelete: false,
        reason: "group_has_grants",
        summary: "Remove 1 active grant before deleting this group."
      },
      id: "group-archived",
      name: "legacy-archive",
      userCount: 0
    }
  ],
  invites: [
    {
      acceptedAt: null,
      deletion: {
        canDelete: false,
        reason: "invite_open",
        summary: "Revoke this open invite before deleting it."
      },
      defaultGroups: [
        {
          groupId: "group-1",
          name: "operators",
          role: "member"
        }
      ],
      email: "open@example.com",
      expiresAt: "2099-01-01T00:00:00.000Z",
      id: "invite-open",
      normalizedEmail: "open@example.com",
      revokedAt: null
    },
    {
      acceptedAt: "2026-06-01T00:00:00.000Z",
      deletion: {
        canDelete: false,
        reason: "invite_accepted",
        summary: "Accepted invites are kept for audit history."
      },
      defaultGroups: [],
      email: "accepted@example.com",
      expiresAt: "2099-01-01T00:00:00.000Z",
      id: "invite-accepted",
      normalizedEmail: "accepted@example.com",
      revokedAt: null
    },
    {
      acceptedAt: null,
      deletion: {
        canDelete: true,
        reason: null,
        summary: "This stale invite can be deleted."
      },
      defaultGroups: [],
      email: "revoked@example.com",
      expiresAt: "2099-01-01T00:00:00.000Z",
      id: "invite-revoked",
      normalizedEmail: "revoked@example.com",
      revokedAt: "2026-06-02T00:00:00.000Z"
    }
  ],
  navigation: {
    advancedConfigured: true,
    attention: {
      activeUsersWithoutModelAccess: 0,
      openInvites: 1,
      pendingUsers: 1
    },
    teamConfigured: true
  },
  usage: {
    byGroup: [
      {
        archivedAt: null,
        cachedInputTokens: 40,
        cacheWriteInputTokens: 5,
        contributingUsers: 1,
        groupId: "group-1",
        inputTokens: 300,
        lastUsedAt: "2026-06-14T12:00:00.000Z",
        name: "operators",
        outputTokens: 500,
        reasoningTokens: 80,
        runCount: 3,
        totalTokens: 800,
        userCount: 1
      },
      {
        archivedAt: null,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        contributingUsers: 0,
        groupId: "group-2",
        inputTokens: 0,
        lastUsedAt: null,
        name: "reviewers",
        outputTokens: 0,
        reasoningTokens: 0,
        runCount: 0,
        totalTokens: 0,
        userCount: 0
      }
    ],
    byUser: [
      {
        cachedInputTokens: 40,
        cacheWriteInputTokens: 5,
        displayName: "Active User",
        email: "active@example.com",
        groups: [
          {
            groupId: "group-1",
            name: "operators",
            role: "member"
          }
        ],
        inputTokens: 300,
        lastUsedAt: "2026-06-14T12:00:00.000Z",
        outputTokens: 500,
        providerModels: [
          {
            cachedInputTokens: 40,
            cacheWriteInputTokens: 5,
            inputTokens: 300,
            lastUsedAt: "2026-06-14T12:00:00.000Z",
            modelId: "gpt-5.5",
            outputTokens: 500,
            provider: "openai",
            reasoningTokens: 80,
            runCount: 3,
            totalTokens: 800
          }
        ],
        reasoningTokens: 80,
        runCount: 3,
        totalTokens: 800,
        userId: "active-1"
      },
      {
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        displayName: "Admin User",
        email: "admin@example.com",
        groups: [],
        inputTokens: 0,
        lastUsedAt: null,
        outputTokens: 0,
        providerModels: [],
        reasoningTokens: 0,
        runCount: 0,
        totalTokens: 0,
        userId: "admin-1"
      }
    ],
    totals: {
      cachedInputTokens: 40,
      cacheWriteInputTokens: 5,
      inputTokens: 300,
      lastUsedAt: "2026-06-14T12:00:00.000Z",
      outputTokens: 500,
      reasoningTokens: 80,
      runCount: 3,
      totalTokens: 800
    }
  },
  users: [
    {
      deletion: {
        canDelete: false,
        reason: "active_user",
        summary: "Disable this user before deletion can be considered."
      },
      displayName: "Admin User",
      effectiveEntitlements: {
        models: [],
        providers: [],
        searchStrategies: []
      },
      email: "admin@example.com",
      groups: [],
      hasVerifiedIdentity: true,
      id: "admin-1",
      lastSessionAt: null,
      role: "admin",
      status: "active"
    },
    {
      deletion: {
        canDelete: true,
        reason: null,
        summary: "No app-owned records detected; auth request data can be removed."
      },
      displayName: "Pending User",
      effectiveEntitlements: {
        models: [],
        providers: [],
        searchStrategies: []
      },
      email: "pending@example.com",
      groups: [],
      hasVerifiedIdentity: true,
      id: "pending-1",
      lastSessionAt: null,
      role: "user",
      status: "pending"
    },
    {
      deletion: {
        canDelete: false,
        reason: "active_user",
        summary: "Disable this user before deletion can be considered."
      },
      displayName: "Active User",
      effectiveEntitlements: {
        models: [
          {
            modelId: "gpt-5.5",
            provider: "openai"
          }
        ],
        providers: [],
        searchStrategies: ["openai-native-web-search"]
      },
      email: "active@example.com",
      groups: [
        {
          groupId: "group-1",
          name: "operators",
          role: "member"
        }
      ],
      hasVerifiedIdentity: true,
      id: "active-1",
      lastSessionAt: null,
      role: "user",
      status: "active"
    }
  ]
};

const emptyDashboard: AdminDashboard = {
  ...dashboard,
  accessRules: [],
  groups: [],
  invites: [],
  navigation: {
    advancedConfigured: false,
    attention: {
      activeUsersWithoutModelAccess: 0,
      openInvites: 0,
      pendingUsers: 0
    },
    teamConfigured: false
  },
  usage: {
    byGroup: [],
    byUser: [],
    totals: {
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      inputTokens: 0,
      lastUsedAt: null,
      outputTokens: 0,
      reasoningTokens: 0,
      runCount: 0,
      totalTokens: 0
    }
  },
  users: []
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return {
    promise,
    reject,
    resolve
  };
}

function must<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`Missing test fixture: ${label}`);
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRequestRecord(body: string): Record<string, unknown> {
  const value: unknown = JSON.parse(body);

  if (!isRecord(value)) {
    throw new Error("Expected an admin request object");
  }

  return value;
}

function dashboardResponse(value: unknown = dashboard, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status
  });
}

function mockDashboardFetch(value: unknown = dashboard) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(dashboardResponse(value));
}

function mockAdminFetch() {
  const posts: Record<string, unknown>[] = [];
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url === "/api/admin") {
      return new Response(JSON.stringify(dashboard), {
        status: 200
      });
    }

    if (url === "/api/admin/providers/quick-setup" && (init?.method ?? "GET") === "GET") {
      return dashboardResponse({
        providers: [
          { provider: "openai", providerDisplayName: "OpenAI", state: "not_configured", stateToken: "state-openai" },
          { provider: "anthropic", providerDisplayName: "Anthropic", state: "not_configured", stateToken: "state-anthropic" },
          { provider: "openrouter", providerDisplayName: "OpenRouter", state: "not_configured", stateToken: "state-openrouter" }
        ],
        suggestedProvider: null
      });
    }

    if (url === "/api/admin/action" && init?.body && typeof init.body === "string") {
      const body = parseRequestRecord(init.body);
      posts.push(body);

      return new Response(
        JSON.stringify(
          body.action === "create_invite"
            ? {
                emailDelivery: "sent",
                inviteUrl: "https://aiqsa.local/login?invite=test-token"
              }
            : {
                ok: true
              }
        ),
        {
          status: 200
        }
      );
    }

    return new Response(JSON.stringify({ error: "unexpected_request" }), {
      status: 500
    });
  });

  return {
    fetch,
    posts
  };
}

async function findUserListItem(text: string): Promise<HTMLElement> {
  const matches = await screen.findAllByText(text);
  const row = matches
    .map((match) => match.closest<HTMLElement>('[data-testid="admin-user-row"]'))
    .find((element): element is HTMLElement => element !== null);

  if (!row) {
    throw new Error(`Could not find a user list item for ${text}`);
  }

  return row;
}

function findResourceListItem(scope: HTMLElement, text: string): HTMLElement {
  const row = within(scope)
    .getAllByText(text)
    .map((match) => match.closest<HTMLElement>([
      '[data-testid="admin-user-row"]',
      '[data-testid="admin-group"]',
      '[data-testid="admin-invite-row"]',
      '[data-testid="admin-access-rule-row"]'
    ].join(",")))
    .find((element): element is HTMLElement => element !== null);

  if (!row) {
    throw new Error(`Could not find a resource list item for ${text}`);
  }

  return row;
}

describe("AdminPanel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  it("provides an explicit direct return to the authenticated chat", async () => {
    mockAdminFetch();
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    expect(screen.getByRole("heading", { name: "Control Center" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Return to chat" })).toHaveAttribute("href", "/");
    await screen.findByTestId("admin-section-users");
  });

  it("opens the database-backed Email delivery section from shared navigation", async () => {
    const email: AdminEmailState = {
      active: {
        activatedAt: null,
        activatedByUserId: null,
        configuration: null,
        enabled: false,
        passwordConfigured: false,
        version: 0
      },
      configurationUpdatedAt: null,
      configurationUpdatedByUserId: null,
      draft: { configuration: null, passwordConfigured: false, test: null, version: 0 },
      health: {
        activeVersion: null,
        degraded: false,
        lastAcceptedAt: null,
        lastAttemptAt: null,
        lastFailureAt: null,
        lastFailureCode: null
      }
    };
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "/api/admin") return dashboardResponse();
      if (url === "/api/admin/email") return dashboardResponse({ email });
      return dashboardResponse({ error: "unexpected_request" }, 500);
    });

    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);
    await screen.findByTestId("admin-section-users");
    fireEvent.click(screen.getByRole("tab", { name: "Email delivery" }));

    const section = await screen.findByTestId("admin-section-email");
    expect(within(section).getByRole("heading", { name: "Email tasks" })).toBeInTheDocument();
    expect(within(section).getByRole("button", { name: /Draft configuration/ })).toBeInTheDocument();
    expect(within(section).getAllByText("Not configured").length).toBeGreaterThan(0);
    expect(fetch).toHaveBeenCalledWith("/api/admin/email", { method: "GET" });
  });

  it("announces loading without presenting zero-value dashboard state as current data", async () => {
    const request = deferred<Response>();
    vi.spyOn(globalThis, "fetch").mockReturnValue(request.promise);

    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    const main = screen.getByRole("main");
    const activity = screen.getByText("Refreshing…").closest('[role="status"]');
    expect(main).toHaveAttribute("aria-busy", "true");
    expect(activity).toHaveAttribute("aria-live", "polite");
    expect(activity).toHaveTextContent("Refreshing…");
    expect(screen.getByText("Loading admin data")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Admin summary" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Needs attention" })).not.toBeInTheDocument();

    await act(async () => {
      request.resolve(dashboardResponse());
      await request.promise;
    });

    expect((await screen.findAllByText("Active User")).length).toBeGreaterThan(0);
    await waitFor(() => expect(main).toHaveAttribute("aria-busy", "false"));
    expect(screen.queryByRole("region", { name: "Admin summary" })).not.toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "Control Center sections" })).toBeInTheDocument();
  });

  it("distinguishes an unavailable dashboard from an intentional empty dashboard", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      dashboardResponse(
        {
          error: "admin_dashboard_failed"
        },
        503
      )
    );
    const view = render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    const failure = await screen.findByRole("alert");
    expect(failure).toHaveTextContent(/admin data (?:could not|couldn't) be loaded/i);
    expect(failure).not.toHaveTextContent("admin_dashboard_failed");
    expect(screen.getByText("Admin data unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Admin summary" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Needs attention" })).not.toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveAttribute("aria-busy", "false");

    view.unmount();
    fetch.mockResolvedValue(dashboardResponse(emptyDashboard));
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    expect(await screen.findByText("No users yet")).toBeInTheDocument();
    expect(screen.queryByText("Admin data unavailable")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Admin summary" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Needs attention" })).not.toBeInTheDocument();
    expect(screen.queryByText(/no current .* need attention/i)).not.toBeInTheDocument();
  });

  it("keeps only the latest initial dashboard and modal focus behavior under Strict Mode", async () => {
    const firstRequest = deferred<Response>();
    const secondRequest = deferred<Response>();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(secondRequest.promise);
    render(
      <StrictMode>
        <AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />
      </StrictMode>
    );
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));

    secondRequest.resolve(dashboardResponse(dashboard));
    await findUserListItem("Active User");
    firstRequest.resolve(dashboardResponse(emptyDashboard));
    await act(async () => firstRequest.promise);
    expect(screen.queryByText("No users yet")).not.toBeInTheDocument();

    const row = await findUserListItem("Active User");
    fireEvent.click(within(row).getByRole("button", { name: "Details" }));
    const detail = await screen.findByTestId("admin-user-detail");
    await waitFor(() => expect(detail).toHaveFocus());
    const opener = within(detail).getByRole("button", { name: "Disable user" });
    opener.focus();
    fireEvent.click(opener);
    const confirmation = await screen.findByTestId("admin-confirm-disable-user");
    fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("renders tabbed admin sections and restores a deep-linked section", async () => {
    mockAdminFetch();
    window.history.replaceState(null, "", "/admin?section=invites");
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    expect(await screen.findByTestId("admin-section-invites")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Users" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Usage" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Groups" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Model access" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "MCP servers" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Invites" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Invites" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: "Users" })).toHaveAttribute("tabindex", "-1");
    for (const tab of screen.getAllByRole("tab")) {
      const panelId = tab.getAttribute("aria-controls");
      expect(panelId).toBeTruthy();
      expect(document.getElementById(must(panelId, "tab panel id"))).toBeInTheDocument();
    }
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);

    fireEvent.keyDown(screen.getByRole("tab", { name: "Invites" }), { key: "ArrowRight" });
    await waitFor(() => expect(screen.getByRole("tab", { name: "Access rules" })).toHaveFocus());
    expect(screen.getByRole("tab", { name: "Access rules" })).toHaveAttribute("aria-selected", "true");
    expect(window.location.search).toBe("?section=access-rules");

    fireEvent.keyDown(screen.getByRole("tab", { name: "Access rules" }), { key: "Home" });
    await waitFor(() => expect(screen.getByRole("tab", { name: "Providers" })).toHaveFocus());
    expect(screen.getByRole("tab", { name: "Providers" })).toHaveAttribute("aria-selected", "true");
    expect(window.location.search).toBe("?section=providers");

    window.history.pushState(null, "", "/admin?section=safety");
    fireEvent.popState(window);
    expect(screen.getByRole("tab", { name: "Safety" })).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(screen.getByRole("tab", { name: "Safety" }), { key: "End" });
    await waitFor(() => expect(screen.getByRole("tab", { name: "Safety" })).toHaveFocus());
    expect(window.location.search).toBe("?section=safety");
  });

  it("switches compact composition between one active task and the grouped section index", async () => {
    mockAdminFetch();
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    const users = await screen.findByTestId("admin-section-users");
    expect(screen.getByTestId("admin-section-index-pane")).toHaveClass("hidden");
    expect(screen.getByTestId("admin-active-task-pane")).toHaveClass("block");
    expect(within(users).getByTestId("admin-user-detail")).toBeInTheDocument();
    expect(users.querySelector('[data-admin-renderer="replacement"]')).toBeInTheDocument();
    expect(users.querySelector('[data-admin-renderer="legacy-embedded"]')).not.toBeInTheDocument();

    fireEvent.click(within(users).getByRole("button", { name: "All sections" }));
    expect(screen.getByTestId("admin-section-index-pane")).toHaveClass("block");
    expect(screen.getByTestId("admin-active-task-pane")).toHaveClass("hidden");

    fireEvent.click(screen.getByRole("tab", { name: "Usage" }));
    const usage = await screen.findByTestId("admin-section-usage");
    expect(screen.getByTestId("admin-section-index-pane")).toHaveClass("hidden");
    expect(screen.getByTestId("admin-active-task-pane")).toHaveClass("block");
    expect(usage.querySelector('[data-admin-renderer="replacement"]')).toBeInTheDocument();

    fireEvent.click(within(usage).getByRole("button", { name: "All sections" }));
    fireEvent.click(screen.getByRole("tab", { name: "Providers" }));
    const providers = await screen.findByTestId("admin-section-providers");
    expect(providers.querySelector('[data-admin-renderer="replacement"]')).toBeInTheDocument();
    expect(providers.querySelector('[data-admin-renderer="legacy-embedded"]')).not.toBeInTheDocument();
    fireEvent.click(within(providers).getByRole("button", { name: "Advanced configuration" }));
    expect(providers.querySelector('[data-admin-renderer="legacy-embedded"]')).not.toBeInTheDocument();
    expect(await within(providers).findByRole("alert")).toHaveTextContent("Provider connections could not be loaded");
  });

  it("preserves operational drafts, filters, and selections across section round trips", async () => {
    mockAdminFetch();
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    const users = await screen.findByTestId("admin-section-users");
    fireEvent.change(within(users).getByLabelText("Search users"), { target: { value: "user" } });
    fireEvent.click(within(users).getByRole("button", { name: "active" }));
    const activeUserRow = findResourceListItem(users, "active@example.com");
    fireEvent.click(within(activeUserRow).getByRole("button", { name: "Details" }));

    fireEvent.click(screen.getByRole("tab", { name: "Groups" }));
    const groups = await screen.findByTestId("admin-section-groups");
    fireEvent.change(within(groups).getByLabelText("Search groups"), { target: { value: "er" } });
    fireEvent.click(within(groups).getByRole("button", { name: "all" }));
    const reviewersRow = findResourceListItem(groups, "reviewers");
    fireEvent.click(within(reviewersRow).getByRole("button", { name: "Details" }));
    fireEvent.click(within(screen.getByTestId("admin-group-detail")).getByRole("button", { name: "Rename group" }));
    fireEvent.change(within(groups).getByLabelText("Rename group"), { target: { value: "Operators draft" } });
    fireEvent.click(within(groups).getByRole("button", { name: "New group" }));
    fireEvent.change(within(groups).getByLabelText("Group name"), { target: { value: "Draft group" } });

    fireEvent.click(screen.getByRole("tab", { name: "Usage" }));
    fireEvent.click(screen.getByRole("tab", { name: "Groups" }));
    expect(screen.getByLabelText("Group name")).toHaveValue("Draft group");
    fireEvent.click(within(screen.getByTestId("admin-section-groups")).getByRole("button", { name: "Back to groups" }));
    expect(screen.getByLabelText("Rename group")).toHaveValue("Operators draft");

    fireEvent.click(screen.getByRole("tab", { name: "Model access" }));
    const modelAccess = await screen.findByTestId("admin-section-model-access");
    fireEvent.change(within(modelAccess).getByLabelText("Search model access groups"), {
      target: { value: "er" }
    });
    fireEvent.click(within(modelAccess).getByRole("button", { name: "Select reviewers" }));

    fireEvent.click(screen.getByRole("tab", { name: "Invites" }));
    const invites = await screen.findByTestId("admin-section-invites");
    fireEvent.click(within(invites).getByRole("button", { name: "New invite" }));
    fireEvent.change(within(invites).getByLabelText("Email"), { target: { value: "draft@example.com" } });
    fireEvent.click(within(invites).getByRole("checkbox", { name: "reviewers" }));
    fireEvent.change(within(invites).getByLabelText("Search invites"), { target: { value: "open" } });
    fireEvent.click(within(invites).getByRole("button", { name: "open" }));

    fireEvent.click(screen.getByRole("tab", { name: "Access rules" }));
    const rules = await screen.findByTestId("admin-section-access-rules");
    fireEvent.click(within(rules).getByRole("button", { name: "New rule" }));
    fireEvent.change(within(rules).getByLabelText("Kind"), { target: { value: "domain" } });
    fireEvent.change(within(rules).getByLabelText("Value"), { target: { value: "@Example.com" } });
    fireEvent.click(within(rules).getByRole("checkbox", { name: "reviewers" }));
    fireEvent.change(within(rules).getByLabelText("Search access rules"), { target: { value: "allowed" } });

    fireEvent.click(screen.getByRole("tab", { name: "Users" }));
    expect(screen.getByLabelText("Search users")).toHaveValue("user");
    expect(screen.getByRole("button", { name: "active" })).toHaveAttribute("aria-pressed", "true");
    expect(within(screen.getByTestId("admin-user-detail")).getByText("active@example.com")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Groups" }));
    expect(screen.getByLabelText("Search groups")).toHaveValue("er");
    expect(screen.getByRole("button", { name: "all" })).toHaveAttribute("aria-pressed", "true");
    expect(within(screen.getByTestId("admin-group-detail")).getByText("reviewers")).toBeInTheDocument();
    expect(screen.getByLabelText("Rename group")).toHaveValue("Operators draft");
    fireEvent.click(within(screen.getByTestId("admin-section-groups")).getByRole("button", { name: "New group" }));
    expect(screen.getByLabelText("Group name")).toHaveValue("Draft group");

    fireEvent.click(screen.getByRole("tab", { name: "Model access" }));
    expect(screen.getByLabelText("Search model access groups")).toHaveValue("er");
    expect(screen.getByRole("button", { name: "Select reviewers" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("tab", { name: "Invites" }));
    expect(screen.getByLabelText("Email")).toHaveValue("draft@example.com");
    expect(screen.getByRole("checkbox", { name: "reviewers" })).toBeChecked();
    expect(screen.getByLabelText("Search invites")).toHaveValue("open");
    expect(screen.getByRole("button", { name: "open" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("tab", { name: "Access rules" }));
    expect(screen.getByLabelText("Kind")).toHaveValue("domain");
    expect(screen.getByLabelText("Value")).toHaveValue("@Example.com");
    expect(screen.getByText("example.com", { selector: "span" })).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "reviewers" })).toBeChecked();
    expect(screen.getByLabelText("Search access rules")).toHaveValue("allowed");
  });

  it("drops draft group ids that become archived before approval, invite, or rule submission", async () => {
    const refreshedDashboard = structuredClone(dashboard);
    const reviewers = must(
      refreshedDashboard.groups.find((group) => group.id === "group-2"),
      "reviewers group"
    );
    reviewers.archivedAt = "2026-07-12T00:00:00.000Z";
    const posts: Record<string, unknown>[] = [];
    let dashboardRequests = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url === "/api/admin") {
        const value = dashboardRequests === 0 ? dashboard : refreshedDashboard;
        dashboardRequests += 1;
        return dashboardResponse(value);
      }

      if (url === "/api/admin/action" && init?.body && typeof init.body === "string") {
        const body = parseRequestRecord(init.body);
        posts.push(body);
        return dashboardResponse(
          body.action === "create_invite"
            ? { emailDelivery: "sent", inviteUrl: "https://aiqsa.local/invite/new" }
            : { ok: true }
        );
      }

      return dashboardResponse({ error: "unexpected_request" }, 500);
    });
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    const pendingRow = await findUserListItem("Pending User");
    fireEvent.click(within(pendingRow).getByRole("button", { name: "Review" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "reviewers" }));

    fireEvent.click(screen.getByRole("tab", { name: "Invites" }));
    fireEvent.click(screen.getByRole("button", { name: "New invite" }));
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "draft@example.com" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "reviewers" }));

    fireEvent.click(screen.getByRole("tab", { name: "Access rules" }));
    fireEvent.click(screen.getByRole("button", { name: "New rule" }));
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "allowed-2@example.com" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "reviewers" }));

    fireEvent.click(screen.getByRole("button", { name: "Refresh Control Center" }));
    await waitFor(() => expect(screen.queryByRole("checkbox", { name: "reviewers" })).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Save rule" }));
    await waitFor(() =>
      expect(posts).toContainEqual({
        action: "create_access_rule",
        groupIds: [],
        kind: "email",
        value: "allowed-2@example.com"
      })
    );

    fireEvent.click(screen.getByRole("tab", { name: "Invites" }));
    expect(screen.getByLabelText("Email")).toHaveValue("draft@example.com");
    expect(screen.queryByRole("checkbox", { name: "reviewers" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create invite" }));
    await waitFor(() =>
      expect(posts).toContainEqual({
        action: "create_invite",
        email: "draft@example.com",
        groupIds: [],
        sendEmail: true
      })
    );

    fireEvent.click(screen.getByRole("tab", { name: "Users" }));
    expect(screen.queryByRole("checkbox", { name: "reviewers" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve user" }));
    await waitFor(() =>
      expect(posts).toContainEqual({
        action: "approve_user",
        groupIds: [],
        userId: "pending-1"
      })
    );
  });

  it("keeps global session reset scoped to Safety", async () => {
    mockAdminFetch();
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    await screen.findByTestId("admin-section-users");
    expect(screen.queryByRole("button", { name: "Revoke all sessions" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Safety" }));
    expect(screen.getByRole("button", { name: "Revoke all sessions" })).toBeInTheDocument();
  });

  it("renders read-only usage by group and user", async () => {
    mockAdminFetch();
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    await screen.findByTestId("admin-section-users");
    fireEvent.click(screen.getByRole("tab", { name: "Usage" }));
    const usage = await screen.findByTestId("admin-section-usage");
    const groups = within(usage).getByTestId("admin-usage-groups");
    const users = within(usage).getByTestId("admin-usage-users");
    const mobileGroups = within(groups).getByTestId("admin-usage-groups-mobile");
    const mobileUsers = within(users).getByTestId("admin-usage-users-mobile");

    expect(within(usage).getByText("Total tokens")).toBeInTheDocument();
    expect(within(mobileGroups).getByText("operators")).toBeInTheDocument();
    expect(within(mobileGroups).getByText("reviewers")).toBeInTheDocument();
    expect(within(mobileUsers).getByText("Active User")).toBeInTheDocument();
    expect(within(mobileUsers).getByText(/OpenAI \/ GPT 5\.5/)).toBeInTheDocument();
    expect(within(mobileUsers).getByText("No reported usage")).toBeInTheDocument();
    expect(within(usage).queryByText(/cost/i)).not.toBeInTheDocument();
  });

  it("keeps primary admin workflows list-led while bounding analytical tables", async () => {
    mockAdminFetch();
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    await screen.findByTestId("admin-section-users");

    function expectBoundedComparisonTable(name: string): HTMLElement {
      const region = screen.getByRole("region", { name });
      expect(region).toHaveAttribute("tabindex", "0");
      expect(within(region).getByRole("table")).toBeInTheDocument();
      return region;
    }

    const users = screen.getByTestId("admin-section-users");
    expect(within(users).queryByRole("table")).not.toBeInTheDocument();
    const sort = within(users).getByLabelText("Sort users");
    expect(sort).toHaveValue("user");
    fireEvent.change(sort, { target: { value: "status" } });
    expect(sort).toHaveValue("status");
    const direction = within(users).getByRole("button", { name: "Asc" });
    fireEvent.click(direction);
    expect(within(users).getByRole("button", { name: "Desc" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Usage" }));
    expectBoundedComparisonTable("Group usage table");
    expectBoundedComparisonTable("User usage table");

    fireEvent.click(screen.getByRole("tab", { name: "Groups" }));
    expect(screen.getByTestId("admin-groups-index")).toBeInTheDocument();
    expect(screen.getByTestId("admin-groups-detail-pane")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Groups table" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Model access" }));
    expect(screen.getByTestId("admin-model-access-group-list")).toBeInTheDocument();
    expect(screen.getByTestId("admin-model-access-detail-pane")).toBeInTheDocument();
    expect(screen.getByTestId("admin-section-model-access").querySelector("table")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Invites" }));
    expect(screen.getByTestId("admin-invites-index")).toBeInTheDocument();
    expect(screen.getByTestId("admin-invites-detail-pane")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Access rules" }));
    expect(screen.getByTestId("admin-access-rules-index")).toBeInTheDocument();
    expect(screen.getByTestId("admin-access-rules-detail-pane")).toBeInTheDocument();
  });

  it("keeps focus on the selected Model access group", async () => {
    mockAdminFetch();
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    await screen.findByTestId("admin-section-users");
    fireEvent.click(screen.getByRole("tab", { name: "Model access" }));
    const modelAccess = await screen.findByTestId("admin-section-model-access");
    const list = within(modelAccess).getByTestId("admin-model-access-group-list");
    expect(within(list).getByRole("button", { name: "Select operators" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(within(list).getByLabelText("Search model access groups"), {
      target: {
        value: "reviewers"
      }
    });
    const reviewersButton = within(list).getByRole("button", { name: "Select reviewers" });
    expect(reviewersButton).toHaveAttribute("aria-pressed", "true");

    const selectedContext = within(modelAccess).getByTestId("admin-model-access-group");
    expect(selectedContext).toHaveAttribute("aria-label", "Model access for reviewers");
    expect(within(selectedContext).getByText("reviewers")).toBeInTheDocument();
    reviewersButton.focus();
    fireEvent.click(reviewersButton);
    await waitFor(() => expect(reviewersButton).toHaveFocus());
    expect(selectedContext).not.toHaveFocus();
  });

  it("approves a pending user with selected groups", async () => {
    const { posts } = mockAdminFetch();
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    const row = await findUserListItem("Pending User");
    fireEvent.click(within(row).getByRole("button", { name: "Review" }));
    const detail = await screen.findByTestId("admin-user-detail");
    fireEvent.click(within(detail).getByLabelText("operators"));
    fireEvent.click(within(detail).getByRole("button", { name: "Approve user" }));

    await waitFor(() => {
      expect(posts).toContainEqual({
        action: "approve_user",
        groupIds: ["group-1"],
        userId: "pending-1"
      });
    });
  });

  it("updates active user memberships", async () => {
    const { posts } = mockAdminFetch();
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    const row = await findUserListItem("Active User");
    fireEvent.click(within(row).getByRole("button", { name: "Details" }));
    const detail = await screen.findByTestId("admin-user-detail");
    await waitFor(() => {
      expect(detail).toHaveFocus();
    });
    fireEvent.click(within(detail).getByLabelText("reviewers"));
    fireEvent.click(within(detail).getByRole("button", { name: "Save groups" }));

    await waitFor(() => {
      expect(posts).toContainEqual({
        action: "set_user_groups",
        groupIds: ["group-1", "group-2"],
        userId: "active-1"
      });
    });
  });

  it("focuses selected user details from list actions and returns to the list", async () => {
    mockAdminFetch();
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    const row = await findUserListItem("Active User");
    fireEvent.click(within(row).getByRole("button", { name: "Details" }));

    const detail = await screen.findByTestId("admin-user-detail");
    expect(within(detail).getByText("Active User")).toBeInTheDocument();
    await waitFor(() => {
      expect(detail).toHaveFocus();
    });
    fireEvent.click(within(detail).getByRole("button", { name: "Back to users" }));
    expect(screen.getByTestId("admin-users-index")).toHaveClass("block");
    expect(screen.getByTestId("admin-users-detail-pane")).toHaveClass("hidden");
  });

  it("creates groups and toggles group grants", async () => {
    const { posts } = mockAdminFetch();
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    await screen.findByTestId("admin-section-users");
    fireEvent.click(screen.getByRole("tab", { name: "Groups" }));
    const groups = await screen.findByTestId("admin-section-groups");
    fireEvent.click(within(groups).getByRole("button", { name: "New group" }));
    fireEvent.change(within(groups).getByLabelText("Group name"), {
      target: {
        value: "review team"
      }
    });
    fireEvent.click(within(groups).getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(posts).toContainEqual({
        action: "create_group",
        name: "review team"
      });
    });
    const successNotice = await screen.findByText("Group created.");
    const liveNotice = successNotice.closest('[role="status"]');
    expect(liveNotice).toHaveAttribute("aria-live", "polite");

    fireEvent.click(screen.getByRole("tab", { name: "Model access" }));
    const modelAccess = await screen.findByTestId("admin-section-model-access");
    fireEvent.click(must(within(modelAccess).getAllByLabelText("Grant model OpenAI / GPT 5.5")[0], "model grant"));
    await waitFor(() => {
      expect(posts).toContainEqual({
        action: "set_group_grant",
        enabled: true,
        groupId: "group-1",
        modelId: "gpt-5.5",
        provider: "openai"
      });
    });
  });

  it("selects and filters group detail state", async () => {
    mockAdminFetch();
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    await screen.findByTestId("admin-section-users");
    fireEvent.click(screen.getByRole("tab", { name: "Groups" }));
    const groups = await screen.findByTestId("admin-section-groups");
    fireEvent.change(within(groups).getByLabelText("Search groups"), {
      target: {
        value: "reviewers"
      }
    });
    const row = findResourceListItem(groups, "reviewers");
    fireEvent.click(within(row).getByRole("button", { name: "Details" }));

    const detail = await screen.findByTestId("admin-group-detail");
    expect(within(detail).getByText("reviewers")).toBeInTheDocument();
    expect(within(detail).getByText("No provider, model, or search access.")).toBeInTheDocument();
    await waitFor(() => {
      expect(detail).toHaveFocus();
    });
    expect(within(groups).queryByText("operators")).not.toBeInTheDocument();
  });

  it("shows archived groups as non-editable in group and grant surfaces", async () => {
    mockAdminFetch();
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    await screen.findByTestId("admin-section-users");
    fireEvent.click(screen.getByRole("tab", { name: "Groups" }));
    const groups = await screen.findByTestId("admin-section-groups");
    fireEvent.click(within(groups).getByRole("button", { name: "all" }));
    const archivedRow = findResourceListItem(groups, "legacy-archive");
    fireEvent.click(within(archivedRow).getByRole("button", { name: "Details" }));
    const detail = await screen.findByTestId("admin-group-detail");

    expect(within(detail).getByText("Archived groups remain visible for history. Their grants no longer apply, and grant editing is disabled.")).toBeInTheDocument();
    expect(within(detail).queryByRole("button", { name: "Archive group" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Model access" }));
    const modelAccess = await screen.findByTestId("admin-section-model-access");
    const list = within(modelAccess).getByTestId("admin-model-access-group-list");
    fireEvent.click(within(list).getByRole("button", { name: "Select legacy-archive" }));

    expect(within(modelAccess).getByText("Archived groups do not apply grants. Grant editing is disabled for this group.")).toBeInTheDocument();
    expect(within(modelAccess).getByLabelText("Grant provider OpenAI")).toBeDisabled();
    expect(within(modelAccess).getByLabelText("Grant model OpenAI / GPT 5.5")).toBeDisabled();
  });

  it("toggles provider-wide and search strategy grants for the selected group", async () => {
    const { posts } = mockAdminFetch();
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    await screen.findByTestId("admin-section-users");
    fireEvent.click(screen.getByRole("tab", { name: "Model access" }));
    const modelAccess = await screen.findByTestId("admin-section-model-access");
    fireEvent.click(within(modelAccess).getByLabelText("Grant provider OpenAI"));

    await waitFor(() => {
      expect(posts).toContainEqual({
        action: "set_group_grant",
        enabled: true,
        groupId: "group-1",
        provider: "openai"
      });
    });

    fireEvent.click(within(modelAccess).getByLabelText("Grant search OpenAI web search"));

    await waitFor(() => {
      expect(posts).toContainEqual({
        action: "set_group_grant",
        enabled: true,
        groupId: "group-1",
        searchStrategy: "openai-native-web-search"
      });
    });
  });

  it("bulk grants provider models for the selected group", async () => {
    const { posts } = mockAdminFetch();
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    await screen.findByTestId("admin-section-users");
    fireEvent.click(screen.getByRole("tab", { name: "Model access" }));
    const modelAccess = await screen.findByTestId("admin-section-model-access");
    fireEvent.click(within(modelAccess).getByRole("button", { name: "Grant all OpenAI models to operators" }));

    await waitFor(() => {
      expect(posts).toContainEqual({
        action: "set_group_grant",
        enabled: true,
        groupId: "group-1",
        modelId: "gpt-5.5",
        provider: "openai"
      });
      expect(posts).toContainEqual({
        action: "set_group_grant",
        enabled: true,
        groupId: "group-1",
        modelId: "gpt-mini",
        provider: "openai"
      });
    });
  });

  it("wraps long operator labels without exposing opaque model identifiers", async () => {
    const longEmail =
      "operator.with.a.deliberately.long.unbroken.identity.for.compact.admin.testing@subdomain.with-a-deliberately-long-name.example.com";
    const longGroupName =
      "operations-reviewers-with-a-deliberately-long-unbroken-group-name-for-compact-layout-verification";
    const longModelId =
      "gpt-enterprise-preview-with-a-deliberately-long-unbroken-model-identifier-for-admin-grants";
    const longDashboard = structuredClone(dashboard);
    must(longDashboard.users[2], "long-id user").email = longEmail;
    must(longDashboard.groups[0], "long-id group").name = longGroupName;
    must(longDashboard.catalog.models[0], "long-id model").modelId = longModelId;
    mockDashboardFetch(longDashboard);

    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    const usersList = await screen.findByTestId("admin-users-list");
    const email = within(usersList).getByText(longEmail);
    expect(email).toHaveClass("break-words", "[overflow-wrap:anywhere]");

    fireEvent.click(screen.getByRole("tab", { name: "Model access" }));
    const modelAccess = await screen.findByTestId("admin-section-model-access");
    const selectedContext = within(modelAccess).getByTestId("admin-model-access-group");
    expect(within(selectedContext).getByRole("heading", { name: longGroupName })).toHaveClass(
      "break-words",
      "[overflow-wrap:anywhere]"
    );
    expect(within(modelAccess).getByText("GPT 5.5")).toBeVisible();
    expect(within(modelAccess).queryByText(`openai:${longModelId}`)).not.toBeInTheDocument();
  });

  it("creates invites and shows the returned link", async () => {
    const { posts } = mockAdminFetch();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText
      }
    });
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    await screen.findByTestId("admin-section-users");
    fireEvent.click(screen.getByRole("tab", { name: "Invites" }));
    const invites = await screen.findByTestId("admin-section-invites");
    fireEvent.click(within(invites).getByRole("button", { name: "New invite" }));
    expect(within(invites).getByRole("group", { name: "Default groups" })).toBeInTheDocument();
    expect(within(invites).getByRole("checkbox", { name: "Send invitation email" })).toBeChecked();
    fireEvent.change(within(invites).getByLabelText("Email"), {
      target: {
        value: "friend@example.com"
      }
    });
    fireEvent.click(within(invites).getByRole("button", { name: "Create invite" }));

    await waitFor(() => {
      expect(posts).toContainEqual({
        action: "create_invite",
        email: "friend@example.com",
        groupIds: [],
        sendEmail: true
      });
    });
    expect(await screen.findByText("Invite created and email sent.")).toHaveAttribute("role", "status");
    expect(await within(invites).findByDisplayValue("https://aiqsa.local/login?invite=test-token")).toBeInTheDocument();
    fireEvent.click(within(invites).getByRole("button", { name: "Copy" }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("https://aiqsa.local/login?invite=test-token");
    });
    expect(await within(invites).findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("clears a clipboard failure when retrying the one-time invite copy succeeds", async () => {
    mockAdminFetch();
    const inviteLink = "https://aiqsa.local/login?invite=test-token";
    const writeText = vi
      .fn()
      .mockRejectedValueOnce(new Error("blocked"))
      .mockResolvedValueOnce(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText
      }
    });
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    await screen.findByTestId("admin-section-users");
    fireEvent.click(screen.getByRole("tab", { name: "Invites" }));
    const invites = await screen.findByTestId("admin-section-invites");
    fireEvent.click(within(invites).getByRole("button", { name: "New invite" }));
    fireEvent.change(within(invites).getByLabelText("Email"), {
      target: {
        value: "retry@example.com"
      }
    });
    fireEvent.click(within(invites).getByRole("button", { name: "Create invite" }));
    expect(await within(invites).findByDisplayValue(inviteLink)).toBeInTheDocument();

    fireEvent.click(within(invites).getByRole("button", { name: "Copy" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/invite link could not be copied/i);
    expect(within(invites).getByRole("button", { name: "Copy" })).toBeInTheDocument();

    fireEvent.click(within(invites).getByRole("button", { name: "Copy" }));
    expect(await within(invites).findByRole("button", { name: "Copied" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    const success = screen.getByText("Invite link copied.").closest('[role="status"]');
    expect(success).toHaveAttribute("aria-live", "polite");
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenNthCalledWith(1, inviteLink);
    expect(writeText).toHaveBeenNthCalledWith(2, inviteLink);
  });

  it("filters users and keeps self-protection visible", async () => {
    mockAdminFetch();
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    await screen.findByTestId("admin-section-users");
    fireEvent.change(screen.getByLabelText("Search users"), {
      target: {
        value: "admin@example.com"
      }
    });

    expect(await findUserListItem("Admin User")).toBeInTheDocument();
    expect(screen.queryByText("Active User")).not.toBeInTheDocument();
    expect(screen.getByText("You")).toBeInTheDocument();
    const detail = screen.getByTestId("admin-user-detail");
    expect(within(detail).getByText(/Self-disable and self-delete are not exposed/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Disable user" })).not.toBeInTheDocument();
  });

  it("keeps the selected user detail on the visible pagination page", async () => {
    const paginatedDashboard = structuredClone(dashboard);
    const userTemplate = structuredClone(must(dashboard.users[2], "pagination user template"));
    paginatedDashboard.users = Array.from({ length: 27 }, (_, index) => {
      const number = String(index + 1).padStart(2, "0");

      return {
        ...structuredClone(userTemplate),
        displayName: `Paged User ${number}`,
        email: `paged-${number}@example.com`,
        id: `paged-${number}`
      };
    });
    mockDashboardFetch(paginatedDashboard);
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    const users = await screen.findByTestId("admin-section-users");
    expect(within(screen.getByTestId("admin-user-detail")).getByText("Paged User 01")).toBeInTheDocument();
    fireEvent.click(within(users).getByRole("button", { name: "Next users page" }));

    const visibleRow = await findUserListItem("Paged User 26");
    await waitFor(() =>
      expect(within(screen.getByTestId("admin-user-detail")).getByText("Paged User 26")).toBeInTheDocument()
    );
    expect(visibleRow).toBeInTheDocument();
    expect(within(users).queryByText("Paged User 01")).not.toBeInTheDocument();
  });

  it("keeps actionable attention in its owning destinations without a global metric strip", async () => {
    mockAdminFetch();
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    const users = await screen.findByTestId("admin-section-users");
    expect(screen.queryByRole("region", { name: "Admin summary" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Needs attention" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Team" })).toHaveTextContent("2 items");
    expect(screen.getByRole("tab", { name: "Users" })).toHaveTextContent("1");
    expect(screen.getByRole("tab", { name: "Invites" })).toHaveTextContent("1");
    const pendingReview = within(findResourceListItem(users, "pending@example.com")).getByRole("button", {
      name: "Review"
    });
    expect(pendingReview).toBeInTheDocument();
    fireEvent.click(pendingReview);
    expect(within(users).getByText("No model access")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Invites" }));
    const invites = await screen.findByTestId("admin-section-invites");
    const openInvite = findResourceListItem(invites, "open@example.com");
    fireEvent.click(within(openInvite).getByRole("button", { name: "Details" }));
    expect(within(screen.getByTestId("admin-invite-detail")).getByRole("button", { name: "Revoke invite" })).toBeInTheDocument();
  });

  it("translates local validation and API failures without exposing raw error codes", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url === "/api/admin") {
        return dashboardResponse();
      }

      return dashboardResponse(
        {
          error: "group_has_grants"
        },
        409
      );
    });
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    await screen.findByTestId("admin-section-users");
    fireEvent.click(screen.getByRole("tab", { name: "Groups" }));
    const groups = await screen.findByTestId("admin-section-groups");
    fireEvent.click(within(groups).getByRole("button", { name: "New group" }));
    fireEvent.click(within(groups).getByRole("button", { name: "Create" }));

    let failure = await screen.findByRole("alert");
    expect(failure).toHaveTextContent(/enter a group name/i);
    expect(failure).not.toHaveTextContent("group_required");
    const groupName = within(groups).getByLabelText("Group name");
    expect(groupName).toHaveAttribute("aria-invalid", "true");
    expect(groupName).toHaveAccessibleDescription(/enter a group name/i);
    await waitFor(() => expect(groupName).toHaveFocus());

    fireEvent.click(within(groups).getByRole("button", { name: "Back to groups" }));
    const reviewersRow = findResourceListItem(groups, "reviewers");
    fireEvent.click(within(reviewersRow).getByRole("button", { name: "Details" }));
    const groupDetail = await screen.findByTestId("admin-group-detail");
    fireEvent.click(within(groupDetail).getByRole("button", { name: "Delete group" }));
    const confirmation = await screen.findByTestId("admin-confirm-delete-group");
    fireEvent.click(within(confirmation).getByRole("button", { name: /confirm delete group/i }));

    failure = await screen.findByRole("alert");
    expect(failure).toHaveTextContent("Remove active grants before deleting this group.");
    expect(failure).not.toHaveTextContent("group_has_grants");
    expect(failure.textContent).not.toMatch(/\b[a-z]+(?:_[a-z]+)+\b/);
  });

  it("associates every local create and rename validation error with its field", async () => {
    mockAdminFetch();
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    await screen.findByTestId("admin-section-users");

    fireEvent.click(screen.getByRole("tab", { name: "Invites" }));
    const invites = await screen.findByTestId("admin-section-invites");
    fireEvent.click(within(invites).getByRole("button", { name: "New invite" }));
    fireEvent.click(within(invites).getByRole("button", { name: "Create invite" }));
    const inviteEmail = within(invites).getByLabelText("Email");
    expect(inviteEmail).toHaveAttribute("aria-invalid", "true");
    expect(inviteEmail).toHaveAccessibleDescription(/email address/i);
    await waitFor(() => expect(inviteEmail).toHaveFocus());

    fireEvent.click(screen.getByRole("tab", { name: "Access rules" }));
    const rules = await screen.findByTestId("admin-section-access-rules");
    fireEvent.click(within(rules).getByRole("button", { name: "New rule" }));
    fireEvent.click(within(rules).getByRole("button", { name: "Save rule" }));
    const ruleValue = within(rules).getByLabelText("Value");
    expect(ruleValue).toHaveAttribute("aria-invalid", "true");
    expect(ruleValue).toHaveAccessibleDescription(/email or domain/i);
    await waitFor(() => expect(ruleValue).toHaveFocus());

    fireEvent.click(screen.getByRole("tab", { name: "Groups" }));
    const groups = await screen.findByTestId("admin-section-groups");
    const reviewersRow = findResourceListItem(groups, "reviewers");
    fireEvent.click(within(reviewersRow).getByRole("button", { name: "Details" }));
    const groupDetail = await screen.findByTestId("admin-group-detail");
    fireEvent.click(within(groupDetail).getByRole("button", { name: "Rename group" }));
    const renameInput = within(groupDetail).getByLabelText("Rename group");
    fireEvent.change(renameInput, { target: { value: "" } });
    fireEvent.click(within(groupDetail).getByRole("button", { name: "Save" }));
    expect(renameInput).toHaveAttribute("aria-invalid", "true");
    expect(renameInput).toHaveAccessibleDescription(/group name/i);
    await waitFor(() => expect(renameInput).toHaveFocus());
  });

  it("renders invite statuses and filters invites", async () => {
    mockAdminFetch();
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    await screen.findByTestId("admin-section-users");
    fireEvent.click(screen.getByRole("tab", { name: "Invites" }));
    const invites = await screen.findByTestId("admin-section-invites");
    const acceptedRow = findResourceListItem(invites, "accepted@example.com");
    const revokedRow = findResourceListItem(invites, "revoked@example.com");

    expect(within(invites).getByText("open@example.com")).toBeInTheDocument();
    expect(within(acceptedRow).getByText("accepted")).toBeInTheDocument();
    expect(within(revokedRow).getByText("revoked")).toBeInTheDocument();

    fireEvent.click(within(invites).getByRole("button", { name: "accepted" }));
    expect(within(invites).getByText("accepted@example.com")).toBeInTheDocument();
    expect(within(invites).queryByText("open@example.com")).not.toBeInTheDocument();
  });

  it("creates access rules with normalized preview and confirms deletion", async () => {
    const { posts } = mockAdminFetch();
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    await screen.findByTestId("admin-section-users");
    fireEvent.click(screen.getByRole("tab", { name: "Access rules" }));
    const rules = await screen.findByTestId("admin-section-access-rules");
    fireEvent.click(within(rules).getByRole("button", { name: "New rule" }));
    expect(within(rules).getByRole("group", { name: "Default groups" })).toBeInTheDocument();
    fireEvent.change(within(rules).getByLabelText("Value"), {
      target: {
        value: " PERSON@Example.COM "
      }
    });
    expect(within(rules).getByText(/person@example.com/)).toBeInTheDocument();
    fireEvent.click(within(rules).getByRole("button", { name: "Save rule" }));

    await waitFor(() => {
      expect(posts).toContainEqual({
        action: "create_access_rule",
        groupIds: [],
        kind: "email",
        value: "person@example.com"
      });
    });

    const ruleItem = findResourceListItem(rules, "allowed@example.com");
    fireEvent.click(within(ruleItem).getByRole("button", { name: "Details" }));
    const ruleDetail = await screen.findByTestId("admin-access-rule-detail");
    fireEvent.click(within(ruleDetail).getByRole("button", { name: "Delete rule" }));
    const confirmation = await screen.findByTestId("admin-confirm-delete-access-rule");
    fireEvent.click(within(confirmation).getByRole("button", { name: /confirm delete rule/i }));

    await waitFor(() => {
      expect(posts).toContainEqual({
        action: "delete_access_rule",
        ruleId: "rule-1"
      });
    });
  });

  it("uses app-native destructive confirmations", async () => {
    const { posts } = mockAdminFetch();
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    const row = await findUserListItem("Active User");
    fireEvent.click(within(row).getByRole("button", { name: "Details" }));
    const detail = await screen.findByTestId("admin-user-detail");
    fireEvent.click(within(detail).getByRole("button", { name: "Disable user" }));
    const confirmation = await screen.findByTestId("admin-confirm-disable-user");
    expect(confirmation).toHaveTextContent("Disable active user?");
    fireEvent.click(within(confirmation).getByRole("button", { name: /confirm disable user/i }));

    await waitFor(() => {
      expect(posts).toContainEqual({
        action: "disable_user",
        userId: "active-1"
      });
    });
  });

  it("makes the admin workspace inert during confirmation and restores the opener on cancel", async () => {
    const { posts } = mockAdminFetch();
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    const row = await findUserListItem("Active User");
    fireEvent.click(within(row).getByRole("button", { name: "Details" }));
    const detail = await screen.findByTestId("admin-user-detail");
    await waitFor(() => expect(detail).toHaveFocus());
    const opener = within(detail).getByRole("button", { name: "Disable user" });
    opener.focus();
    fireEvent.click(opener);

    const workspace = screen.getByTestId("admin-console-workspace");
    expect(workspace).toHaveAttribute("aria-hidden", "true");
    expect(workspace).toHaveAttribute("inert");
    expect(await screen.findByRole("dialog", { name: "Disable active@example.com" })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("admin-confirm-disable-user")).not.toBeInTheDocument());
    expect(workspace).not.toHaveAttribute("aria-hidden");
    expect(workspace).not.toHaveAttribute("inert");
    await waitFor(() => expect(opener).toHaveFocus());

    fireEvent.click(opener);
    const confirmation = await screen.findByTestId("admin-confirm-disable-user");
    fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(opener).toHaveFocus());
    expect(posts).not.toContainEqual({
      action: "disable_user",
      userId: "active-1"
    });
  });

  it("falls back to the active tab when a confirmation opener disappears before cancel", async () => {
    mockAdminFetch();
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    const row = await findUserListItem("Active User");
    fireEvent.click(within(row).getByRole("button", { name: "Details" }));
    const detail = await screen.findByTestId("admin-user-detail");
    fireEvent.click(within(detail).getByRole("button", { name: "Disable user" }));
    const confirmation = await screen.findByTestId("admin-confirm-disable-user");

    window.history.pushState(null, "", "/admin?section=safety");
    fireEvent.popState(window);
    await waitFor(() =>
      expect(screen.getByTestId("admin-tab-safety")).toHaveAttribute("aria-selected", "true")
    );
    fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.getByRole("tab", { name: "Safety" })).toHaveFocus());
  });

  it("restores a stable section focus target when a successful delete removes its opener", async () => {
    const afterDelete = structuredClone(dashboard);
    afterDelete.users = afterDelete.users.filter((user) => user.id !== "pending-1");
    let dashboardRequests = 0;
    const posts: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url === "/api/admin") {
        const value = dashboardRequests === 0 ? dashboard : afterDelete;
        dashboardRequests += 1;
        return dashboardResponse(value);
      }

      if (url === "/api/admin/action" && init?.body && typeof init.body === "string") {
        posts.push(parseRequestRecord(init.body));
        return dashboardResponse({ ok: true });
      }

      return dashboardResponse({ error: "unexpected_request" }, 500);
    });
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    const row = await findUserListItem("Pending User");
    fireEvent.click(within(row).getByRole("button", { name: "Review" }));
    const detail = await screen.findByTestId("admin-user-detail");
    await waitFor(() => expect(detail).toHaveFocus());
    const opener = within(detail).getByRole("button", { name: "Delete stale user" });
    opener.focus();
    fireEvent.click(opener);
    const confirmation = await screen.findByTestId("admin-confirm-delete-user");
    fireEvent.click(within(confirmation).getByRole("button", { name: /confirm delete user/i }));

    await waitFor(() => expect(screen.queryByText("Pending User")).not.toBeInTheDocument());
    expect(posts).toContainEqual({
      action: "delete_user",
      userId: "pending-1"
    });
    await waitFor(() => expect(screen.getByRole("tab", { name: "Users" })).toHaveFocus());
  });

  it("restores the active operational tab when a deleted rule removes its opener", async () => {
    const afterDelete = structuredClone(dashboard);
    afterDelete.accessRules = [];
    let dashboardRequests = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url === "/api/admin") {
        const value = dashboardRequests === 0 ? dashboard : afterDelete;
        dashboardRequests += 1;
        return dashboardResponse(value);
      }

      if (url === "/api/admin/action" && init?.body && typeof init.body === "string") {
        return dashboardResponse({ ok: true });
      }

      return dashboardResponse({ error: "unexpected_request" }, 500);
    });
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    await screen.findByTestId("admin-section-users");
    fireEvent.click(screen.getByRole("tab", { name: "Access rules" }));
    const rules = await screen.findByTestId("admin-section-access-rules");
    const ruleItem = findResourceListItem(rules, "allowed@example.com");
    fireEvent.click(within(ruleItem).getByRole("button", { name: "Details" }));
    const ruleDetail = await screen.findByTestId("admin-access-rule-detail");
    const opener = within(ruleDetail).getByRole("button", { name: "Delete rule" });
    opener.focus();
    fireEvent.click(opener);
    const confirmation = await screen.findByTestId("admin-confirm-delete-access-rule");
    fireEvent.click(within(confirmation).getByRole("button", { name: /confirm delete rule/i }));

    await screen.findByText("No access rules");
    await waitFor(() => expect(screen.getByRole("tab", { name: "Access rules" })).toHaveFocus());
  });

  it("confirms stale user, empty group, and stale invite deletion actions", async () => {
    const { posts } = mockAdminFetch();
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    const pendingRow = await findUserListItem("Pending User");
    fireEvent.click(within(pendingRow).getByRole("button", { name: "Review" }));
    const pendingDetail = await screen.findByTestId("admin-user-detail");
    fireEvent.click(within(pendingDetail).getByRole("button", { name: "Delete stale user" }));
    let confirmation = await screen.findByTestId("admin-confirm-delete-user");
    fireEvent.click(within(confirmation).getByRole("button", { name: /confirm delete user/i }));

    await waitFor(() => {
      expect(posts).toContainEqual({
        action: "delete_user",
        userId: "pending-1"
      });
    });

    fireEvent.click(screen.getByRole("tab", { name: "Groups" }));
    const groups = await screen.findByTestId("admin-section-groups");
    fireEvent.change(within(groups).getByLabelText("Search groups"), {
      target: {
        value: "reviewers"
      }
    });
    const groupRow = findResourceListItem(groups, "reviewers");
    fireEvent.click(within(groupRow).getByRole("button", { name: "Details" }));
    const groupDetail = await screen.findByTestId("admin-group-detail");
    await waitFor(() => {
      expect(groupDetail).toHaveFocus();
    });
    fireEvent.click(within(groupDetail).getByRole("button", { name: "Delete group" }));
    confirmation = await screen.findByTestId("admin-confirm-delete-group");
    fireEvent.click(within(confirmation).getByRole("button", { name: /confirm delete group/i }));

    await waitFor(() => {
      expect(posts).toContainEqual({
        action: "delete_group",
        groupId: "group-2"
      });
    });

    fireEvent.click(screen.getByRole("tab", { name: "Invites" }));
    const invites = await screen.findByTestId("admin-section-invites");
    const revokedRow = findResourceListItem(invites, "revoked@example.com");
    fireEvent.click(within(revokedRow).getByRole("button", { name: "Details" }));
    fireEvent.click(within(screen.getByTestId("admin-invite-detail")).getByRole("button", { name: "Delete invite" }));
    confirmation = await screen.findByTestId("admin-confirm-delete-invite");
    fireEvent.click(within(confirmation).getByRole("button", { name: /confirm delete invite/i }));

    await waitFor(() => {
      expect(posts).toContainEqual({
        action: "delete_invite",
        inviteId: "invite-revoked"
      });
    });
  });

  it("explains blocked deletion paths", async () => {
    mockAdminFetch();
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    const activeRow = await findUserListItem("Active User");
    fireEvent.click(within(activeRow).getByRole("button", { name: "Details" }));
    expect(await screen.findByText("Disable this user before deletion can be considered.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Groups" }));
    const groups = await screen.findByTestId("admin-section-groups");
    const operatorsRow = findResourceListItem(groups, "operators");
    fireEvent.click(within(operatorsRow).getByRole("button", { name: "Details" }));
    expect(await within(screen.getByTestId("admin-group-detail")).findByText("Remove 1 member before deleting this group.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Invites" }));
    const invites = await screen.findByTestId("admin-section-invites");
    const acceptedRow = findResourceListItem(invites, "accepted@example.com");
    fireEvent.click(within(acceptedRow).getByRole("button", { name: "Details" }));
    expect(within(screen.getByTestId("admin-invite-detail")).getByText("Accepted invites are kept for audit history.")).toBeInTheDocument();
  });
});
