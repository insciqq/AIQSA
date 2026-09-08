import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState, type ReactNode } from "react";
import { AdminSectionTopbarProvider, type AdminShellTopbar } from "@/components/admin/AdminShell";
import { fixtureCheck, fixtureConnection, fixtureCredential, fixtureModel } from "@/components/admin/providers/providerFixtures";
import type { AdminRunAction } from "@/components/admin/useAdminActionRunner";
import type { AdminConfirmedActionRequest } from "@/components/admin/useAdminConfirmationController";
import { useAdminGroupsController } from "@/components/admin/useAdminGroupsController";
import type { AdminMcpController } from "@/components/admin/useAdminMcpController";
import type {
  AdminAccessGrantRecord,
  AdminActionRequest,
  AdminDashboard,
  AdminGroup,
  AdminUserRecord
} from "@/lib/contracts/admin";
import type { AdminMcpServer } from "@/lib/contracts/mcp";
import { AdminGroupsSection } from "./AdminGroupsSection";

const NOW = Date.parse("2026-09-07T12:00:00.000Z");

function grant(overrides: Partial<AdminAccessGrantRecord> & { groupId: string; id: string }): AdminAccessGrantRecord {
  return { enabled: true, modelId: null, provider: null, searchStrategy: null, userId: null, ...overrides };
}

const research: AdminGroup = {
  accessGrants: [
    grant({ groupId: "group-research", id: "g-openai", provider: "conn-openai" }),
    grant({ groupId: "group-research", id: "g-opus", modelId: "opus-5", provider: "conn-anthropic" }),
    grant({ groupId: "group-research", id: "g-search", searchStrategy: "openai-search" })
  ],
  archivedAt: null,
  deletion: { canDelete: false, reason: "group_has_members", summary: "Remove members before deleting this group." },
  id: "group-research",
  name: "Profile · Research",
  systemRole: null,
  userCount: 2
};
const empty: AdminGroup = {
  accessGrants: [],
  archivedAt: null,
  deletion: { canDelete: true, reason: null, summary: "No members or active grants; this group can be deleted." },
  id: "group-empty",
  name: "Interns",
  systemRole: null,
  userCount: 0
};
const archived: AdminGroup = {
  accessGrants: [grant({ groupId: "group-old", id: "g-old", provider: "conn-openai" })],
  archivedAt: "2026-07-01T00:00:00.000Z",
  deletion: { canDelete: false, reason: "group_has_grants", summary: "Remove active grants before deleting this group." },
  id: "group-old",
  name: "Former operators",
  systemRole: null,
  userCount: 1
};
const fullAccess: AdminGroup = {
  accessGrants: [],
  archivedAt: null,
  deletion: { canDelete: false, reason: "system_group_forbidden", summary: "Full access is built in and cannot be renamed, archived, or deleted." },
  id: "group-full",
  name: "Full access",
  systemRole: "full_access",
  userCount: 1
};

function user(overrides: Partial<AdminUserRecord> & { displayName: string; id: string }): AdminUserRecord {
  return {
    directGrants: [],
    effectiveEntitlements: { models: [], providers: [], searchStrategies: [] },
    email: `${overrides.id}@profile.aiqsa.test`,
    groups: [],
    hasVerifiedIdentity: true,
    lastSessionAt: null,
    role: "user",
    status: "active",
    ...overrides
  };
}

const researchMembership = { groupId: "group-research", name: "Profile · Research", role: "member" };
const users: AdminUserRecord[] = [
  user({ displayName: "Camila Collaborator", groups: [researchMembership], id: "camila" }),
  user({ displayName: "Ada Analyst", groups: [researchMembership, { groupId: "group-old", name: "Former operators", role: "member" }], id: "ada" }),
  user({ displayName: "Local Operator", groups: [{ groupId: "group-full", name: "Full access", role: "owner" }], id: "operator", role: "admin" }),
  user({ displayName: "Grace Reviewer", id: "grace" }),
  user({ displayName: "Paused Person", id: "paused", status: "disabled" })
];

