import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect, useState, type ReactNode } from "react";
import { AdminSectionTopbarProvider, type AdminShellTopbar } from "@/components/admin/AdminShell";
import type { AdminRunAction } from "@/components/admin/useAdminActionRunner";
import { AdminSignupRulesSection } from "./AdminSignupRulesSection";
import { useAdminAccessRulesController } from "@/components/admin/useAdminAccessRulesController";
import type { AdminConfirmedActionRequest } from "@/components/admin/useAdminConfirmationController";
import { useAdminInvitesController } from "@/components/admin/useAdminInvitesController";
import type { AdminMcpController } from "@/components/admin/useAdminMcpController";
import { useAdminUsersController } from "@/components/admin/useAdminUsersController";
import type { AdminActionRequest, AdminDashboard, AdminGroup, AdminInviteRecord, AdminUserRecord } from "@/lib/contracts/admin";
import { fixtureConnection, fixtureCredential } from "@/components/admin/providers/providerFixtures";
import { AdminUsersSection } from "./AdminUsersSection";

const NOW = Date.parse("2026-09-07T12:00:00.000Z");

const groups: AdminGroup[] = [
  {
    accessGrants: [
      { enabled: true, groupId: "group-ops", id: "grant-1", modelId: "gpt-5.5", provider: "openai", searchStrategy: null, userId: null }
    ],
    archivedAt: null,
    id: "group-ops",
    name: "operators",
    systemRole: null,
    userCount: 1
  },
  { accessGrants: [], archivedAt: null, id: "group-research", name: "research", systemRole: null, userCount: 0 },
  { accessGrants: [], archivedAt: null, id: "group-full", name: "Full access", systemRole: "full_access", userCount: 1 }
];

function user(overrides: Partial<AdminUserRecord> & { id: string }): AdminUserRecord {
  return {
    directGrants: [],
    displayName: "User",
    effectiveEntitlements: { models: [], providers: [], searchStrategies: [] },
    email: `${overrides.id}@example.com`,
    groups: [],
    hasVerifiedIdentity: true,
    lastSessionAt: null,
    role: "user",
    status: "active",
    ...overrides
  };
}

const users: AdminUserRecord[] = [
  user({ displayName: "Local Operator", groups: [{ groupId: "group-full", name: "Full access", role: "owner" }], id: "admin-1", lastSessionAt: "2026-09-07T11:59:40.000Z", role: "admin" }),
  user({
    directGrants: [{ enabled: true, groupId: null, id: "direct-mini", modelId: "gpt-mini", provider: "openai", searchStrategy: null, userId: "ada" }],
    displayName: "Ada Analyst",
    effectiveEntitlements: { models: [{ modelId: "gpt-5.5", provider: "openai" }, { modelId: "gpt-mini", provider: "openai" }], providers: [], searchStrategies: ["web"] },
    groups: [{ groupId: "group-ops", name: "operators", role: "member" }],
    id: "ada",
    lastSessionAt: "2026-09-03T16:04:00.000Z"
  }),
  user({ displayName: "Pending Person", id: "pending-1", status: "pending" }),
  user({ displayName: "Shadow Owner", email: null, id: "shadow" }),
  user({ deletion: { canDelete: true, reason: null, summary: "This stale account can be deleted." }, displayName: "Disabled Developer", id: "disabled-1", status: "disabled" })
];

function invite(overrides: Partial<AdminInviteRecord> & { id: string }): AdminInviteRecord {
  return {
    acceptedAt: null,
    defaultGroups: [{ groupId: "group-ops", name: "operators", role: "member" }],
    email: `${overrides.id}@example.com`,
    expiresAt: "2026-09-13T12:00:00.000Z",
    normalizedEmail: `${overrides.id}@example.com`,
    revokedAt: null,
    ...overrides
  };
}

const invites: AdminInviteRecord[] = [
  invite({ id: "open-a" }),
  invite({ expiresAt: "2026-09-09T12:00:00.000Z", id: "open-b" }),
  invite({ id: "open-c" }),
  invite({ id: "open-d" }),
  invite({ id: "revoked-1", revokedAt: "2026-09-03T12:00:00.000Z" }),
  invite({ acceptedAt: "2026-09-02T12:00:00.000Z", id: "accepted-1" })
];

