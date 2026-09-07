import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState, type ReactNode } from "react";
import { AdminSectionTopbarProvider, type AdminShellTopbar } from "@/components/admin/AdminShell";
import type { AdminConfirmationRequest } from "@/components/admin/useAdminConfirmationController";
import type { AdminGroup } from "@/lib/contracts/admin";
import type { AdminProviderConnection } from "@/lib/contracts/adminProviders";
import { AdminProvidersSection } from "./AdminProvidersSection";
import {
  fixtureCheck,
  fixtureConnection,
  fixtureCredential,
  fixtureModel,
  workingConnection
} from "./providerFixtures";

const groups: AdminGroup[] = [
  { accessGrants: [], archivedAt: null, id: "group-research", name: "Research", systemRole: null, userCount: 4 },
  { accessGrants: [], archivedAt: null, id: "group-finance", name: "Finance", systemRole: null, userCount: 2 }
];

function catalog(): AdminProviderConnection[] {
  const openai = workingConnection();
  openai.assignments = [{
    connectionId: openai.id,
    credentialId: "cred-primary",
    group: { archivedAt: null, id: "group-research", name: "Research" },
    updatedAt: "2026-09-01T00:00:00.000Z"
  }];
  const deepseek = fixtureConnection({
    activeChecks: [fixtureCheck({ credentialId: "cred-ds", providerModelId: "model-ds", status: "unavailable" })],
    credentials: [fixtureCredential({ id: "cred-ds", label: "Primary" })],
    defaultCredentialId: "cred-ds",
    displayName: "DeepSeek",
    family: "deepseek",
    id: "conn-deepseek",
    models: [fixtureModel({ connectionId: "conn-deepseek", displayName: "DeepSeek V4 Pro", id: "model-ds" })]
  });
  const gemini = fixtureConnection({ displayName: "Gemini", family: "gemini", id: "conn-gemini" });
  const custom = fixtureConnection({
    credentials: [fixtureCredential({ id: "cred-custom", label: "Primary" })],
    defaultCredentialId: "cred-custom",
    displayName: "codex-lb",
    enabled: false,
    family: "openai_compatible",
    id: "conn-custom",
    models: [fixtureModel({ connectionId: "conn-custom", displayName: "GPT-5.6 Luna", id: "model-custom" })]
  });
  return [openai, deepseek, gemini, custom];
}

type Router = (input: { body: Record<string, unknown> | null; method: string; url: string }) =>
  Response | null | undefined;

function mockFetch(connections: { current: AdminProviderConnection[] }, router: Router = () => null) {
  const calls: Array<{ body: Record<string, unknown> | null; method: string; url: string }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
    calls.push({ body, method, url });
    const routed = router({ body, method, url });
    if (routed) return routed;
    if (url === "/api/admin/providers" && method === "GET") {
      return Response.json({ connections: connections.current });
    }
    return Response.json({ error: "unexpected_request" }, { status: 500 });
  });
  return calls;
}

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

function renderSection(resource: string | null = null) {
  const confirmations: AdminConfirmationRequest[] = [];
  const feedback = { reportError: vi.fn(), reportNotice: vi.fn() };
  const onSelectResource = vi.fn();
  const onNavigateSection = vi.fn();
  const view = render(
    <TopbarHarness>
      <AdminProvidersSection
        active
        feedback={feedback}
        groups={groups}
        onNavigateSection={onNavigateSection}
        onSelectResource={onSelectResource}
        requestConfirmation={(config) => { confirmations.push(config); }}
        resource={resource}
      />
    </TopbarHarness>
  );
  return { confirmations, feedback, onNavigateSection, onSelectResource, view };
}