function dashboardFixture(): Pick<AdminDashboard, "catalog" | "groups" | "users"> {
  return {
    catalog: {
      models: [
        { displayName: "GPT 5.5", modelId: "gpt-5.5", provider: "conn-openai" },
        { displayName: "GPT Mini", modelId: "gpt-mini", provider: "conn-openai" },
        { displayName: "Claude Opus 5", modelId: "opus-5", provider: "conn-anthropic" },
        { displayName: "Claude Sonnet 5", modelId: "sonnet-5", provider: "conn-anthropic" }
      ],
      providers: [{ id: "conn-openai", name: "OpenAI" }, { id: "conn-anthropic", name: "Anthropic" }],
      searchStrategies: [
        { displayName: "OpenAI Search", strategyId: "openai-search" },
        { displayName: "Google Search", strategyId: "google-search" }
      ]
    },
    groups: [research, empty, archived, fullAccess],
    users
  };
}

const gitlab: AdminMcpServer = {
  activePersonalSlots: [],
  activeRevision: null,
  activation: null,
  archivedAt: null,
  description: "GitLab",
  draft: {
    auth: { mode: "static" },
    runtime: { callTimeoutMs: 60000, startupTimeoutMs: 60000 },
    slots: [],
    source: { kind: "remote", url: "https://mcp.example/gitlab" },
    transport: "streamable_http"
  },
  draftTest: null,
  draftTested: false,
  enabled: true,
  grants: [{ canUse: true, groupId: "group-research", groupName: "Profile · Research", id: "mg-1", personalSlotKeys: [], userId: null, userName: null }],
  id: "server-gitlab",
  name: "GitLab · Bearstars",
  namespace: "gitlab",
  revisions: [],
  sharedValues: {},
  updatedAt: "2026-07-22T00:00:00.000Z",
  validationOAuth: null
};
const antv: AdminMcpServer = {
  ...gitlab,
  activePersonalSlots: [{ label: "API key", slotKey: "api_key" }],
  grants: [],
  id: "server-antv",
  name: "AntV Chart Studio",
  namespace: "antv"
};

function mcpController(): { controller: AdminMcpController; grant: ReturnType<typeof vi.fn> } {
  const grantMock = vi.fn(async () => true);
  return {
    controller: {
      actions: {
        activate: vi.fn(async () => false),
        checkUpdate: vi.fn(async () => false),
        create: vi.fn(async () => ({ message: "unavailable", ok: false as const })),
        delete: vi.fn(async () => false),
        disconnectValidationOAuth: vi.fn(async () => false),
        grant: grantMock,
        rebuild: vi.fn(async () => false),
        refresh: vi.fn(async () => undefined),
        rollback: vi.fn(async () => false),
        save: vi.fn(async () => ({ applied: false })),
        update: vi.fn(async () => false)
      },
      state: { busy: false, error: null, loaded: true, loading: false, servers: [gitlab, antv] }
    },
    grant: grantMock
  };
}

function providerConnections() {
  const opus = fixtureModel({ connectionId: "conn-anthropic", displayName: "Claude Opus 5", id: "opus-5" });
  const capableOpus = {
    ...opus,
    activeConfig: {
      ...opus.activeConfig!,
      adapterKind: "anthropic_messages" as const,
      capabilities: { ...opus.activeConfig!.capabilities, toolCalling: true },
      upstreamModelId: "claude-opus-5"
    }
  };
  return [
    fixtureConnection({
      assignments: [{
        connectionId: "conn-openai",
        credentialId: "cred-research",
        group: { archivedAt: null, id: "group-research", name: "Profile · Research" },
        updatedAt: "2026-09-01T00:00:00.000Z"
      }],
      credentials: [
        fixtureCredential({ id: "cred-primary", label: "Primary" }),
        fixtureCredential({ id: "cred-research", label: "Research team" })
      ],
      defaultCredentialId: "cred-primary",
      displayName: "OpenAI",
      id: "conn-openai",
      models: [
        fixtureModel({ connectionId: "conn-openai", displayName: "GPT 5.5", id: "gpt-5.5" }),
        fixtureModel({ connectionId: "conn-openai", displayName: "GPT Mini", id: "gpt-mini" })
      ]
    }),
    fixtureConnection({
      activeChecks: [fixtureCheck({
        credentialId: "cred-anthropic",
        evidence: {
          compatibility: {
            directPdf: "verified",
            forcedToolCall: "verified",
            modelAccess: "verified",
            probeVersion: 1,
            streaming: "verified",
            structuredOutput: "not_supported",
            usage: "verified"
          },
          detail: "ok",
          method: "tiny_generation",
          selectedProviders: [],
          upstreamModelId: "claude-opus-5"
        },
        providerModelId: "opus-5"
      })],
      credentials: [fixtureCredential({ id: "cred-anthropic", label: "Anthropic key" })],
      defaultCredentialId: "cred-anthropic",
      displayName: "Anthropic",
      family: "anthropic",
      id: "conn-anthropic",
      models: [capableOpus, fixtureModel({ connectionId: "conn-anthropic", displayName: "Claude Sonnet 5", id: "sonnet-5" })]
    })
  ];
}