function dashboardFixture(): AdminDashboard {
  return {
    accessRules: [
      { defaultGroups: [{ groupId: "group-ops", name: "operators", role: "member" }], enabled: true, id: "rule-1", kind: "email", value: "allowed@example.com" }
    ],
    catalog: {
      models: [
        { displayName: "GPT 5.5", modelId: "gpt-5.5", provider: "openai" },
        { displayName: "GPT Mini", modelId: "gpt-mini", provider: "openai" }
      ],
      providers: [{ id: "openai", name: "OpenAI" }],
      searchStrategies: [{ displayName: "OpenAI web search", strategyId: "web" }]
    },
    groups,
    invites,
    navigation: {
      advancedConfigured: false,
      attention: { activeUsersWithoutModelAccess: 1, openInvites: 4, pendingUsers: 1 },
      teamConfigured: true
    },
    usage: {
      byGroup: [],
      byUser: [],
      totals: { incompleteUsageCount: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, inputTokens: 0, lastUsedAt: null, outputTokens: 0, reasoningTokens: 0, runCount: 0, totalTokens: 0 }
    },
    users
  };
}

const mcp: AdminMcpController = {
  actions: {
    bulkGrantGroup: vi.fn().mockResolvedValue(true),
    activate: vi.fn(async () => false),
    checkUpdate: vi.fn(async () => false),
    create: vi.fn(async () => ({ message: "unavailable", ok: false as const })),
    delete: vi.fn(async () => false),
    disconnectValidationOAuth: vi.fn(async () => false),
    grant: vi.fn(async () => false),
    rebuild: vi.fn(async () => false),
    refresh: vi.fn(async () => undefined),
    rollback: vi.fn(async () => false),
    save: vi.fn(async () => ({ applied: false })),
    update: vi.fn(async () => false)
  },
  state: { busy: false, error: null, loaded: true, loading: false, servers: [] }
};

type HarnessProps = Readonly<{
  signupRules?: boolean;
  filter?: string | null;
  initialDashboard?: AdminDashboard;
  rejectMembership?: boolean;
  resource?: string | null;
}>;

type Harness = Readonly<{
  confirmations: AdminConfirmedActionRequest[];
  feedback: { clearAll: ReturnType<typeof vi.fn>; reportError: ReturnType<typeof vi.fn>; reportNotice: ReturnType<typeof vi.fn> };
  onSelectFilter: ReturnType<typeof vi.fn>;
  onSelectResource: ReturnType<typeof vi.fn>;
  posts: AdminActionRequest[];
  writeText: ReturnType<typeof vi.fn>;
}>;

let updateDashboard: ((next: AdminDashboard) => void) | null = null;

function TopbarHarness({ children }: Readonly<{ children: ReactNode }>) {
  const [topbar, setTopbar] = useState<AdminShellTopbar | null>(null);
  return (
    <AdminSectionTopbarProvider value={setTopbar}>
      <div data-testid="topbar">
        <h1 data-testid="topbar-title">{topbar?.title}</h1>
        <div data-testid="topbar-actions">{topbar?.actions}</div>
      </div>
      {children}
    </AdminSectionTopbarProvider>
  );
}

function renderSection({ signupRules = false, filter = null, initialDashboard = dashboardFixture(), rejectMembership = false, resource = null }: HarnessProps = {}): Harness {
  const posts: AdminActionRequest[] = [];
  const confirmations: AdminConfirmedActionRequest[] = [];
  const feedback = { clearAll: vi.fn(), reportError: vi.fn(), reportNotice: vi.fn() };
  const onSelectFilter = vi.fn();
  const onSelectResource = vi.fn();
  const writeText = vi.fn(async () => undefined);
  const runAction: AdminRunAction = async (body) => {
    posts.push(body);
    if (body.action === "set_user_groups" && rejectMembership) return { error: "user_access_stale" };
    if (body.action === "create_invite") {
      return { emailDelivery: "sent", invite: { id: "invite-new" }, inviteUrl: "https://aiqsa.local/login?invite=test-token" };
    }
    return { ok: true };
  };

  function Section() {
    const [dashboard, setDashboard] = useState(initialDashboard);
    useEffect(() => {
      updateDashboard = setDashboard;
    }, []);
    const usersController = useAdminUsersController({
      actionsDisabled: false,
      adminUserId: "admin-1",
      dashboard,
      requestConfirmedAction: (config) => { confirmations.push(config); },
      runAction
    });
    const invitesController = useAdminInvitesController({
      actionsDisabled: false,
      confirmation: { requestConfirmedAction: (config) => { confirmations.push(config); } },
      dashboard,
      feedback,
      nowMs: NOW,
      runAction,
      writeText
    });
    const rulesController = useAdminAccessRulesController({ actionsDisabled: false, dashboard, runAction });
    if (signupRules) return <AdminSignupRulesSection controller={rulesController} groups={dashboard.groups} />;
    return (
      <AdminUsersSection
        dashboard={dashboard}
        filter={filter}
        invites={invitesController}
        mcp={mcp}
        onSelectFilter={onSelectFilter}
        onSelectResource={onSelectResource}
        resource={resource}
        users={usersController}
      />
    );
  }

  render(<TopbarHarness><Section /></TopbarHarness>);
  return { confirmations, feedback, onSelectFilter, onSelectResource, posts, writeText };
}

