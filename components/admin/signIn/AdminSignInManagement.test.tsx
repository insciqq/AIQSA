import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminGroup } from "@/lib/contracts/admin";
import type { AdminGroupSignIn, AdminUserSignIn } from "@/lib/contracts/adminSignIn";
import { AdminGroupExternalNames, useAdminGroupSignIn } from "./AdminGroupExternalNames";
import { AdminUserManagedGroups, AdminUserSignInSection, useAdminUserSignIn } from "./AdminUserSignIn";

type Call = { body: unknown; method: string; url: string };

function mockApi(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const call = { body: init?.body ? JSON.parse(String(init.body)) : null, method: init?.method ?? "GET", url };
    calls.push(call);
    return respond(call);
  });
  return calls;
}

function GroupHarness() {
  const signIn = useAdminGroupSignIn("group-1", "member-1");
  return (
    <>
      <p data-testid="managed">{[...signIn.managedMembers.entries()].map(([id, by]) => `${id}:${by}`).join(",")}</p>
      <AdminGroupExternalNames disabled={false} signIn={signIn} />
    </>
  );
}

const groups = [{ id: "team", name: "Platform team" }, { id: "scim", name: "Pushed group" }] as AdminGroup[];

function UserHarness() {
  const signIn = useAdminUserSignIn("user-1", "team");
  return (
    <>
      <AdminUserManagedGroups groups={groups} signIn={signIn} />
      <AdminUserSignInSection signIn={signIn} />
    </>
  );
}

describe("group external names", () => {
  afterEach(() => vi.restoreAllMocks());

  it("adds exact names per source, refuses duplicates and shows managed members", async () => {
    let group: AdminGroupSignIn = {
      externalNames: [{ id: "n1", source: "oidc", value: "/team" }],
      managedMembers: [{ managedBy: "oidc", userId: "member-1" }],
      scimManaged: false
    };
    const calls = mockApi((call) => {
      if (call.method === "POST") {
        group = { ...group, externalNames: [...group.externalNames, { id: "n2", source: "ldap", value: " Team Leads " }] };
      }
      return Response.json({ group });
    });
    render(<GroupHarness />);

    expect(await screen.findByTestId("managed")).toHaveTextContent("member-1:oidc");
    const oidc = screen.getAllByTestId("admin-group-external-source").find((element) => element.dataset.source === "oidc")!;
    expect(within(oidc).getByText("/team")).toBeInTheDocument();

    fireEvent.change(within(oidc).getByLabelText("Add an external name for OIDC"), { target: { value: "/team" } });
    fireEvent.click(within(oidc).getByRole("button", { name: "Add" }));
    expect(within(oidc).getByRole("alert")).toHaveTextContent("already has that external name");
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);

    const ldap = screen.getAllByTestId("admin-group-external-source").find((element) => element.dataset.source === "ldap")!;
    fireEvent.change(within(ldap).getByLabelText("Add an external name for LDAP"), { target: { value: " Team Leads " } });
    fireEvent.click(within(ldap).getByRole("button", { name: "Add" }));

    await waitFor(() => expect(within(ldap).getByText("Team Leads")).toBeInTheDocument());
    expect(calls.at(-1)).toEqual({
      body: { action: "add_external_name", source: "ldap", value: " Team Leads " },
      method: "POST",
      url: "/api/admin/sign-in/groups/group-1"
    });
    expect(screen.getByText(/Entra ID sends group object IDs/)).toBeInTheDocument();
  });
});

describe("user sign-in identities", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows managed memberships, the last sync warning and unlinks with a last-method confirmation", async () => {
    const user: AdminUserSignIn = {
      hasPassword: false,
      identities: [{
        createdAt: "2026-10-01T10:00:00.000Z",
        id: "identity-1",
        lastSyncWarning: "groups_claim_missing",
        lastSyncedAt: "2026-10-08T10:00:00.000Z",
        provider: "oidc",
        sourceCurrent: false
      }],
      managedGroups: [{ groupId: "team", managedBy: "oidc" }, { groupId: "scim", managedBy: "scim" }]
    };
    const calls = mockApi((call) => {
      if (call.method === "GET") return Response.json({ user });
      return (call.body as { confirmLastSignInMethod?: boolean }).confirmLastSignInMethod
        ? Response.json({ user: { ...user, identities: [] } })
        : Response.json({ error: "identity_last_sign_in_method" }, { status: 409 });
    });
    render(<UserHarness />);

    const managed = await screen.findByTestId("admin-user-managed-groups");
    expect(managed).toHaveTextContent("Platform team· Managed by OIDC");
    expect(managed).toHaveTextContent("Pushed group· Managed by SCIM");
    const identity = screen.getByTestId("admin-user-identity");
    expect(within(identity).getByTestId("admin-user-identity-sync-warning")).toHaveTextContent("carried no groups");
    expect(within(identity).getByTestId("admin-user-identity-source-changed")).toHaveTextContent("previous OIDC source");

    fireEvent.click(within(identity).getByRole("button", { name: "Unlink identity" }));
    fireEvent.click(within(identity).getByRole("button", { name: "Unlink" }));
    await waitFor(() => expect(within(identity).getByRole("button", { name: "Unlink anyway" })).toBeInTheDocument());
    expect(within(identity).getByTestId("admin-user-identity-unlink-confirm")).toHaveTextContent("only way to sign in");

    fireEvent.click(within(identity).getByRole("button", { name: "Unlink anyway" }));
    await waitFor(() => expect(screen.queryByTestId("admin-user-identity")).not.toBeInTheDocument());
    expect(calls.at(-1)?.body).toEqual({ action: "unlink_identity", confirmLastSignInMethod: true, identityId: "identity-1" });
  });
});