type Harness = Readonly<{
  confirmations: AdminConfirmedActionRequest[];
  mcpGrant: ReturnType<typeof vi.fn>;
  onSelectResource: ReturnType<typeof vi.fn>;
  posts: AdminActionRequest[];
}>;

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

function renderSection({ actionsDisabled = false, initialDashboard, resource = null }: Readonly<{
  actionsDisabled?: boolean;
  initialDashboard?: ReturnType<typeof dashboardFixture>;
  resource?: string | null;
}> = {}): Harness {
  const posts: AdminActionRequest[] = [];
  const confirmations: AdminConfirmedActionRequest[] = [];
  const onSelectResource = vi.fn();
  const mcp = mcpController();
  const runAction: AdminRunAction = async (body) => {
    posts.push(body);
    return body.action === "create_group" ? { group: { id: "group-new" } } : { ok: true };
  };

  function Section() {
    const dashboard = initialDashboard ?? dashboardFixture();
    const controller = useAdminGroupsController({
      actionsDisabled,
      dashboard,
      requestConfirmedAction: (config) => { confirmations.push(config); },
      runAction
    });
    return (
      <AdminGroupsSection
        dashboard={dashboard}
        groups={controller}
        mcp={mcp.controller}
        nowMs={NOW}
        onSelectResource={onSelectResource}
        resource={resource}
      />
    );
  }

  render(<TopbarHarness><Section /></TopbarHarness>);
  return { confirmations, mcpGrant: mcp.grant, onSelectResource, posts };
}

function providerRow(providerId: string): HTMLElement {
  return screen.getByTestId(`admin-group-provider-${providerId}`);
}

async function openMenu(name: string): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: `More actions for ${name}` }));
}