function rowFor(name: string): HTMLElement {
  const row = screen.getByRole("link", { name: `Open ${name}` }).closest<HTMLElement>('[data-testid="admin-user-row"]');
  if (!row) throw new Error(`No row for ${name}`);
  return row;
}

describe("AdminUsersSection", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/admin?section=users");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "/api/admin/providers") {
        const openai = fixtureConnection({
          credentials: [fixtureCredential({ id: "cred-primary", label: "Primary" }), fixtureCredential({ id: "cred-research", label: "Research team" })],
          defaultCredentialId: "cred-primary",
          displayName: "OpenAI",
          id: "conn-openai",
          userAssignments: [{
            connectionId: "conn-openai",
            credentialId: "cred-research",
            updatedAt: "2026-09-01T00:00:00.000Z",
            user: { displayName: "Ada Analyst", email: "ada@example.com", id: "ada", status: "active" }
          }]
        });
        return Response.json({ connections: [openai] });
      }
      return Response.json({ error: "unexpected_request" }, { status: 500 });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    updateDashboard = null;
  });

  it("lists users pending first with tags, access, last seen and filter pills, and opens a page from a row", () => {
    const { confirmations, onSelectFilter, onSelectResource } = renderSection();

    const list = screen.getByRole("list", { name: "Users" });
    const rows = within(list).getAllByTestId("admin-user-row");
    expect(rows.map((row) => row.getAttribute("data-user-status"))).toEqual(["pending", "active", "active", "active", "disabled"]);
    expect(rows[0]).toHaveTextContent("Pending Person");
    expect(rows[0]).toHaveTextContent("via group after approval");
    expect(rowFor("Ada Analyst")).toHaveTextContent("2 models · 1 search");
    expect(rowFor("Ada Analyst")).toHaveTextContent(/Sep 3, \d{2}:\d{2}/u);
    expect(within(rowFor("Ada Analyst")).getByText("operators")).toBeInTheDocument();
    expect(rowFor("Local Operator")).toHaveTextContent("admin-1@example.com · you · admin");
    expect(rowFor("Local Operator")).toHaveTextContent("everything");
    expect(rowFor("Local Operator")).toHaveTextContent("just now");
    expect(rowFor("Shadow Owner")).toHaveTextContent("no email");
    expect(within(rowFor("Shadow Owner")).getByText("No groups")).toBeInTheDocument();
    expect(within(rowFor("Shadow Owner")).getByText("No model access")).toHaveClass("text-caution");
    expect(within(rowFor("Shadow Owner")).getByRole("button", { name: "Add to group" })).toBeInTheDocument();
    expect(within(rowFor("Disabled Developer")).getByText("Disabled")).toBeInTheDocument();
    expect(rowFor("Disabled Developer")).toHaveTextContent("never");
    expect(screen.getByRole("link", { name: "Open Ada Analyst" })).toHaveAttribute("href", "/admin?section=users&resource=ada");

    const filters = screen.getByRole("group", { name: "User filters" });
    expect(within(filters).getAllByRole("button").map((pill) => pill.textContent)).toEqual([
      "All · 5", "Pending · 1", "Invited · 4", "Disabled · 1", "Denied · 0", "No model access · 1"
    ]);
    expect(within(filters).getByRole("button", { name: "All · 5" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(filters).getByRole("button", { name: "Pending · 1" }));
    expect(onSelectFilter).toHaveBeenCalledWith("pending");

    fireEvent.change(screen.getByRole("searchbox", { name: "Search users" }), { target: { value: "research" } });
    expect(screen.getByRole("status")).toHaveTextContent("No users match this view");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search users" }), { target: { value: "ada@" } });
    expect(within(screen.getByRole("list", { name: "Users" })).getAllByTestId("admin-user-row")).toHaveLength(1);

    fireEvent.click(screen.getByRole("link", { name: "Open Ada Analyst" }));
    expect(onSelectResource).toHaveBeenCalledWith("ada");

    expect(screen.getByTestId("topbar-title")).toHaveTextContent("Users");
    expect(screen.queryByRole("button", { name: "Sign-up rules" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Invite" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Revoke all sessions" }));
    expect(confirmations.at(-1)).toMatchObject({ body: { action: "revoke_all_sessions" }, testId: "admin-confirm-revoke-all-sessions" });
    expect(document.body.textContent).not.toMatch(/draft|revision|evidence|probe|adapter/iu);
  });

  it("approves a pending user with the group chosen in the row and rejects with a confirmation", async () => {
    const { confirmations, posts } = renderSection();
    const row = rowFor("Pending Person");

    fireEvent.change(within(row).getByRole("combobox", { name: "Group for Pending Person" }), { target: { value: "group-research" } });
    fireEvent.click(within(row).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(posts).toEqual([
      { action: "set_user_groups", expectedGroupIds: [], groupIds: ["group-research"], userId: "pending-1" },
      { action: "approve_user", groupIds: ["group-research"], userId: "pending-1" }
    ]));

    fireEvent.click(within(row).getByRole("button", { name: "Reject" }));
    expect(confirmations.at(-1)).toMatchObject({ body: { action: "reject_user", userId: "pending-1" }, testId: "admin-confirm-reject-user" });
  });

  it("adds a user without groups to a group from the row", async () => {
    const { posts } = renderSection();
    const row = rowFor("Shadow Owner");

    fireEvent.click(within(row).getByRole("button", { name: "Add to group" }));
    const select = within(row).getByRole("combobox", { name: "Group for Shadow Owner" });
    expect(within(row).getByRole("button", { name: "Add" })).toBeDisabled();
    fireEvent.change(select, { target: { value: "group-ops" } });
    fireEvent.click(within(row).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(posts).toEqual([{ action: "set_user_groups", expectedGroupIds: [], groupIds: ["group-ops"], userId: "shadow" }]));
  });

  it("shows the Invited filter as the full open-invites list and pre-selects a URL filter", () => {
    renderSection({ filter: "invited" });
    expect(screen.queryByRole("list", { name: "Users" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Invited · 4" })).toHaveAttribute("aria-pressed", "true");
    expect(within(screen.getByRole("list", { name: "Open invites" })).getAllByTestId("admin-invite-row")).toHaveLength(4);
    expect(screen.queryByRole("button", { name: /Show \d+ more/u })).not.toBeInTheDocument();
  });

  it("renders the user page with groups Save, effective access, direct keys and grants, MCP access and account actions", async () => {
    const { confirmations, posts } = renderSection({ resource: "ada" });

    const page = await screen.findByTestId("admin-user-page");
    await waitFor(() => expect(page).toHaveFocus());
    await waitFor(() => expect(screen.getByTestId("topbar-title")).toHaveTextContent("Ada Analyst"));
    expect(within(page).getByRole("heading", { name: "Ada Analyst" })).toBeInTheDocument();
    expect(page).toHaveTextContent("ada@example.com · verified email");
    expect(within(page).getByText("Active")).toHaveAttribute("data-user-status", "active");
    expect(within(page).getByText("OpenAI / GPT 5.5, OpenAI / GPT Mini")).toBeInTheDocument();
    expect(within(page).getByText("OpenAI web search")).toBeInTheDocument();
    expect(await within(page).findByRole("combobox", { name: "Key for OpenAI" })).toHaveDisplayValue("Research team");
    expect(within(screen.getByRole("list", { name: "Direct grants" })).getByText("OpenAI / GPT Mini")).toBeInTheDocument();
    expect(within(page).getByTestId("admin-user-mcp-access")).toBeInTheDocument();
    expect(within(page).queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();

    const save = within(page).getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    fireEvent.click(within(page).getByRole("checkbox", { name: "research" }));
    expect(within(page).getByRole("status")).toHaveTextContent("Unsaved group changes.");
    fireEvent.click(save);
    await waitFor(() => expect(posts).toEqual([{ action: "set_user_groups", expectedGroupIds: ["group-ops"], groupIds: ["group-ops", "group-research"], userId: "ada" }]));
    await waitFor(() => expect(within(page).getByRole("button", { name: "Save" })).toBeDisabled());

    fireEvent.click(within(page).getByRole("button", { name: "Revoke sessions" }));
    expect(confirmations.at(-1)).toMatchObject({ body: { action: "revoke_user_sessions", userId: "ada" }, testId: "admin-confirm-revoke-user-sessions" });
    fireEvent.click(within(page).getByRole("button", { name: "Disable" }));
    expect(confirmations.at(-1)).toMatchObject({ body: { action: "disable_user", userId: "ada" }, testId: "admin-confirm-disable-user" });
    expect(within(page).queryByRole("button", { name: "Delete stale" })).not.toBeInTheDocument();
    expect(page).toHaveTextContent("Disable this user before deletion can be considered.");

    fireEvent.click(screen.getByRole("link", { name: "Users" }));
  });

  it("retains a dirty membership draft and its original baseline after a background membership change", async () => {
    const { posts } = renderSection({ rejectMembership: true, resource: "ada" });
    const page = await screen.findByTestId("admin-user-page");
    fireEvent.click(within(page).getByRole("checkbox", { name: "research" }));
    act(() => {
      const dashboard = dashboardFixture();
      updateDashboard?.({ ...dashboard, users: dashboard.users.map((candidate) => candidate.id === "ada" ? {
        ...candidate, groups: [...candidate.groups, { groupId: "group-full", name: "Full access", role: "member" }]
      } : candidate) });
    });
    fireEvent.click(within(page).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posts).toEqual([{
      action: "set_user_groups", expectedGroupIds: ["group-ops"], groupIds: ["group-ops", "group-research"], userId: "ada"
    }]));
    expect(within(page).getByRole("checkbox", { name: "research" })).toBeChecked();
    expect(within(page).getByRole("checkbox", { name: "Full access" })).not.toBeChecked();
    await waitFor(() => expect(within(page).getByRole("button", { name: "Save" })).toBeEnabled());
  });

  it("keeps a pending row selection bound to its original memberships and stops approval on conflict", async () => {
    const { posts } = renderSection({ rejectMembership: true });
    const row = rowFor("Pending Person");
    fireEvent.change(within(row).getByRole("combobox", { name: "Group for Pending Person" }), { target: { value: "group-research" } });
    act(() => {
      const dashboard = dashboardFixture();
      updateDashboard?.({ ...dashboard, users: dashboard.users.map((candidate) => candidate.id === "pending-1" ? {
        ...candidate, groups: [{ groupId: "group-ops", name: "operators", role: "member" }]
      } : candidate) });
    });
    fireEvent.click(within(row).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(posts).toEqual([{
      action: "set_user_groups", expectedGroupIds: [], groupIds: ["group-research"], userId: "pending-1"
    }]));
    expect(within(row).getByRole("combobox", { name: "Group for Pending Person" })).toHaveValue("group-research");
    await waitFor(() => expect(within(row).getByRole("button", { name: "Approve" })).toBeEnabled());
  });

  it("keeps self-protection, approval from the page and stale deletion with its confirmation", async () => {
    const self = renderSection({ resource: "admin-1" });
    const selfPage = await screen.findByTestId("admin-user-page");
    expect(selfPage).toHaveTextContent("Self-disable and self-delete are not exposed here.");
    expect(within(selfPage).queryByRole("button", { name: "Disable" })).not.toBeInTheDocument();
    expect(within(selfPage).queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(selfPage).toHaveTextContent("Everything: every provider, model and Search source, through Full access.");
    expect(self.confirmations).toHaveLength(0);
    document.body.innerHTML = "";

    const pending = renderSection({ resource: "pending-1" });
    const pendingPage = await screen.findByTestId("admin-user-page");
    fireEvent.click(within(pendingPage).getByRole("checkbox", { name: "operators" }));
    fireEvent.click(within(pendingPage).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(pending.posts).toEqual([
      { action: "set_user_groups", expectedGroupIds: [], groupIds: ["group-ops"], userId: "pending-1" },
      { action: "approve_user", groupIds: ["group-ops"], userId: "pending-1" }
    ]));
    fireEvent.click(within(pendingPage).getByRole("button", { name: "Delete stale" }));
    const deletion = pending.confirmations.at(-1);
    expect(deletion).toMatchObject({ body: { action: "delete_user", userId: "pending-1" }, testId: "admin-confirm-delete-user" });
    act(() => { deletion?.onSuccess?.(); });
    await waitFor(() => expect(pending.onSelectResource).toHaveBeenCalledWith(null));
  });

  it("creates an invite from the sheet, shows the one-time link with Copy, and lists it under Open invites", async () => {
    const { feedback, posts, writeText } = renderSection();

    fireEvent.click(screen.getByRole("button", { name: "Invite" }));
    const sheet = await screen.findByRole("dialog", { name: "Invite" });
    expect(within(sheet).getByRole("checkbox", { name: /Send invitation email/u })).toBeChecked();
    fireEvent.click(within(sheet).getByRole("button", { name: "Create invite" }));
    const email = within(sheet).getByLabelText("Email");
    expect(await within(sheet).findByRole("alert")).toHaveTextContent("Enter the person's email address.");
    expect(email).toHaveAttribute("aria-invalid", "true");
    await waitFor(() => expect(email).toHaveFocus());
    expect(posts).toHaveLength(0);

    fireEvent.change(email, { target: { value: "friend@example.com" } });
    fireEvent.click(within(sheet).getByRole("checkbox", { name: "operators" }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Create invite" }));
    await waitFor(() => expect(posts).toEqual([
      { action: "create_invite", email: "friend@example.com", groupIds: ["group-ops"], sendEmail: true }
    ]));
    act(() => {
      updateDashboard?.({ ...dashboardFixture(), invites: [invite({ email: "friend@example.com", id: "invite-new" }), ...invites] });
    });
    const result = await within(sheet).findByTestId("admin-invite-result");
    expect(result).toHaveTextContent("friend@example.com is invited · email sent");
    expect(within(sheet).getByLabelText("Invite link")).toHaveValue("https://aiqsa.local/login?invite=test-token");
    expect(feedback.reportNotice).toHaveBeenCalledWith("Invite created and email sent.");
    fireEvent.click(within(sheet).getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://aiqsa.local/login?invite=test-token"));
    expect(await within(sheet).findByRole("button", { name: "Copied" })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("test-token".repeat(2));

    fireEvent.click(within(sheet).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Invite" })).not.toBeInTheDocument());
    const freshRow = screen.getByText("friend@example.com").closest<HTMLElement>('[data-testid="admin-invite-row"]')!;
    expect(freshRow).toHaveTextContent("operators · expires in 6 days · email sent");
    expect(within(freshRow).getByRole("button", { name: "Copy link for friend@example.com" })).toBeInTheDocument();
    const olderRow = screen.getByText("open-a@example.com").closest<HTMLElement>('[data-testid="admin-invite-row"]')!;
    expect(within(olderRow).queryByRole("button", { name: /Copy link/u })).not.toBeInTheDocument();
    expect(screen.getByText(/Invite links are one-time/u)).toBeInTheDocument();
  });

  it("guards an unsent invite behind a discard dialog inside the sheet", async () => {
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Invite" }));
    const sheet = await screen.findByRole("dialog", { name: "Invite" });
    fireEvent.change(within(sheet).getByLabelText("Email"), { target: { value: "typed@example.com" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    const discard = await screen.findByTestId("admin-invite-discard");
    fireEvent.keyDown(within(discard).getByRole("button", { name: "Cancel" }), { key: "Escape" });
    await waitFor(() => expect(discard).not.toBeInTheDocument());
    expect(screen.getByRole("dialog", { name: "Invite" })).toBeInTheDocument();
    expect(within(sheet).getByLabelText("Email")).toHaveValue("typed@example.com");
    fireEvent.keyDown(sheet, { key: "Escape" });
    fireEvent.click(within(await screen.findByTestId("admin-invite-discard")).getByRole("button", { name: "Confirm discard changes" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Invite" })).not.toBeInTheDocument());
  });

  it("revokes and deletes invites from the Open invites menu and shows more on demand", async () => {
    const { confirmations } = renderSection();
    const block = screen.getByTestId("admin-open-invites");
    expect(within(block).getByRole("heading", { name: "Open invites · 4" })).toBeInTheDocument();
    let rows = within(block).getAllByTestId("admin-invite-row");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("open-b@example.com");
    expect(rows[0]).toHaveTextContent("expires in 2 days");
    fireEvent.click(within(block).getByRole("button", { name: "Show 1 more" }));
    rows = within(block).getAllByTestId("admin-invite-row");
    expect(rows).toHaveLength(4);
    expect(block).not.toHaveTextContent("accepted-1@example.com");

    fireEvent.click(within(rows[0]!).getByRole("button", { name: "More actions for open-b@example.com" }));
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeDisabled();
    fireEvent.click(screen.getByRole("menuitem", { name: "Revoke" }));
    expect(confirmations.at(-1)).toMatchObject({ body: { action: "revoke_invite", inviteId: "open-b" }, testId: "admin-confirm-revoke-invite" });

    expect(block).toHaveTextContent("1 expired or revoked invite");
    fireEvent.click(within(block).getByRole("button", { name: "Show" }));
    const stale = within(screen.getByRole("list", { name: "Expired or revoked invites" })).getAllByTestId("admin-invite-row");
    expect(stale).toHaveLength(1);
    expect(stale[0]).toHaveTextContent("revoked Sep 3");
    fireEvent.click(within(stale[0]!).getByRole("button", { name: "More actions for revoked-1@example.com" }));
    expect(screen.queryByRole("menuitem", { name: "Revoke" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(confirmations.at(-1)).toMatchObject({ body: { action: "delete_invite", inviteId: "revoked-1" }, testId: "admin-confirm-delete-invite" });
  });

  it("manages sign-up rules on their own page with a normalized add form and confirmed deletion", async () => {
    const { posts } = renderSection({ signupRules: true });

    const rules = screen.getByRole("list", { name: "Sign-up rules" });
    expect(within(rules).getAllByTestId("admin-signup-rule")).toHaveLength(1);
    expect(rules).toHaveTextContent("allowed@example.com");
    expect(rules).toHaveTextContent("Email · operators");
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    const sheet = await screen.findByRole("dialog", { name: "Add sign-up rule" });

    fireEvent.click(within(sheet).getByRole("button", { name: "Add rule" }));
    expect(await within(sheet).findByRole("alert")).toHaveTextContent("Enter an email address.");
    expect(within(sheet).getByLabelText("Value")).toHaveAttribute("aria-invalid", "true");
    expect(posts).toHaveLength(0);

    fireEvent.change(within(sheet).getByLabelText("Kind"), { target: { value: "domain" } });
    fireEvent.change(within(sheet).getByLabelText("Value"), { target: { value: " @Example.COM " } });
    expect(within(sheet).getByTestId("admin-signup-rule-preview")).toHaveTextContent("Matches exactly example.com.");
    fireEvent.click(within(sheet).getByRole("checkbox", { name: "research" }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Add rule" }));
    await waitFor(() => expect(posts).toEqual([
      { action: "create_access_rule", groupIds: ["group-research"], kind: "domain", value: "example.com" }
    ]));
    await waitFor(() => expect(within(sheet).getByLabelText("Value")).toHaveValue(""));
    expect(within(sheet).getByLabelText("Kind")).toHaveValue("email");

    fireEvent.click(within(sheet).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add sign-up rule" })).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Delete rule allowed@example.com" }));
    const confirmation = await screen.findByTestId("admin-confirm-delete-access-rule");
    fireEvent.click(within(confirmation).getByRole("button", { name: "Confirm delete rule" }));
    await waitFor(() => expect(posts.at(-1)).toEqual({ action: "delete_access_rule", ruleId: "rule-1" }));
    await waitFor(() => expect(screen.queryByTestId("admin-confirm-delete-access-rule")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "Add rule" })).toHaveFocus());

    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    const newSheet = await screen.findByRole("dialog", { name: "Add sign-up rule" });
    fireEvent.change(within(newSheet).getByLabelText("Value"), { target: { value: "unsaved@example.com" } });
    fireEvent.click(within(newSheet).getByRole("button", { name: "Done" }));
    const discard = await screen.findByTestId("admin-signup-rules-discard");
    fireEvent.click(within(discard).getByRole("button", { name: "Confirm discard changes" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add sign-up rule" })).not.toBeInTheDocument());
  });
});
