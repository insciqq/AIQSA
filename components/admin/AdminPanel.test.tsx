import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminDashboard } from "@/lib/contracts/admin";
import type { AdminAttention } from "@/lib/contracts/adminAttention";
import type { AdminEmailState } from "@/lib/contracts/email";
import {
  adminKnowledgeAnswerPolicyFixture,
  adminKnowledgeOperationsFixture,
  adminKnowledgeProfileFixture
} from "@/tests/support/knowledgeProfile";
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
      systemRole: null,
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
      systemRole: null,
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
      name: "archived-record",
      systemRole: null,
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

const emptyAttention: AdminAttention = {
  checkedAt: "2026-09-07T12:00:00.000Z",
  items: [],
  unavailable: []
};

const seededAttention: AdminAttention = {
  checkedAt: "2026-09-07T12:00:00.000Z",
  items: [
    {
      action: "Review users",
      code: "users_pending_approval",
      count: 1,
      detail: "pending@example.com",
      id: "users_pending_approval",
      severity: "warn",
      target: { filter: "pending", section: "users" },
      title: "Users are waiting for approval"
    },
    {
      action: "Set up email",
      code: "email_not_configured",
      count: null,
      detail: "Invites and approvals are sent by link only until SMTP is set up",
      id: "email_not_configured",
      severity: "neutral",
      target: { section: "email" },
      title: "Email delivery is not configured"
    }
  ],
  unavailable: []
};

function stubCompactViewport(width = 800) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    addEventListener: () => undefined,
    matches: query.includes("max-width: 1023px") ? width < 1024 : query.includes("max-width: 767px") ? width < 768 : false,
    media: query,
    removeEventListener: () => undefined
  }));
}