describe("AdminGroupsSection", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/admin?section=groups");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "/api/admin/providers") return Response.json({ connections: providerConnections() });
      return Response.json({ error: "unexpected_request" }, { status: 500 });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
  });

  it("lists active groups with Full access first, filters by status and search, and opens a row through the resource", async () => {
    const { onSelectResource } = renderSection();

    expect(await screen.findByTestId("topbar-title")).toHaveTextContent("Groups");
    const list = within(screen.getByRole("list", { name: "Groups" }));
    expect(list.getAllByRole("link").map((link) => link.textContent)).toEqual(["Full access", "Interns", "Profile · Research"]);
    expect(list.getByText("Built-in")).toBeInTheDocument();
    expect(list.getByText("3 models · 1 Search source")).toBeInTheDocument();
    expect(list.getByText("No access")).toBeInTheDocument();
    expect(screen.queryByText("Former operators")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Archived · 1" }));
    expect(screen.getByRole("link", { name: "Open Former operators" })).toHaveAttribute("href", "/admin?section=groups&resource=group-old");
    expect(screen.getByText("Archived Jul 1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "All · 4" }));
    expect(screen.getAllByTestId("admin-group-row")).toHaveLength(4);

    fireEvent.change(screen.getByLabelText("Search groups"), { target: { value: "research" } });
    expect(screen.getAllByTestId("admin-group-row")).toHaveLength(1);
    fireEvent.click(screen.getByRole("link", { name: "Open Profile · Research" }));
    expect(onSelectResource).toHaveBeenCalledWith("group-research");

    fireEvent.change(screen.getByLabelText("Search groups"), { target: { value: "nothing here" } });
    expect(screen.getByRole("status")).toHaveTextContent("No groups match this view");
  });

  it("creates a group from the topbar sheet and opens its page", async () => {
    const { onSelectResource, posts } = renderSection();

    fireEvent.click(await screen.findByRole("button", { name: "New group" }));
    const sheet = await screen.findByRole("dialog", { name: "New group" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Create" }));
    const name = within(sheet).getByLabelText("Group name");
    await waitFor(() => expect(name).toHaveAttribute("aria-invalid", "true"));
    expect(name).toHaveAccessibleDescription(/group name/iu);
    await waitFor(() => expect(name).toHaveFocus());
    expect(posts).toEqual([]);

    fireEvent.change(name, { target: { value: "Profile · Design" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(posts).toEqual([{ action: "create_group", name: "Profile · Design" }]));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New group" })).not.toBeInTheDocument());
    await waitFor(() => expect(onSelectResource).toHaveBeenCalledWith("group-new"));
  });

  it("shows the page with crumbs, summary, members and the add-a-person picker", async () => {
    const { posts } = renderSection({ resource: "group-research" });

    const page = await screen.findByTestId("admin-group-page");
    await waitFor(() => expect(page).toHaveFocus());
    expect(within(page).getByRole("heading", { name: "Profile · Research" })).toBeInTheDocument();
    expect(within(page).getByText("2 members · 3 models · 1 Search source · 1 MCP server")).toBeInTheDocument();
    const title = await screen.findByTestId("topbar-title");
    expect(title).toHaveTextContent("Groups");
    expect(title).toHaveTextContent("Profile · Research");

    const members = within(screen.getByRole("list", { name: "Members" }));
    expect(members.getAllByTestId("admin-group-member").map((row) => row.textContent)).toEqual([
      expect.stringContaining("Ada Analyst"),
      expect.stringContaining("Camila Collaborator")
    ]);
    fireEvent.click(members.getAllByRole("button", { name: "Remove" })[0]!);
    await waitFor(() => expect(posts).toContainEqual({ action: "set_user_groups", expectedGroupIds: ["group-research"], groupIds: [], userId: "ada" }));

    fireEvent.click(screen.getByRole("button", { name: "Add a person" }));
    const search = await screen.findByRole("combobox", { name: "Search people" });
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      expect.stringContaining("Grace Reviewer"),
      expect.stringContaining("Local Operator")
    ]);
    fireEvent.change(search, { target: { value: "grace" } });
    fireEvent.click(screen.getByRole("option", { name: /Grace Reviewer/u }));
    await waitFor(() => expect(posts).toContainEqual({ action: "set_user_groups", expectedGroupIds: [], groupIds: ["group-research"], userId: "grace" }));
  });

  it("switches a provider between all models and a checklist, shows the key line and capability chips", async () => {
    const { posts } = renderSection({ resource: "group-research" });
    await screen.findByTestId("admin-group-page");

    const openai = providerRow("conn-openai");
    expect(openai).toHaveAttribute("data-provider-access", "all");
    expect(within(openai).getByText("All models, including ones added later")).toBeInTheDocument();
    expect(within(openai).queryByRole("checkbox")).not.toBeInTheDocument();
    // The key line renders once for wide rows and once under the row for narrow ones.
    const keys = await within(openai).findAllByText("Key: Research team");
    expect(keys).toHaveLength(2);
    expect(keys[0]).toHaveClass("text-proof");

    const anthropic = providerRow("conn-anthropic");
    expect(anthropic).toHaveAttribute("data-provider-access", "some");
    expect(within(anthropic).getByText("1 of 2 models")).toBeInTheDocument();
    expect(within(anthropic).getByRole("checkbox", { name: "Claude Opus 5" })).toBeChecked();
    expect(within(anthropic).getByRole("checkbox", { name: "Claude Sonnet 5" })).not.toBeChecked();
    expect(await within(anthropic).findAllByText("Key: Anthropic key (default)")).toHaveLength(2);
    const opusRow = within(anthropic).getByRole("checkbox", { name: "Claude Opus 5" }).closest('[data-testid="admin-group-model"]')!;
    await waitFor(() => expect(within(opusRow as HTMLElement).getByText("Tools")).toBeInTheDocument());
    expect(within(opusRow as HTMLElement).getByText("PDF")).toBeInTheDocument();
    expect(within(opusRow as HTMLElement).queryByText("JSON")).not.toBeInTheDocument();
    expect(within(opusRow as HTMLElement).queryByText("Images")).not.toBeInTheDocument();

    fireEvent.click(within(anthropic).getByRole("switch", { name: "All Anthropic models, including ones added later" }));
    await waitFor(() => expect(posts).toContainEqual({
      action: "set_group_grants",
      changes: [{ enabled: true, provider: "conn-anthropic" }],
      groupId: "group-research"
    }));
    fireEvent.click(within(anthropic).getByRole("checkbox", { name: "Claude Sonnet 5" }));
    await waitFor(() => expect(posts).toContainEqual({
      action: "set_group_grants",
      changes: [{ enabled: true, modelId: "sonnet-5", provider: "conn-anthropic" }],
      groupId: "group-research"
    }));
    fireEvent.click(within(openai).getByRole("switch", { name: "All OpenAI models, including ones added later" }));
    await waitFor(() => expect(posts).toContainEqual({
      action: "set_group_grants",
      changes: [{ enabled: false, provider: "conn-openai" }],
      groupId: "group-research"
    }));
  });

  it("grants or clears every model of a provider as one request", async () => {
    const { posts } = renderSection({ resource: "group-research" });
    await screen.findByTestId("admin-group-page");
    const anthropic = providerRow("conn-anthropic");

    fireEvent.click(within(anthropic).getByRole("button", { name: "Grant all Anthropic models to Profile · Research" }));
    await waitFor(() => expect(posts).toEqual([{
      action: "set_group_grants",
      changes: [
        { enabled: true, modelId: "opus-5", provider: "conn-anthropic" },
        { enabled: true, modelId: "sonnet-5", provider: "conn-anthropic" }
      ],
      groupId: "group-research"
    }]));
    fireEvent.click(within(anthropic).getByRole("button", { name: "Revoke all Anthropic models from Profile · Research" }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]).toEqual({
      action: "set_group_grants",
      changes: [
        { enabled: false, modelId: "opus-5", provider: "conn-anthropic" },
        { enabled: false, modelId: "sonnet-5", provider: "conn-anthropic" }
      ],
      groupId: "group-research"
    });
  });

  it("toggles Search sources through the batch and MCP servers through the MCP controller", async () => {
    const { mcpGrant, posts } = renderSection({ resource: "group-research" });
    await screen.findByTestId("admin-group-page");

    const search = within(screen.getByTestId("admin-group-search"));
    expect(search.getByRole("switch", { name: "OpenAI Search for Profile · Research" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(search.getByRole("switch", { name: "Google Search for Profile · Research" }));
    await waitFor(() => expect(posts).toEqual([{
      action: "set_group_grants",
      changes: [{ enabled: true, searchStrategy: "google-search" }],
      groupId: "group-research"
    }]));

    const mcp = within(screen.getByTestId("admin-group-mcp"));
    expect(mcp.getByRole("switch", { name: "GitLab · Bearstars for Profile · Research" })).toHaveAttribute("aria-checked", "true");
    expect(mcp.getByText("Needs personal values from each member")).toBeInTheDocument();
    fireEvent.click(mcp.getByRole("switch", { name: "AntV Chart Studio for Profile · Research" }));
    expect(mcpGrant).toHaveBeenCalledWith("server-antv", { canUse: true, groupId: "group-research" });
  });

  it("keeps grants to unavailable resources visible and removable without adding them to the catalog", async () => {
    const disabledModel = grant({ groupId: research.id, id: "disabled-model-grant", modelId: "disabled-model", provider: "disabled-provider", resourceDisplayName: "Retired provider / Retired model" });
    const archivedSearch = grant({ groupId: research.id, id: "archived-search-grant", resourceDisplayName: "Retired Search", searchStrategy: "archived-search" });
    const dashboard = dashboardFixture();
    const { posts } = renderSection({ initialDashboard: { ...dashboard, groups: [{ ...research, accessGrants: [...research.accessGrants, disabledModel, archivedSearch] }] }, resource: research.id });
    const list = await screen.findByRole("list", { name: "Unavailable grants" });
    expect(list).toHaveTextContent("Retired provider / Retired model");
    expect(list).toHaveTextContent("Retired Search");
    for (const button of within(list).getAllByRole("button", { name: "Remove grant" })) fireEvent.click(button);
    await waitFor(() => expect(posts).toEqual([
      { action: "set_group_grants", changes: [{ enabled: false, modelId: "disabled-model", provider: "disabled-provider", searchStrategy: null }], groupId: research.id },
      { action: "set_group_grants", changes: [{ enabled: false, modelId: null, provider: null, searchStrategy: "archived-search" }], groupId: research.id }
    ]));
    expect(screen.queryByTestId("admin-group-provider-disabled-provider")).not.toBeInTheDocument();
  });

  it("renames from the header and the menu, and archives or deletes through the shared confirmation", async () => {
    const { confirmations, posts } = renderSection({ resource: "group-research" });
    const page = await screen.findByTestId("admin-group-page");

    fireEvent.click(within(page).getByRole("button", { name: "Rename" }));
    const sheet = await screen.findByRole("dialog", { name: "Rename group" });
    const name = within(sheet).getByLabelText("Group name");
    expect(name).toHaveValue("Profile · Research");
    fireEvent.change(name, { target: { value: "" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(name).toHaveAttribute("aria-invalid", "true"));
    await waitFor(() => expect(name).toHaveFocus());
    fireEvent.change(name, { target: { value: "Profile · R&D" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posts).toEqual([{ action: "rename_group", groupId: "group-research", name: "Profile · R&D" }]));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Rename group" })).not.toBeInTheDocument());

    await openMenu("Profile · Research");
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeDisabled();
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
    expect(confirmations.map((config) => config.testId)).toEqual(["admin-confirm-archive-group"]);
    expect(confirmations[0]!.body).toEqual({ action: "archive_group", groupId: "group-research" });

    await openMenu("Profile · Research");
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    expect(await screen.findByRole("dialog", { name: "Rename group" })).toBeInTheDocument();
  });

  it("deletes an empty group from the menu and returns to the list", async () => {
    const { confirmations, onSelectResource } = renderSection({ resource: "group-empty" });
    await screen.findByTestId("admin-group-page");

    await openMenu("Interns");
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(confirmations[0]).toMatchObject({ body: { action: "delete_group", groupId: "group-empty" }, testId: "admin-confirm-delete-group" });
    confirmations[0]!.onSuccess?.();
    await waitFor(() => expect(onSelectResource).toHaveBeenCalledWith(null));
  });

  it("keeps Full access read-only with its explanation while members stay editable", async () => {
    renderSection({ resource: "group-full" });
    const page = await screen.findByTestId("admin-group-page");

    expect(within(page).getByTestId("admin-group-full-access")).toHaveTextContent(/Full access is built in/u);
    expect(within(page).getByText("1 member · every provider, model, Search source and MCP server")).toBeInTheDocument();
    expect(within(page).queryByRole("switch")).not.toBeInTheDocument();
    expect(within(page).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(within(page).queryByRole("button", { name: "Rename" })).not.toBeInTheDocument();
    expect(within(page).getByRole("button", { name: "Add a person" })).toBeEnabled();
    expect(within(page).getByRole("button", { name: "Remove" })).toBeEnabled();
    await waitFor(() => expect(screen.getByTestId("topbar-title")).toHaveTextContent("Full access"));
    expect(screen.queryByRole("button", { name: /More actions/u })).not.toBeInTheDocument();
  });

  it("shows an archived group read-only and leaves only Delete in the menu", async () => {
    renderSection({ resource: "group-old" });
    const page = await screen.findByTestId("admin-group-page");

    expect(within(page).getByRole("status")).toHaveTextContent(/archived/iu);
    expect(within(page).getByText("Archived Jul 1")).toBeInTheDocument();
    expect(within(page).queryByRole("button", { name: "Add a person" })).not.toBeInTheDocument();
    expect(within(page).queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
    expect(within(page).queryByRole("button", { name: "Rename" })).not.toBeInTheDocument();
    for (const control of within(page).getAllByRole("switch")) expect(control).toBeDisabled();

    await openMenu("Former operators");
    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeDisabled();
    expect(screen.queryByRole("menuitem", { name: "Archive" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeDisabled();
  });

  it("explains a missing group and offers the way back", async () => {
    const { onSelectResource } = renderSection({ resource: "group-missing" });

    expect(await screen.findByRole("alert")).toHaveTextContent("This group no longer exists.");
    fireEvent.click(screen.getByRole("button", { name: "Back to groups" }));
    expect(onSelectResource).toHaveBeenCalledWith(null);
  });
});
