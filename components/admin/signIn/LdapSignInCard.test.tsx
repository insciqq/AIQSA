import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminSignInMethodState, AdminSignInOverview } from "@/lib/contracts/adminSignIn";
import type { AuthSignInMethodConfig } from "@/lib/contracts/authSignInMethods";
import { AdminSignInSection } from "./AdminSignInSection";
import { ldapFilterForUsernameSwitch, ldapTestMessage } from "./ldapSignInView";

const TYPED_BIND_PASSWORD = "typed-bind-password";

function ldapState(overrides: Partial<AdminSignInMethodState> = {}): AdminSignInMethodState {
  return {
    active: { activatedAt: null, config: null, enabled: false, secrets: { bindPassword: false }, version: 0 },
    draft: { config: null, matchesActive: false, secrets: { bindPassword: false }, test: null, version: 0 },
    environmentConfigured: false,
    health: { lastAcceptedAt: null, lastAttemptAt: null, lastFailureAt: null, lastFailureCode: null },
    method: "ldap",
    problem: null,
    requiresTest: true,
    status: "off",
    ...overrides
  } as AdminSignInMethodState;
}

function overview(methods: AdminSignInMethodState[]): AdminSignInOverview {
  return {
    appBaseUrl: "https://aiqsa.example",
    currentSessionSignInMethod: "password",
    methods,
    policy: { passwordLoginEnabled: true, registrationEnabled: true, updatedAt: null, version: 0 }
  };
}

type Call = { body: unknown; method: string; url: string };

function mockApi(initial: AdminSignInOverview, handler: (call: Call) => Response | null = () => null) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const call = { body: init?.body ? JSON.parse(String(init.body)) : null, method: init?.method ?? "GET", url };
    calls.push(call);
    if (url === "/api/admin/sign-in" && call.method === "GET") return Response.json(initial);
    return handler(call) ?? Response.json({ error: "unexpected_request" }, { status: 500 });
  });
  return calls;
}

async function renderCard(state = ldapState(), handler?: (call: Call) => Response | null) {
  const calls = mockApi(overview([state]), handler);
  render(<AdminSignInSection feedback={{ reportError: vi.fn(), reportNotice: vi.fn() }} requestConfirmation={() => undefined} />);
  return { calls, card: await screen.findByTestId("admin-sign-in-card-ldap") };
}