describe("AdminProvidersSection", () => {
  const connections = { current: catalog() };

  beforeEach(() => {
    connections.current = catalog();
    window.history.replaceState(null, "", "/admin?section=providers");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists providers with the PRD statuses, subtitles and the Add provider action, and opens a page from a row", async () => {
    mockFetch(connections);
    const { onNavigateSection, onSelectResource } = renderSection();

    const list = await screen.findByRole("list", { name: "Providers" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(4);
    const statuses = rows.map((row) => within(row).getByTestId("provider-status").textContent);
    expect(statuses).toEqual(["Working", "Key rejected", "Not checked", "Disabled"]);
    expect(within(rows[3]!).getByRole("link")).toHaveClass("opacity-65");
    expect(rows[0]).toHaveTextContent("GPT-5.6 Terra, GPT-5.6 Luna");
    expect(rows[3]).toHaveTextContent("Custom · codex-lb.example.test · 1 model");
    expect(list).not.toHaveTextContent("/v1");
    expect(within(rows[0]!).getByRole("link")).toHaveAttribute("href", "/admin?section=providers&resource=conn-openai");
    expect(screen.getByTestId("topbar-title")).toHaveTextContent("Providers");
    await waitFor(() => expect(screen.getByRole("button", { name: "Add provider" })).toBeEnabled());
    expect(screen.queryByText(/draft|revision|pending|evidence|probe|adapter/iu)).not.toBeInTheDocument();

    fireEvent.click(within(rows[1]!).getByRole("link"));
    expect(onSelectResource).toHaveBeenCalledWith("conn-deepseek");
    fireEvent.click(screen.getByRole("link", { name: "Defaults & roles" }));
    expect(onNavigateSection).toHaveBeenCalledWith("roles");
  });

  it("adds a key with one Test & Save, keeps the catalog unchanged when the provider rejects it", async () => {
    const calls = mockFetch(connections, ({ body, method, url }) => {
      if (method === "POST" && url === "/api/admin/providers/conn-gemini/credentials") {
        if (body?.secret === "bad-key") {
          return Response.json({ error: "provider_credential_test_failed" }, { status: 422 });
        }
        connections.current = connections.current.map((connection) => connection.id === "conn-gemini"
          ? {
              ...connection,
              credentials: [fixtureCredential({
                createdAt: "2026-09-07T12:00:00.000Z",
                id: "cred-new",
                label: String(body?.label)
              })],
              defaultCredentialId: "cred-new"
            }
          : connection);
        return Response.json({ connections: connections.current }, { status: 201 });
      }
      return null;
    });
    const { confirmations, feedback } = renderSection("conn-gemini");

    expect(await screen.findByTestId("provider-page-status")).toHaveTextContent("No keys yet · No models on");
    // The topbar is owned through a context effect, so it settles one tick after the page.
    await waitFor(() => expect(screen.getByTestId("topbar-title")).toHaveTextContent("Gemini"));
    expect(screen.getByTestId("topbar-title")).toHaveTextContent("Providers");
    expect(screen.getByRole("switch", { name: "Gemini enabled" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Add key" }));
    const form = screen.getByTestId("provider-key-form");
    fireEvent.change(within(form).getByLabelText("Label"), { target: { value: "Primary" } });
    fireEvent.change(within(form).getByLabelText("API key"), { target: { value: "bad-key" } });
    fireEvent.click(within(form).getByRole("button", { name: "Test & Save" }));

    const alert = await within(form).findByRole("alert");
    expect(alert).toHaveTextContent("The provider rejected this key. Check the key and try again.");
    expect(within(form).getByLabelText("API key")).toHaveAttribute("aria-invalid", "true");
    expect(within(form).getByLabelText("API key")).toHaveValue("bad-key");
    expect(screen.queryByTestId("provider-key-cred-new")).not.toBeInTheDocument();
    expect(feedback.reportError).not.toHaveBeenCalled();
    expect(calls.filter(({ method }) => method === "POST").at(-1)?.body).toEqual({
      activate: true,
      label: "Primary",
      secret: "bad-key"
    });

    fireEvent.change(within(form).getByLabelText("API key"), { target: { value: "good-key" } });
    fireEvent.click(within(form).getByRole("button", { name: "Test & Save" }));
    const row = await screen.findByTestId("provider-key-cred-new");
    expect(row).toHaveTextContent("Primary");
    expect(row).toHaveTextContent("Default key");
    expect(within(row).getByTestId("provider-key-detail")).toHaveTextContent("Working · added Sep 7");
    expect(screen.queryByTestId("provider-key-form")).not.toBeInTheDocument();
    expect(feedback.reportNotice).toHaveBeenCalledWith("Key saved and working.");
    expect(confirmations).toHaveLength(0);
    expect(document.body.textContent).not.toContain("good-key");
    expect(screen.getByTestId("provider-page-status")).toHaveTextContent("All keys working");
  });

  it("rotates a key in one step and changes the default key and group overrides without confirmation", async () => {
    const calls = mockFetch(connections, ({ body, method, url }) => {
      if (method === "PATCH" && url === "/api/admin/providers/conn-openai/credentials/cred-primary") {
        return Response.json({ connections: connections.current });
      }
      if (method === "POST" && url === "/api/admin/providers/conn-openai/actions") {
        if (body?.action === "revoke_group_credential") {
          connections.current = connections.current.map((connection) => connection.id === "conn-openai"
            ? { ...connection, assignments: [] }
            : connection);
        }
        if (body?.action === "assign_group_credential") {
          connections.current = connections.current.map((connection) => connection.id === "conn-openai"
            ? {
                ...connection,
                assignments: [...connection.assignments, {
                  connectionId: connection.id,
                  credentialId: String(body.credentialId),
                  group: { archivedAt: null, id: String(body.groupId), name: "Finance" },
                  updatedAt: "2026-09-07T00:00:00.000Z"
                }]
              }
            : connection);
        }
        return Response.json({ connections: connections.current });
      }
      return null;
    });
    const { confirmations } = renderSection("conn-openai");

    const primary = await screen.findByTestId("provider-key-cred-primary");
    expect(within(primary).getByTestId("provider-key-detail")).toHaveTextContent("Working · used by group Research");
    fireEvent.click(within(primary).getByRole("button", { name: "Rotate Primary" }));
    const form = screen.getByTestId("provider-key-form");
    expect(within(form).queryByLabelText("Label")).not.toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText("New API key for Primary"), { target: { value: "rotated-key" } });
    fireEvent.click(within(form).getByRole("button", { name: "Test & Save" }));
    await waitFor(() => expect(screen.queryByTestId("provider-key-form")).not.toBeInTheDocument());
    expect(calls.find(({ method }) => method === "PATCH")?.body).toEqual({
      action: "rotate",
      activate: true,
      expectedDraftVersion: 1,
      secret: "rotated-key"
    });

    fireEvent.change(screen.getByRole("combobox", { name: "Default key" }), { target: { value: "" } });
    await waitFor(() => expect(calls.some(({ body }) => body?.action === "set_default_credential")).toBe(true));
    expect(calls.find(({ body }) => body?.action === "set_default_credential")?.body).toEqual({
      action: "set_default_credential",
      credentialId: null
    });

    expect(screen.getByText("Research → Primary")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove override for Research" }));
    await waitFor(() => expect(screen.queryByText("Research → Primary")).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Override" }));
    fireEvent.click(screen.getByRole("button", { name: "Group" }));
    fireEvent.click(await screen.findByRole("option", { name: /Finance/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add override" }));
    await waitFor(() => expect(screen.getByText("Finance → Primary")).toBeInTheDocument());
    expect(calls.find(({ body }) => body?.action === "assign_group_credential")?.body).toEqual({
      action: "assign_group_credential",
      credentialId: "cred-primary",
      groupId: "group-finance"
    });
    expect(confirmations).toHaveLength(0);
  });

  it("asks once before revoking a key and before deleting the provider, and explains server blockers", async () => {
    const calls = mockFetch(connections, ({ body, method, url }) => {
      if (method === "PATCH" && url === "/api/admin/providers/conn-openai/credentials/cred-primary") {
        return Response.json({ connections: connections.current });
      }
      if (method === "POST" && url === "/api/admin/providers/conn-openai/actions" && body?.action === "disable") {
        connections.current = connections.current.map((connection) => connection.id === "conn-openai"
          ? { ...connection, enabled: false }
          : connection);
        return Response.json({ connections: connections.current });
      }
      if (method === "DELETE" && url === "/api/admin/providers/conn-openai") {
        return Response.json({
          blockers: [{ count: 2, kind: "assistants" }, { count: 1, kind: "system_model" }],
          error: "provider_delete_conflict"
        }, { status: 409 });
      }
      return null;
    });
    const { confirmations, feedback, onSelectResource } = renderSection("conn-openai");

    const primary = await screen.findByTestId("provider-key-cred-primary");
    fireEvent.click(within(primary).getByRole("button", { name: "More actions for Primary" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Revoke" }));
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]).toMatchObject({ confirmLabel: "Revoke key", title: "Revoke “Primary”?" });
    await act(async () => { await confirmations[0]!.onConfirm(); });
    expect(calls.find(({ method }) => method === "PATCH")?.body).toEqual({
      action: "revoke_active_version",
      clearSecret: true,
      confirmed: true,
      versionId: "cred-primary-version"
    });

    fireEvent.click(screen.getByRole("button", { name: "More actions for OpenAI" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete provider" }));
    expect(confirmations).toHaveLength(2);
    expect(confirmations[1]).toMatchObject({ confirmLabel: "Delete provider", title: "Delete “OpenAI”?" });
    await act(async () => { await confirmations[1]!.onConfirm(); });
    expect(calls.some(({ body }) => body?.action === "disable")).toBe(true);
    expect(calls.some(({ method }) => method === "DELETE")).toBe(true);
    expect(feedback.reportError).toHaveBeenCalledWith(
      "“OpenAI” was turned off but not deleted. Used by 2 Assistants and a system role — reassign first."
    );
    expect(onSelectResource).not.toHaveBeenCalled();
  });

  it("saves connection settings as one Test & Save and asks for the key again only when the endpoint changes", async () => {
    const calls = mockFetch(connections, ({ body, method, url }) => {
      if (method === "PATCH" && url === "/api/admin/providers/conn-openai") {
        connections.current = connections.current.map((connection) => connection.id === "conn-openai"
          ? {
              ...connection,
              displayName: String(body?.displayName),
              draftConfig: body?.configuration as AdminProviderConnection["draftConfig"],
              draftVersion: connection.draftVersion + 1
            }
          : connection);
        return Response.json({ connections: connections.current });
      }
      if (method === "PATCH" && url === "/api/admin/providers/conn-openai/credentials/cred-primary") {
        return Response.json({ connections: connections.current });
      }
      if (method === "POST" && url === "/api/admin/providers/conn-openai/actions" && body?.action === "activate") {
        connections.current = connections.current.map((connection) => connection.id === "conn-openai"
          ? { ...connection, activeConfig: connection.draftConfig, activeVersion: connection.draftVersion }
          : connection);
        return Response.json({ connections: connections.current });
      }
      return null;
    });
    const { feedback } = renderSection("conn-openai");

    fireEvent.click(await screen.findByRole("button", { name: "Connection settings" }));
    const sheet = await screen.findByRole("dialog", { name: "Connection settings" });
    expect(within(sheet).queryByLabelText(/API key/)).not.toBeInTheDocument();
    fireEvent.change(within(sheet).getByLabelText(/^Response timeout/), { target: { value: "120" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Test & Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Connection settings" })).not.toBeInTheDocument());
    expect(calls.filter(({ method }) => method !== "GET").map(({ body, method, url }) => ({ action: body?.action, method, url }))).toEqual([
      { action: undefined, method: "PATCH", url: "/api/admin/providers/conn-openai" },
      { action: "activate", method: "POST", url: "/api/admin/providers/conn-openai/actions" }
    ]);
    expect(calls.find(({ method }) => method === "PATCH")?.body).toMatchObject({
      configuration: { responseTimeoutSeconds: 120 },
      expectedDraftVersion: 1
    });
    expect(calls.find(({ body }) => body?.action === "activate")?.body).toEqual({
      action: "activate",
      confirmUnavailable: true,
      enableConnection: true
    });
    expect(feedback.reportNotice).toHaveBeenCalledWith("Connection settings saved.");
    calls.length = 0;

    fireEvent.click(screen.getByRole("button", { name: "Connection settings" }));
    const reopened = await screen.findByRole("dialog", { name: "Connection settings" });
    fireEvent.change(within(reopened).getByLabelText(/^Endpoint/), { target: { value: "https://gateway.example.test/v1" } });
    const keyField = within(reopened).getByLabelText(/^API key for Primary/);
    fireEvent.click(within(reopened).getByRole("button", { name: "Test & Save" }));
    expect(await within(reopened).findByRole("alert")).toHaveTextContent("Enter the key for “Primary” again");
    expect(calls.filter(({ method }) => method !== "GET")).toHaveLength(0);
    fireEvent.change(keyField, { target: { value: "re-entered-key" } });
    fireEvent.click(within(reopened).getByRole("button", { name: "Test & Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Connection settings" })).not.toBeInTheDocument());
    expect(calls.filter(({ method }) => method !== "GET").map(({ body, method }) => ({ action: body?.action, activate: body?.activate, method }))).toEqual([
      { action: undefined, activate: undefined, method: "PATCH" },
      { action: "rotate", activate: undefined, method: "PATCH" },
      { action: "activate", activate: undefined, method: "POST" }
    ]);
    expect(document.body.textContent).not.toContain("re-entered-key");

    fireEvent.click(screen.getByRole("button", { name: "Connection settings" }));
    const dirty = await screen.findByRole("dialog", { name: "Connection settings" });
    fireEvent.change(within(dirty).getByLabelText("Name"), { target: { value: "OpenAI (EU)" } });
    fireEvent.keyDown(dirty, { key: "Escape" });
    const discard = await screen.findByRole("dialog", { name: "Discard unsaved connection settings" });
    fireEvent.click(within(discard).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("dialog", { name: "Connection settings" })).toBeInTheDocument();
    fireEvent.keyDown(dirty, { key: "Escape" });
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Discard unsaved connection settings" }))
      .getByRole("button", { name: "Confirm discard changes" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("turns the provider off from the topbar switch and shows the Add provider entry behind the primary action", async () => {
    const calls = mockFetch(connections, ({ body, method, url }) => {
      if (method === "POST" && url === "/api/admin/providers/conn-openai/actions") {
        connections.current = connections.current.map((connection) => connection.id === "conn-openai"
          ? { ...connection, enabled: body?.action === "enable" }
          : connection);
        return Response.json({ connections: connections.current });
      }
      if (url === "/api/admin/providers/quick-setup") {
        return Response.json({
          configuredConnections: [],
          providers: [
            { provider: "openai", providerDisplayName: "OpenAI", quickSetupAssigned: false, state: "not_configured", stateToken: "s1" },
            { provider: "anthropic", providerDisplayName: "Anthropic", quickSetupAssigned: false, state: "not_configured", stateToken: "s2" },
            { provider: "deepseek", providerDisplayName: "DeepSeek", quickSetupAssigned: false, state: "not_configured", stateToken: "s3" },
            { provider: "gemini", providerDisplayName: "Gemini", quickSetupAssigned: false, state: "not_configured", stateToken: "s4" },
            { provider: "openrouter", providerDisplayName: "OpenRouter", quickSetupAssigned: false, state: "not_configured", stateToken: "s5" }
          ],
          suggestedProvider: null
        });
      }
      return null;
    });
    const { view, feedback } = renderSection("conn-openai");

    const toggle = await screen.findByRole("switch", { name: "OpenAI enabled" });
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByRole("switch", { name: "OpenAI enabled" })).not.toBeChecked());
    expect(calls.find(({ body }) => body?.action === "disable")).toBeTruthy();
    expect(feedback.reportNotice).toHaveBeenCalledWith("Provider turned off.");

    view.rerender(
      <TopbarHarness>
        <AdminProvidersSection
          active
          feedback={feedback}
          groups={groups}
          onNavigateSection={vi.fn()}
          onSelectResource={vi.fn()}
          requestConfirmation={vi.fn()}
          resource={null}
        />
      </TopbarHarness>
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Add provider" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
    expect(await screen.findByTestId("provider-add-entry")).toBeInTheDocument();
    expect(screen.getByTestId("topbar-title")).toHaveTextContent("Add provider");
    expect(await screen.findByRole("button", { name: /OpenAI Not configured/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "Providers" }));
    expect(await screen.findByRole("list", { name: "Providers" })).toBeInTheDocument();
  });
});