function mockAdminFetch(attention: AdminAttention = emptyAttention) {
  const posts: Record<string, unknown>[] = [];
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url === "/api/admin") {
      return new Response(JSON.stringify(dashboard), {
        status: 200
      });
    }

    if (url === "/api/admin/attention") {
      return dashboardResponse({ attention });
    }

    if (url === "/api/admin/release") {
      return dashboardResponse({ error: "unavailable" }, 503);
    }

    if (url === "/api/admin/providers/quick-setup" && (init?.method ?? "GET") === "GET") {
      return dashboardResponse({
        configuredConnections: [],
        providers: [
          { provider: "openai", providerDisplayName: "OpenAI", quickSetupAssigned: false, state: "not_configured", stateToken: "state-openai" },
          { provider: "anthropic", providerDisplayName: "Anthropic", quickSetupAssigned: false, state: "not_configured", stateToken: "state-anthropic" },
          { provider: "deepseek", providerDisplayName: "DeepSeek", quickSetupAssigned: false, state: "not_configured", stateToken: "state-deepseek" },
          { provider: "gemini", providerDisplayName: "Gemini", quickSetupAssigned: false, state: "not_configured", stateToken: "state-gemini" },
          { provider: "openrouter", providerDisplayName: "OpenRouter", quickSetupAssigned: false, state: "not_configured", stateToken: "state-openrouter" }
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
      '[data-testid="admin-access-group-row"]',
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
  beforeEach(() => {
    window.history.replaceState(null, "", "/admin?section=users");
    document.title = "Control Center · AIQSA";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
    document.title = "AIQSA";
  });

  it("uses only the active public section label in the document title", async () => {
    mockAdminFetch();
    render(<AdminPanel adminEmail="private-admin@example.com" adminUserId="private-admin-id" />);

    await screen.findByTestId("admin-section-users");
    await waitFor(() => expect(document.title).toBe("Users · Control Center · AIQSA"));
    expect(document.title).not.toContain("private-admin");

    fireEvent.click(screen.getByRole("link", { name: "Groups" }));
    await screen.findByTestId("admin-section-groups");
    await waitFor(() => expect(document.title).toBe("Groups · Control Center · AIQSA"));
  });

  it("opens the Overview by default inside the rail, section column and topbar shell", async () => {
    mockAdminFetch(seededAttention);
    window.history.replaceState(null, "", "/admin");
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    const overview = await screen.findByTestId("admin-section-overview");
    expect(screen.getByTestId("admin-topbar-title")).toHaveTextContent("Overview");
    expect(screen.getAllByRole("link", { name: "Chats" })[0]).toHaveAttribute("href", "/");
    expect(screen.getByRole("navigation", { name: "Workspace" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
    for (const group of ["Models", "People", "Platform"]) {
      expect(screen.getByText(group)).toBeInTheDocument();
    }
    expect(screen.queryByText("Team & access")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Refresh/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Updated /)).not.toBeInTheDocument();
    expect(within(screen.getByTestId("admin-topbar")).queryByText("admin@example.com")).not.toBeInTheDocument();

    const list = await within(overview).findByRole("list", { name: "Needs attention" });
    expect(within(list).getAllByTestId("admin-attention-item")).toHaveLength(2);
    expect(within(list).getByText("Users are waiting for approval")).toBeInTheDocument();
    expect(screen.getByText(/When the list is empty, everything is working/)).toBeInTheDocument();

    fireEvent.click(within(list).getByRole("button", { name: /Set up email/ }));
    await screen.findByTestId("admin-section-email");
    expect(window.location.search).toBe("?section=email");
    expect(screen.getByRole("link", { name: "Email" })).toHaveAttribute("aria-current", "page");
  });

  it("keeps global session reset behind the Overview menu until Users owns it", async () => {
    const { posts } = mockAdminFetch();
    window.history.replaceState(null, "", "/admin");
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    await screen.findByTestId("admin-section-overview");
    expect(screen.queryByRole("menuitem", { name: "Revoke all sessions" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Revoke all sessions" }));
    const confirmation = await screen.findByTestId("admin-confirm-revoke-all-sessions");
    fireEvent.click(within(confirmation).getByRole("button", { name: /confirm revoke all sessions/i }));
    await waitFor(() => expect(posts).toContainEqual({ action: "revoke_all_sessions" }));
    expect(await screen.findByText("All sessions revoked.")).toBeInTheDocument();

    const usersLink = screen.getByRole("link", { name: "Users" });
    await waitFor(() => expect(usersLink).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(usersLink);
    await screen.findByTestId("admin-section-users");
    expect(screen.queryByRole("button", { name: "More actions" })).not.toBeInTheDocument();
  });

  it("opens the database-backed Email section from shared navigation", async () => {
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
    fireEvent.click(screen.getByRole("link", { name: "Email" }));

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
    expect(main).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Loading admin data")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-section-users")).not.toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Control Center sections" })).toBeInTheDocument();

    await act(async () => {
      request.resolve(dashboardResponse());
      await request.promise;
    });

    expect((await screen.findAllByText("Active User")).length).toBeGreaterThan(0);
    await waitFor(() => expect(main).toHaveAttribute("aria-busy", "false"));
    expect(screen.queryByText("Loading admin data")).not.toBeInTheDocument();
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
    expect(screen.getByRole("main")).toHaveAttribute("aria-busy", "false");
    fetch.mockResolvedValue(dashboardResponse(emptyDashboard));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No users yet")).toBeInTheDocument();
    expect(screen.queryByText("Admin data unavailable")).not.toBeInTheDocument();
    view.unmount();
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
    fireEvent.click(row);
    const detail = await screen.findByTestId("admin-user-detail");
    await waitFor(() => expect(detail).toHaveFocus());
    const opener = within(detail).getByRole("button", { name: "Disable user" });
    opener.focus();
    fireEvent.click(opener);
    const confirmation = await screen.findByTestId("admin-confirm-disable-user");
    fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("pauses Control Center navigation while an admin action saves", async () => {
    const action = deferred<Response>();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "/api/admin") {
        return dashboardResponse();
      }
      if (url === "/api/admin/action" && init?.body) {
        return action.promise;
      }
      return dashboardResponse({ error: "unexpected_request" }, 500);
    });
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    fireEvent.click(await findUserListItem("Active User"));
    const detail = await screen.findByTestId("admin-user-detail");
    fireEvent.click(within(detail).getByRole("button", { name: "Disable user" }));
    const confirmation = await screen.findByTestId("admin-confirm-disable-user");
    fireEvent.click(within(confirmation).getByRole("button", { name: "Confirm disable user" }));

    await waitFor(() => expect(screen.getByRole("link", { name: "Providers" })).toHaveAttribute("aria-disabled", "true"));
    expect(screen.getByRole("button", { name: "Sections" })).toBeDisabled();
    fireEvent.click(screen.getByRole("link", { name: "Providers" }));
    expect(screen.getByRole("link", { name: "Users" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByTestId("admin-section-providers")).not.toBeInTheDocument();

    await act(async () => {
      action.resolve(dashboardResponse({ ok: true }));
      await action.promise;
    });

    await waitFor(() => expect(screen.getByRole("link", { name: "Providers" })).not.toHaveAttribute("aria-disabled"));
    expect(screen.getByRole("button", { name: "Sections" })).toBeEnabled();
    expect(screen.getByText("User disabled.")).toBeInTheDocument();
  });

  it("restores deep links, including retired section ids, without a page error", async () => {
    mockAdminFetch();
    window.history.replaceState(null, "", "/admin?section=invites");
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    const users = await screen.findByTestId("admin-section-users");
    expect(window.location.search).toBe("?section=users");
    expect(within(users).getByTestId("admin-section-invites")).toBeInTheDocument();
    expect(within(users).getByTestId("admin-section-access-rules")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Users" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("link", { name: "Invites" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Safety" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /^(Overview|Providers|Defaults & roles|Search|Knowledge & Memory|Users|Groups|MCP servers|Workspace|Email|Usage)$/ }))
      .toHaveLength(11);

    window.history.pushState(null, "", "/admin?section=system-models");
    fireEvent.popState(window);
    await screen.findByTestId("admin-section-roles");
    expect(screen.getByRole("link", { name: "Defaults & roles" })).toHaveAttribute("aria-current", "page");
    expect(window.location.search).toBe("?section=roles");

    window.history.pushState(null, "", "/admin?section=knowledge");
    fireEvent.popState(window);
    await screen.findByTestId("admin-section-retrieval");
    expect(screen.getByRole("link", { name: "Knowledge & Memory" })).toHaveAttribute("aria-current", "page");
  });

  it("switches compact composition between the active section and the section drawer", async () => {
    stubCompactViewport();
    mockAdminFetch();
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    const users = await screen.findByTestId("admin-section-users");
    expect(screen.getByTestId("admin-section-column")).toHaveClass("max-lg:hidden");
    expect(within(users).getByTestId("admin-users-index")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sections" }));
    expect(screen.getByTestId("admin-section-column")).not.toHaveClass("max-lg:hidden");
    expect(screen.getByRole("dialog", { name: "Control Center sections" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: "Usage" }));
    const usage = await screen.findByTestId("admin-section-usage");
    expect(screen.getByTestId("admin-section-column")).toHaveClass("max-lg:hidden");
    expect(within(usage).getByRole("region", { name: "Usage summary" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sections" }));
    fireEvent.click(screen.getByRole("link", { name: "Providers" }));
    const providers = await screen.findByTestId("admin-section-providers");
    expect(await within(providers).findByRole("alert")).toHaveTextContent("Providers could not be loaded");
  });

  it("guards dirty section and drawer navigation while cancel preserves exact state and focus", async () => {
    stubCompactViewport();
    mockAdminFetch();
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    const users = await screen.findByTestId("admin-section-users");
    const activeUserRow = findResourceListItem(users, "active@example.com");
    fireEvent.click(activeUserRow);
    const reviewers = within(await screen.findByTestId("admin-user-detail"))
      .getByRole("checkbox", { name: "reviewers" });
    fireEvent.click(reviewers);
    reviewers.focus();
    const originalPath = `${window.location.pathname}${window.location.search}`;
    const originalHistoryState = structuredClone(window.history.state);

    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Sections" }));
    expect(screen.getByRole("heading", { name: "Discard unsaved changes?" })).toBeVisible();
    expect(window.location.pathname + window.location.search).toBe(originalPath);
    expect(window.history.state).toEqual(originalHistoryState);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(reviewers).toHaveFocus());
    expect(reviewers).toBeChecked();
    expect(screen.getByTestId("admin-section-users")).toBeVisible();

    const returnToChat = screen.getAllByRole("link", { name: "Chats" })[0]!;
    returnToChat.focus();
    fireEvent.click(returnToChat);
    expect(screen.getByRole("heading", { name: "Discard unsaved changes?" })).toBeVisible();
    expect(window.location.pathname + window.location.search).toBe(originalPath);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(returnToChat).toHaveFocus());
    expect(reviewers).toBeChecked();

    fireEvent.click(screen.getByRole("link", { name: "Usage" }));
    expect(screen.getByTestId("admin-section-users")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Confirm discard changes" }));
    await screen.findByTestId("admin-section-usage");
    expect(window.location.search).toBe("?section=usage");
    const cleanUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cleanUnload);
    expect(cleanUnload.defaultPrevented).toBe(false);
  });

  it("guards a form-local Cancel action with the same deferred confirmation", async () => {
    mockAdminFetch();
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    await screen.findByTestId("admin-section-users");
    fireEvent.click(screen.getByRole("button", { name: "New rule" }));
    const rules = await screen.findByTestId("admin-section-access-rules");
    const value = within(rules).getByLabelText("Value");
    fireEvent.change(value, { target: { value: "cancel@example.com" } });
    fireEvent.click(within(rules).getByRole("button", { name: "Cancel" }));

    expect(screen.getByRole("heading", { name: "Discard unsaved changes?" })).toBeVisible();
    expect(value).toHaveValue("cancel@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(value).toHaveValue("cancel@example.com");

    fireEvent.click(within(rules).getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm discard changes" }));
    expect(within(rules).queryByLabelText("Value")).not.toBeInTheDocument();
  });

  it("guards provider setup secrets before leaving the Providers section", async () => {
    mockAdminFetch();
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    await screen.findByTestId("admin-section-users");
    fireEvent.click(screen.getByRole("link", { name: "Providers" }));
    const providers = await screen.findByTestId("admin-section-providers");
    await waitFor(() => expect(screen.getByRole("button", { name: "Add provider" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
    fireEvent.click(await within(providers).findByRole("button", { name: /OpenAI Not configured/ }));
    const secret = within(providers).getByLabelText(/^API key/);
    fireEvent.change(secret, { target: { value: "provider-secret-draft" } });

    fireEvent.click(screen.getByRole("link", { name: "Usage" }));
    expect(screen.getByRole("heading", { name: "Discard unsaved changes?" })).toBeVisible();
    expect(secret).toHaveValue("provider-secret-draft");
    expect(screen.getByTestId("admin-section-providers")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(secret).toHaveValue("provider-secret-draft");

    fireEvent.click(screen.getByRole("link", { name: "Usage" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm discard changes" }));
    await screen.findByTestId("admin-section-usage");
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);
  });

  it("rolls back dirty browser history and replays it once after discard", async () => {
    mockAdminFetch();
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    await screen.findByTestId("admin-section-users");
    fireEvent.click(screen.getByRole("link", { name: "Groups" }));
    await screen.findByTestId("admin-section-groups");
    fireEvent.click(screen.getByRole("link", { name: "Users" }));
    await screen.findByTestId("admin-section-users");
    fireEvent.click(screen.getByRole("button", { name: "New rule" }));
    fireEvent.change(screen.getByLabelText("Value"), {
      target: { value: "history@example.com" }
    });

    act(() => window.history.back());
    await screen.findByRole("heading", { name: "Discard unsaved changes?" });
    expect(window.location.search).toBe("?section=users");
    expect(screen.getByLabelText("Value")).toHaveValue("history@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(window.location.search).toBe("?section=users");

    act(() => window.history.back());
    await screen.findByRole("heading", { name: "Discard unsaved changes?" });
    fireEvent.click(screen.getByRole("button", { name: "Confirm discard changes" }));
    await screen.findByTestId("admin-section-groups");
    expect(window.location.search).toBe("?section=groups");
  });

  it("mounts Knowledge and Memory together under Knowledge & Memory and refreshes Knowledge directly", async () => {
    window.history.replaceState(null, "", "/admin?section=knowledge");
    const knowledge = {
      answerPolicy: adminKnowledgeAnswerPolicyFixture(),
      ingestionLimits: {
        maxChunksPerDocument: 10_000,
        maxFileBytes: 25_000_000,
        maxNormalizedChars: 5_000_000,
        maxPages: 2_000
      },
      operations: adminKnowledgeOperationsFixture(),
      profile: adminKnowledgeProfileFixture(),
      retrieval: {
        candidateLimit: 40,
        resultLimit: 16
      }
    };
    let knowledgeGets = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "/api/admin") return dashboardResponse();
      if (url === "/api/admin/knowledge" && (init?.method ?? "GET") === "GET") {
        knowledgeGets += 1;
        return dashboardResponse({ knowledge });
      }
      return dashboardResponse({ error: "unexpected_request" }, 500);
    });
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    const retrieval = await screen.findByTestId("admin-section-retrieval");
    await screen.findByRole("heading", { name: "Answer retrieval" });
    const knowledgeSection = within(retrieval).getByRole("region", { name: "Knowledge processing" });
    expect(within(retrieval).getByTestId("admin-retrieval-memory")).toBeInTheDocument();
    fireEvent.click(within(knowledgeSection).getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(knowledgeGets).toBe(2));
    expect(screen.queryByRole("heading", { name: "Discard unsaved changes?" }))
      .not.toBeInTheDocument();
    for (const save of within(knowledgeSection).getAllByRole("button", { name: "Save" })) {
      expect(save).toBeDisabled();
    }
    expect(screen.getByRole("link", { name: "Providers" })).not.toHaveAttribute("aria-disabled");
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);
  });

  it("renders read-only usage by group and user", async () => {
    mockAdminFetch();
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    await screen.findByTestId("admin-section-users");
    fireEvent.click(screen.getByRole("link", { name: "Usage" }));
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
    const sort = within(users).getByLabelText("Sort users");
    expect(sort).toHaveValue("user");
    fireEvent.change(sort, { target: { value: "status" } });
    expect(sort).toHaveValue("status");
    const direction = within(users).getByRole("button", {
      name: "Change sort direction to descending"
    });
    fireEvent.click(direction);
    expect(within(users).getByRole("button", {
      name: "Change sort direction to ascending"
    })).toHaveTextContent("Descending");
    expect(screen.getByTestId("admin-invites-index")).toBeInTheDocument();
    expect(screen.getByTestId("admin-invites-detail-pane")).toBeInTheDocument();
    expect(screen.getByTestId("admin-access-rules-index")).toBeInTheDocument();
    expect(screen.getByTestId("admin-access-rules-detail-pane")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: "Usage" }));
    expectBoundedComparisonTable("Group usage table");
    expectBoundedComparisonTable("User usage table");

    fireEvent.click(screen.getByRole("link", { name: "Groups" }));
    expect(screen.getByTestId("admin-access-groups-index")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-access-group-detail")).not.toBeInTheDocument();
  });

  it("opens one explicit access group as a dedicated focused detail", async () => {
    mockAdminFetch();
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    await screen.findByTestId("admin-section-users");
    fireEvent.click(screen.getByRole("link", { name: "Groups" }));
    const access = await screen.findByTestId("admin-section-groups");
    expect(within(access).queryByTestId("admin-access-group-detail")).not.toBeInTheDocument();
    fireEvent.change(within(access).getByLabelText("Search access groups"), {
      target: {
        value: "reviewers"
      }
    });
    const reviewersButton = within(access).getByRole("button", { name: "Open reviewers" });
    fireEvent.click(reviewersButton);

    const selectedContext = within(access).getByTestId("admin-access-group-detail");
    expect(selectedContext).toHaveAttribute("aria-label", "Access group reviewers");
    expect(within(selectedContext).getByText("reviewers")).toBeInTheDocument();
    await waitFor(() => expect(selectedContext).toHaveFocus());
    expect(within(access).queryByTestId("admin-access-groups-index")).not.toBeInTheDocument();
    fireEvent.click(within(selectedContext).getByRole("button", { name: "Back to access groups" }));
    expect(within(access).getByTestId("admin-access-groups-index")).toBeInTheDocument();
  });

  it("approves a pending user with selected groups", async () => {
    const { posts } = mockAdminFetch();
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    const row = await findUserListItem("Pending User");
    fireEvent.click(row);
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
    fireEvent.click(row);
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
    fireEvent.click(row);

    const detail = await screen.findByTestId("admin-user-detail");
    expect(within(detail).getByText("Active User")).toBeInTheDocument();
    await waitFor(() => {
      expect(detail).toHaveFocus();
    });
    fireEvent.click(within(detail).getByRole("button", { name: "Back to users" }));
    expect(screen.getByTestId("admin-users-index")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-users-detail-pane")).not.toBeInTheDocument();
  });

  it("creates groups and toggles group grants", async () => {
    const { posts } = mockAdminFetch();
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    await screen.findByTestId("admin-section-users");
    fireEvent.click(screen.getByRole("link", { name: "Groups" }));
    const access = await screen.findByTestId("admin-section-groups");
    fireEvent.click(screen.getByRole("button", { name: "New group" }));
    fireEvent.change(within(access).getByLabelText("Group name"), {
      target: {
        value: "review team"
      }
    });
    fireEvent.click(within(access).getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(posts).toContainEqual({
        action: "create_group",
        name: "review team"
      });
    });
    const successNotice = await screen.findByText("Group created.");
    expect(successNotice.closest('[role="status"]')).toBeInTheDocument();

    fireEvent.click(within(access).getByRole("button", { name: "Open operators" }));
    fireEvent.click(within(access).getByRole("button", { name: "Models & search" }));
    fireEvent.click(within(access).getByLabelText("Grant model OpenAI / GPT 5.5"));
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
    fireEvent.click(screen.getByRole("link", { name: "Groups" }));
    const access = await screen.findByTestId("admin-section-groups");
    fireEvent.change(within(access).getByLabelText("Search access groups"), {
      target: {
        value: "reviewers"
      }
    });
    const row = findResourceListItem(access, "reviewers");
    fireEvent.click(row);

    const detail = await screen.findByTestId("admin-access-group-detail");
    expect(within(detail).getByText("reviewers")).toBeInTheDocument();
    expect(within(detail).getByText("No provider, model, or search access.")).toBeInTheDocument();
    await waitFor(() => {
      expect(detail).toHaveFocus();
    });
    expect(within(access).queryByTestId("admin-access-groups-index")).not.toBeInTheDocument();
  });

  it("shows archived groups as non-editable in group and grant surfaces", async () => {
    mockAdminFetch();
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    await screen.findByTestId("admin-section-users");
    fireEvent.click(screen.getByRole("link", { name: "Groups" }));
    const access = await screen.findByTestId("admin-section-groups");
    fireEvent.click(within(access).getByRole("button", { name: "all" }));
    const archivedRow = findResourceListItem(access, "archived-record");
    fireEvent.click(archivedRow);
    const detail = await screen.findByTestId("admin-access-group-detail");

    expect(within(detail).getByText("Archived groups remain visible for history. Their grants no longer apply, and grant editing is disabled.")).toBeInTheDocument();
    expect(within(detail).queryByRole("button", { name: "Archive group" })).not.toBeInTheDocument();

    fireEvent.click(within(detail).getByRole("button", { name: "Models & search" }));
    expect(within(detail).getByText("Archived groups do not apply grants. Access editing is disabled for this group.")).toBeInTheDocument();
    expect(within(detail).getByLabelText("Grant provider OpenAI")).toBeDisabled();
    expect(within(detail).getByLabelText("Grant model OpenAI / GPT 5.5")).toBeDisabled();
  });

  it("toggles provider-wide and search strategy grants for the selected group", async () => {
    const { posts } = mockAdminFetch();
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    await screen.findByTestId("admin-section-users");
    fireEvent.click(screen.getByRole("link", { name: "Groups" }));
    const access = await screen.findByTestId("admin-section-groups");
    fireEvent.click(within(access).getByRole("button", { name: "Open operators" }));
    fireEvent.click(within(access).getByRole("button", { name: "Models & search" }));
    fireEvent.click(within(access).getByLabelText("Grant provider OpenAI"));

    await waitFor(() => {
      expect(posts).toContainEqual({
        action: "set_group_grant",
        enabled: true,
        groupId: "group-1",
        provider: "openai"
      });
    });

    fireEvent.click(within(access).getByLabelText("Grant search OpenAI web search"));

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
    fireEvent.click(screen.getByRole("link", { name: "Groups" }));
    const access = await screen.findByTestId("admin-section-groups");
    fireEvent.click(within(access).getByRole("button", { name: "Open operators" }));
    fireEvent.click(within(access).getByRole("button", { name: "Models & search" }));
    fireEvent.click(within(access).getByRole("button", { name: "Grant all OpenAI models to operators" }));

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

    fireEvent.click(screen.getByRole("link", { name: "Groups" }));
    const access = await screen.findByTestId("admin-section-groups");
    fireEvent.click(within(access).getByRole("button", { name: `Open ${longGroupName}` }));
    fireEvent.click(within(access).getByRole("button", { name: "Models & search" }));
    const selectedContext = within(access).getByTestId("admin-access-group-detail");
    expect(within(selectedContext).getByRole("heading", { name: longGroupName })).toHaveClass(
      "break-words",
      "[overflow-wrap:anywhere]"
    );
    expect(within(access).getByText("GPT 5.5")).toBeVisible();
    expect(within(access).queryByText(`openai:${longModelId}`)).not.toBeInTheDocument();
  });

  it("creates invites from the topbar and shows the returned link", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: "New invite" }));
    const invites = await screen.findByTestId("admin-section-invites");
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
    expect((await screen.findByText("Invite created and email sent.")).closest('[role="status"]')).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: "New invite" }));
    const invites = await screen.findByTestId("admin-section-invites");
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
    expect(screen.getByText("Invite link copied.").closest('[role="status"]')).toBeInTheDocument();
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

    const adminRow = await findUserListItem("Admin User");
    expect(adminRow).toBeInTheDocument();
    expect(screen.queryByText("Active User")).not.toBeInTheDocument();
    expect(screen.getByText("You")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-user-detail")).not.toBeInTheDocument();

    fireEvent.click(adminRow);
    const detail = await screen.findByTestId("admin-user-detail");
    expect(within(detail).getByText(/Self-disable and self-delete are not exposed/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Disable user" })).not.toBeInTheDocument();
  });

  it("paginates the user directory without auto-opening a detail", async () => {
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
    expect(within(users).queryByTestId("admin-user-detail")).not.toBeInTheDocument();
    fireEvent.click(within(users).getByRole("button", { name: "Next users page" }));

    const visibleRow = await findUserListItem("Paged User 26");
    expect(visibleRow).toBeInTheDocument();
    expect(within(users).queryByText("Paged User 01")).not.toBeInTheDocument();
    expect(within(users).queryByTestId("admin-user-detail")).not.toBeInTheDocument();

    fireEvent.click(visibleRow);
    expect(await within(screen.getByTestId("admin-user-detail")).findByText("Paged User 26")).toBeInTheDocument();
  });

  it("counts people attention on the Users destination without a global metric strip", async () => {
    mockAdminFetch();
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    const users = await screen.findByTestId("admin-section-users");
    expect(screen.queryByRole("region", { name: "Admin summary" })).not.toBeInTheDocument();
    expect(screen.getByText("People")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Users" })).toHaveTextContent("1");
    expect(screen.getByRole("link", { name: "Groups" })).not.toHaveTextContent("1");
    const pendingRow = findResourceListItem(users, "pending@example.com");
    expect(pendingRow).toHaveAccessibleName("Open Pending User");
    fireEvent.click(pendingRow);
    expect(within(users).getByText("No model access")).toBeInTheDocument();

    const invites = within(users).getByTestId("admin-section-invites");
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
    fireEvent.click(screen.getByRole("link", { name: "Groups" }));
    const access = await screen.findByTestId("admin-section-groups");
    fireEvent.click(screen.getByRole("button", { name: "New group" }));
    fireEvent.click(within(access).getByRole("button", { name: "Create" }));

    let failure = await screen.findByRole("alert");
    expect(failure).toHaveTextContent(/enter a group name/i);
    expect(failure).not.toHaveTextContent("group_required");
    const groupName = within(access).getByLabelText("Group name");
    expect(groupName).toHaveAttribute("aria-invalid", "true");
    expect(groupName).toHaveAccessibleDescription(/enter a group name/i);
    await waitFor(() => expect(groupName).toHaveFocus());

    fireEvent.click(within(access).getByRole("button", { name: "Back to access groups" }));
    const reviewersRow = findResourceListItem(access, "reviewers");
    fireEvent.click(reviewersRow);
    const groupDetail = await screen.findByTestId("admin-access-group-detail");
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

    fireEvent.click(screen.getByRole("button", { name: "New invite" }));
    const invites = await screen.findByTestId("admin-section-invites");
    fireEvent.click(within(invites).getByRole("button", { name: "Create invite" }));
    const inviteEmail = within(invites).getByLabelText("Email");
    expect(inviteEmail).toHaveAttribute("aria-invalid", "true");
    expect(inviteEmail).toHaveAccessibleDescription(/email address/i);
    await waitFor(() => expect(inviteEmail).toHaveFocus());

    fireEvent.click(screen.getByRole("button", { name: "New rule" }));
    const rules = await screen.findByTestId("admin-section-access-rules");
    fireEvent.click(within(rules).getByRole("button", { name: "Save rule" }));
    const ruleValue = within(rules).getByLabelText("Value");
    expect(ruleValue).toHaveAttribute("aria-invalid", "true");
    expect(ruleValue).toHaveAccessibleDescription(/email or domain/i);
    await waitFor(() => expect(ruleValue).toHaveFocus());

    fireEvent.click(screen.getByRole("link", { name: "Groups" }));
    const access = await screen.findByTestId("admin-section-groups");
    const reviewersRow = findResourceListItem(access, "reviewers");
    fireEvent.click(reviewersRow);
    const groupDetail = await screen.findByTestId("admin-access-group-detail");
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
    const invites = await screen.findByTestId("admin-section-invites");
    const acceptedRow = findResourceListItem(invites, "accepted@example.com");
    const revokedRow = findResourceListItem(invites, "revoked@example.com");

    expect(within(invites).getByText("open@example.com")).toBeInTheDocument();
    expect(within(acceptedRow).getByText("accepted")).toBeInTheDocument();
    expect(within(revokedRow).getByText("revoked")).toBeInTheDocument();

    fireEvent.click(within(invites).getByRole("button", { name: "Accepted" }));
    expect(within(invites).getByText("accepted@example.com")).toBeInTheDocument();
    expect(within(invites).queryByText("open@example.com")).not.toBeInTheDocument();
  });

  it("creates access rules with normalized preview and confirms deletion", async () => {
    const { posts } = mockAdminFetch();
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    await screen.findByTestId("admin-section-users");
    fireEvent.click(screen.getByRole("button", { name: "New rule" }));
    const rules = await screen.findByTestId("admin-section-access-rules");
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
    await waitFor(() => expect(within(rules).queryByLabelText("Value")).not.toBeInTheDocument());

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
    fireEvent.click(row);
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
    fireEvent.click(row);
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

  it("falls back to the active section link when a confirmation opener disappears before cancel", async () => {
    mockAdminFetch();
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    const row = await findUserListItem("Active User");
    fireEvent.click(row);
    const detail = await screen.findByTestId("admin-user-detail");
    fireEvent.click(within(detail).getByRole("button", { name: "Disable user" }));
    const confirmation = await screen.findByTestId("admin-confirm-disable-user");

    window.history.pushState(null, "", "/admin?section=usage");
    fireEvent.popState(window);
    await waitFor(() =>
      expect(screen.getByTestId("admin-nav-usage")).toHaveAttribute("aria-current", "page")
    );
    fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.getByRole("link", { name: "Usage" })).toHaveFocus());
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
    fireEvent.click(row);
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
    await waitFor(() => expect(screen.getByRole("link", { name: "Users" })).toHaveFocus());
  });

  it("restores the active section link when a deleted rule removes its opener", async () => {
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
    await waitFor(() => expect(screen.getByRole("link", { name: "Users" })).toHaveFocus());
  });

  it("confirms stale user, empty group, and stale invite deletion actions", async () => {
    const { posts } = mockAdminFetch();
    render(<AdminPanel adminEmail="admin@example.com" adminUserId="admin-1" />);

    const pendingRow = await findUserListItem("Pending User");
    fireEvent.click(pendingRow);
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

    const groupsLink = screen.getByRole("link", { name: "Groups" });
    await waitFor(() => expect(groupsLink).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(groupsLink);
    const access = await screen.findByTestId("admin-section-groups");
    fireEvent.change(within(access).getByLabelText("Search access groups"), {
      target: {
        value: "reviewers"
      }
    });
    const groupRow = findResourceListItem(access, "reviewers");
    fireEvent.click(groupRow);
    const groupDetail = await screen.findByTestId("admin-access-group-detail");
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

    const usersLink = screen.getByRole("link", { name: "Users" });
    await waitFor(() => expect(usersLink).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(usersLink);
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
    fireEvent.click(activeRow);
    expect(await screen.findByText("Disable this user before deletion can be considered.")).toBeInTheDocument();

    const invites = screen.getByTestId("admin-section-invites");
    const acceptedRow = findResourceListItem(invites, "accepted@example.com");
    fireEvent.click(within(acceptedRow).getByRole("button", { name: "Details" }));
    expect(within(screen.getByTestId("admin-invite-detail")).getByText("Accepted invites are kept for audit history.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: "Groups" }));
    const access = await screen.findByTestId("admin-section-groups");
    const operatorsRow = findResourceListItem(access, "operators");
    fireEvent.click(operatorsRow);
    expect(await within(screen.getByTestId("admin-access-group-detail")).findByText("Remove 1 member before deleting this group.")).toBeInTheDocument();
  });
});
