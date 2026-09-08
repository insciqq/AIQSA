import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fixtureConnection, fixtureCredential } from "@/components/admin/providers/providerFixtures";
import type { AdminRunAction } from "@/components/admin/useAdminActionRunner";
import { useAdminUsersController } from "@/components/admin/useAdminUsersController";
import type { AdminCatalog, AdminUserRecord } from "@/lib/contracts/admin";
import type { AdminProviderConnection } from "@/lib/contracts/adminProviders";
import { AdminUserDirectGrants, AdminUserDirectKeys } from "./AdminUserDirectAccess";

const catalog: AdminCatalog = {
  models: [{ displayName: "Answer", modelId: "model", provider: "provider" }],
  providers: [{ id: "provider", name: "Provider" }],
  searchStrategies: [{ displayName: "Web", strategyId: "web" }]
};
const person: AdminUserRecord = {
  directGrants: [{ enabled: true, groupId: null, id: "direct", modelId: "model", provider: "provider", searchStrategy: null, userId: "person" }],
  displayName: "Person", email: "person@example.test",
  effectiveEntitlements: { models: [{ modelId: "model", provider: "provider" }], providers: [], searchStrategies: [] },
  groups: [{ groupId: "full", name: "Full access", role: "member" }],
  hasVerifiedIdentity: true, id: "person", lastSessionAt: null, role: "user", status: "active"
};
const refresh = vi.fn(async () => true);
function Harness({ connection, error = null, loaded = true, runAction, user = person }: Readonly<{
  connection?: AdminProviderConnection;
  error?: string | null;
  loaded?: boolean;
  runAction: AdminRunAction;
  user?: AdminUserRecord;
}>) {
  const users = useAdminUsersController({ actionsDisabled: false, adminUserId: "admin", dashboard: { groups: [] }, requestConfirmedAction: vi.fn(), runAction });
  return connection
    ? <AdminUserDirectKeys providers={{ connections: [connection], error, loaded, refresh }} user={user} users={users} />
    : <AdminUserDirectGrants catalog={catalog} user={user} users={users} />;
}

function connection(credentialId = "key-a", updatedAt = "2026-09-08T12:00:00.000Z"): AdminProviderConnection {
  return fixtureConnection({
    credentials: [fixtureCredential({ id: "key-a", label: "Alpha" }), fixtureCredential({ id: "key-b", label: "Beta" })],
    displayName: "Provider", id: "provider",
    userAssignments: [{ connectionId: "provider", credentialId, updatedAt, user: { displayName: person.displayName, email: person.email, id: person.id, status: person.status } }]
  });
}

describe("direct user access controls", () => {
  it("shows exact direct grants for a Full access member and revokes only that user's grant", async () => {
    const runAction = vi.fn<AdminRunAction>(async () => ({ ok: true }));
    render(<Harness runAction={runAction} />);
    const list = screen.getByRole("list", { name: "Direct grants" });
    expect(list).toHaveTextContent("Provider / Answer");
    fireEvent.click(within(list).getByRole("button", { name: "Remove grant" }));
    await waitFor(() => expect(runAction).toHaveBeenCalledWith({
      action: "set_user_grants", changes: [{ enabled: false, modelId: "model", provider: "provider", searchStrategy: null }], expectedGrantIds: ["direct"], userId: "person"
    }, expect.any(String)));
    expect(screen.getByText(/preserves access granted by groups/u)).toBeInTheDocument();
  });

  it("adds a direct resource from the catalog and retains the selection on a rejected save", async () => {
    const runAction = vi.fn<AdminRunAction>(async () => ({ error: "user_access_stale" }));
    render(<Harness runAction={runAction} />);
    const select = screen.getByRole("combobox", { name: "Resource to grant" });
    fireEvent.change(select, { target: { value: "search:web" } });
    fireEvent.click(screen.getByRole("button", { name: "Grant access" }));
    await waitFor(() => expect(runAction).toHaveBeenCalledWith({
      action: "set_user_grants", changes: [{ enabled: true, modelId: null, provider: null, searchStrategy: "web" }], expectedGrantIds: ["direct"], userId: "person"
    }, expect.any(String)));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Reload/u);
    expect(select).toHaveValue("search:web");
  });

  it("keeps a key edit bound to the assignment shown when editing began after a background refresh", async () => {
    const runAction = vi.fn<AdminRunAction>(async () => ({ error: "user_access_stale" }));
    const view = render(<Harness connection={connection()} runAction={runAction} />);
    const select = screen.getByRole("combobox", { name: "Key for Provider" });
    fireEvent.change(select, { target: { value: "key-b" } });
    view.rerender(<Harness connection={connection("key-a", "2026-09-08T13:00:00.000Z")} runAction={runAction} />);
    fireEvent.click(screen.getByRole("button", { name: "Save key for Provider" }));
    await waitFor(() => expect(runAction).toHaveBeenCalledWith({
      action: "set_user_credential", connectionId: "provider", credentialId: "key-b", expectedCredentialId: "key-a", expectedUpdatedAt: "2026-09-08T12:00:00.000Z", userId: "person"
    }, expect.any(String)));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Reload/u);
    expect(select).toHaveValue("key-b");
  });

  it("retains removal for a disabled user's unavailable grants and key override", async () => {
    const runAction = vi.fn<AdminRunAction>(async () => ({ ok: true }));
    const disabled: AdminUserRecord = { ...person, directGrants: [{ ...person.directGrants[0], enabled: false, modelId: "retired", resourceDisplayName: "Provider / Retired" }], status: "disabled" };
    const view = render(<Harness runAction={runAction} user={disabled} />);
    expect(screen.getByRole("list", { name: "Direct grants" })).toHaveTextContent("Provider / Retired · Disabled grant");
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove grant" }));
    await waitFor(() => expect(runAction).toHaveBeenCalledTimes(1));
    view.rerender(<Harness connection={{ ...connection(), enabled: false }} runAction={runAction} user={disabled} />);
    expect(screen.getByRole("combobox", { name: "Key for Provider" })).toHaveDisplayValue("Alpha · Unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Remove override" }));
    await waitFor(() => expect(runAction).toHaveBeenLastCalledWith({
      action: "set_user_credential", connectionId: "provider", credentialId: null, expectedCredentialId: "key-a", expectedUpdatedAt: "2026-09-08T12:00:00.000Z", userId: "person"
    }, expect.any(String)));
  });

  it("exposes provider loading and error states without key controls", () => {
    const runAction = vi.fn<AdminRunAction>(async () => ({ ok: true }));
    const view = render(<Harness connection={connection()} loaded={false} runAction={runAction} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading provider keys");
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    view.rerender(<Harness connection={connection()} error="Reload to retry." runAction={runAction} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Provider keys could not be loaded");
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });
});