describe("LDAP admin card", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fills the Active Directory preset and saves the draft with a write-only bind password", async () => {
    const saved = ldapState({ draft: { config: null, matchesActive: false, secrets: { bindPassword: true }, test: null, version: 1 } });
    const { calls, card } = await renderCard(undefined, (call) => (call.method === "PUT" ? Response.json({ method: saved }) : null));

    expect(within(card).getByRole("heading", { name: "LDAP / Active Directory" })).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "Active Directory" }));
    expect(within(card).getByLabelText("User search filter")).toHaveValue("(sAMAccountName={{username}})");
    expect(within(card).getByLabelText("Id attribute")).toHaveValue("objectGUID");
    expect(within(card).getByLabelText("People sign in with a username")).toBeChecked();

    fireEvent.change(within(card).getByLabelText("Server URL"), { target: { value: "ldaps://dc1.corp.example.test" } });
    fireEvent.change(within(card).getByLabelText("Bind DN"), { target: { value: "CN=aiqsa-bind,CN=Users,DC=corp" } });
    fireEvent.change(within(card).getByLabelText("Bind password"), { target: { value: TYPED_BIND_PASSWORD } });
    fireEvent.change(within(card).getByLabelText("User search base"), { target: { value: "DC=corp,DC=example,DC=test" } });
    fireEvent.change(within(card).getByLabelText("Administrator groups"), { target: { value: "aiqsa-admins\n\n" } });
    fireEvent.change(within(card).getByLabelText("Sample sign-in name"), { target: { value: "jdoe" } });
    fireEvent.click(within(card).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));
    expect(calls.find((call) => call.method === "PUT")?.body).toEqual({
      config: {
        adminGroups: ["aiqsa-admins"],
        allowedGroups: [],
        attributes: { displayName: "displayName", email: "mail", groups: "memberOf", id: "objectGUID" },
        autoCreateUsers: true,
        bindDn: "CN=aiqsa-bind,CN=Users,DC=corp",
        caCertificatePem: null,
        groupValueForm: "cn",
        loginUsesUsername: true,
        startTls: false,
        syncGroups: false,
        testUsername: "jdoe",
        tlsRejectUnauthorized: true,
        trustUnverifiedEmail: true,
        url: "ldaps://dc1.corp.example.test",
        userSearchBase: "DC=corp,DC=example,DC=test",
        userSearchFilter: "(sAMAccountName={{username}})"
      },
      expectedDraftVersion: 0,
      secretActions: { bindPassword: { kind: "replace", value: TYPED_BIND_PASSWORD } }
    });
    await waitFor(() => expect(within(card).getByLabelText("Bind password")).toHaveValue(""));
    expect(document.body.innerHTML).not.toContain(TYPED_BIND_PASSWORD);
  });

  it("marks missing server fields before saving", async () => {
    const { calls, card } = await renderCard();

    fireEvent.change(within(card).getByLabelText("User search filter"), { target: { value: "(uid=jdoe)" } });
    fireEvent.click(within(card).getByRole("button", { name: "Save" }));

    expect(within(card).getByText(/Enter the server as ldaps:\/\/host/u)).toBeInTheDocument();
    expect(within(card).getByText("Enter the DN to search users under.")).toBeInTheDocument();
    expect(within(card).getByText("The filter must contain {{username}}.")).toBeInTheDocument();
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("warns when certificate verification is off and states the email trust default", async () => {
    const { card } = await renderCard();

    expect(within(card).getByLabelText("Link accounts by directory email")).toBeChecked();
    expect(within(card).getByText(/the directory owns its email addresses/u)).toBeInTheDocument();
    expect(within(card).getByText(/memberof overlay/u)).toBeInTheDocument();
    expect(within(card).queryByTestId("admin-sign-in-ldap-tls-warning")).toBeNull();
    fireEvent.click(within(card).getByLabelText("Verify the server certificate"));
    expect(within(card).getByTestId("admin-sign-in-ldap-tls-warning")).toHaveTextContent("anyone on the network path");
  });

  it("shows a passed tester result in words", async () => {
    const config: AuthSignInMethodConfig<"ldap"> = {
      adminGroups: [],
      allowedGroups: [],
      attributes: { displayName: "displayName", email: "mail", groups: "memberOf", id: "entryUUID" },
      autoCreateUsers: true,
      bindDn: null,
      caCertificatePem: null,
      groupValueForm: "cn",
      loginUsesUsername: true,
      startTls: false,
      syncGroups: false,
      testUsername: "jdoe",
      tlsRejectUnauthorized: true,
      trustUnverifiedEmail: true,
      url: "ldaps://ldap.example.test",
      userSearchBase: "dc=example,dc=test",
      userSearchFilter: "(uid={{username}})"
    };
    const { card } = await renderCard(ldapState({
      draft: {
        config,
        matchesActive: false,
        secrets: { bindPassword: false },
        test: { attemptedAt: "2026-10-08T12:00:00.000Z", code: "entry_found_ldaps_id1_email1_groups3", passed: true, version: 1 },
        version: 1
      }
    }));

    expect(within(card).getByTestId("admin-sign-in-test"))
      .toHaveTextContent("Test passed: Found the sample entry over LDAPS. Id and email attributes present. 3 group values.");
    expect(within(card).getByRole("button", { name: "Activate" })).toBeEnabled();
  });
});

describe("LDAP card helpers", () => {
  it("words tester codes and leaves other methods' codes alone", () => {
    expect(ldapTestMessage("entry_found_starttls_id1_email0_groups1"))
      .toBe("Found the sample entry over StartTLS. Missing attribute: email. 1 group value.");
    expect(ldapTestMessage("base_found_plain")).toMatch(/^Connected without TLS/u);
    expect(ldapTestMessage("ambiguous")).toMatch(/more than one entry/u);
    expect(ldapTestMessage("format_checked")).toBeNull();
  });

  it("moves only a default filter with the username switch", () => {
    expect(ldapFilterForUsernameSwitch({ filter: "(mail={{username}})", idAttribute: "entryUUID", loginUsesUsername: true }))
      .toBe("(uid={{username}})");
    expect(ldapFilterForUsernameSwitch({ filter: "(mail={{username}})", idAttribute: "objectGUID", loginUsesUsername: true }))
      .toBe("(sAMAccountName={{username}})");
    expect(ldapFilterForUsernameSwitch({ filter: "(uid={{username}})", idAttribute: "entryUUID", loginUsesUsername: false }))
      .toBe("(mail={{username}})");
    expect(ldapFilterForUsernameSwitch({ filter: "(&(uid={{username}})(objectClass=person))", idAttribute: "entryUUID", loginUsesUsername: false }))
      .toBe("(&(uid={{username}})(objectClass=person))");
  });
});
