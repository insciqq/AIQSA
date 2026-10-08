import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState, type ReactNode } from "react";
import { AdminSectionTopbarProvider, type AdminShellTopbar } from "@/components/admin/AdminShell";
import type { AdminSignInMethodState, AdminSignInOverview } from "@/lib/contracts/adminSignIn";
import type { AuthSignInMethodConfig } from "@/lib/contracts/authSignInMethods";
import { AdminSignInSection } from "./AdminSignInSection";

const ISSUER = "https://keycloak.example/realms/main";
const TYPED_SECRET = "typed-oidc-secret";

function oidcState(overrides: Partial<AdminSignInMethodState<"oidc">> = {}): AdminSignInMethodState {
  return {
    active: { activatedAt: null, config: null, enabled: false, secrets: { clientSecret: false }, version: 0 },
    draft: { config: null, matchesActive: false, secrets: { clientSecret: false }, test: null, version: 0 },
    environmentConfigured: false,
    health: { lastAcceptedAt: null, lastAttemptAt: null, lastFailureAt: null, lastFailureCode: null },
    method: "oidc",
    problem: null,
    requiresTest: true,
    status: "off",
    ...overrides
  } as AdminSignInMethodState;
}

function overview(method: AdminSignInMethodState): AdminSignInOverview {
  return {
    appBaseUrl: "https://aiqsa.example",
    currentSessionSignInMethod: "password",
    methods: [method],
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

function TopbarHarness({ children }: Readonly<{ children: ReactNode }>) {
  const [, setTopbar] = useState<AdminShellTopbar | null>(null);
  return <AdminSectionTopbarProvider value={setTopbar}>{children}</AdminSectionTopbarProvider>;
}

function renderSection() {
  render(
    <TopbarHarness>
      <AdminSignInSection feedback={{ reportError: vi.fn(), reportNotice: vi.fn() }} requestConfirmation={() => undefined} />
    </TopbarHarness>
  );
}

describe("OidcSignInCard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the URIs to copy and saves a complete draft with group sync offered on", async () => {
    const calls = mockApi(overview(oidcState()), (call) =>
      call.method === "PUT" ? Response.json({ method: oidcState() }) : null);
    renderSection();
    const card = await screen.findByTestId("admin-sign-in-card-oidc");

    expect(within(card).getByRole("heading", { name: "OpenID Connect" })).toBeInTheDocument();
    expect(within(card).getByLabelText("Redirect URI")).toHaveValue("https://aiqsa.example/api/auth/oauth/oidc/callback");
    expect(within(card).getByLabelText("Post-logout redirect URI")).toHaveValue("https://aiqsa.example/login");
    expect(within(card).getByText("Provider notes")).toBeInTheDocument();
    expect(within(card).getByRole("checkbox", { name: /Sync groups/ })).toBeChecked();

    fireEvent.change(within(card).getByLabelText("Issuer"), { target: { value: ` ${ISSUER} ` } });
    fireEvent.change(within(card).getByLabelText("Client ID"), { target: { value: "aiqsa" } });
    fireEvent.change(within(card).getByLabelText("Client secret"), { target: { value: TYPED_SECRET } });
    fireEvent.change(within(card).getByLabelText("Button label"), { target: { value: "Company SSO" } });
    fireEvent.change(within(card).getByLabelText("Groups claim"), { target: { value: "realm_access.roles" } });
    fireEvent.change(within(card).getByLabelText("Groups from"), { target: { value: "id_token" } });
    fireEvent.change(within(card).getByLabelText("Allowed groups"), { target: { value: "staff\n\n contractors \nstaff" } });
    fireEvent.change(within(card).getByLabelText("Administrator groups"), { target: { value: "aiqsa-admin" } });
    fireEvent.click(within(card).getByRole("checkbox", { name: /Redirect to the provider/ }));
    fireEvent.click(within(card).getByRole("checkbox", { name: /Sign out at the provider/ }));
    fireEvent.click(within(card).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));
    expect(calls.find((call) => call.method === "PUT")).toMatchObject({
      body: {
        config: {
          adminGroups: ["aiqsa-admin"],
          allowedGroups: ["staff", "contractors"],
          autoCreateUsers: true,
          autoRedirect: true,
          buttonLabel: "Company SSO",
          clientId: "aiqsa",
          groupsClaimPath: "realm_access.roles",
          groupsFrom: "id_token",
          idpLogout: true,
          issuer: ISSUER,
          scopes: "openid email profile",
          syncGroups: true,
          trustUnverifiedEmail: false
        },
        expectedDraftVersion: 0,
        secretActions: { clientSecret: { kind: "replace", value: TYPED_SECRET } }
      },
      url: "/api/admin/sign-in/methods/oidc"
    });
  });

  it("refuses a multi-tenant issuer, a missing secret and scopes without openid before saving", async () => {
    const calls = mockApi(overview(oidcState()));
    renderSection();
    const card = await screen.findByTestId("admin-sign-in-card-oidc");

    fireEvent.change(within(card).getByLabelText("Issuer"), { target: { value: "https://login.microsoftonline.com/common/v2.0" } });
    fireEvent.change(within(card).getByLabelText("Client ID"), { target: { value: "aiqsa" } });
    fireEvent.change(within(card).getByLabelText("Scopes"), { target: { value: "email profile" } });
    fireEvent.click(within(card).getByRole("button", { name: "Save" }));

    expect(await within(card).findByText(/Multi-tenant issuers let any tenant sign in/)).toBeInTheDocument();
    expect(within(card).getByText("Enter the client secret.")).toBeInTheDocument();
    expect(within(card).getByText("Include the openid scope.")).toBeInTheDocument();
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("explains the tester's codes and the last sign-in failure", async () => {
    const config: AuthSignInMethodConfig<"oidc"> = {
      adminGroups: [], allowedGroups: [], autoCreateUsers: true, autoRedirect: false, buttonLabel: "SSO", clientId: "aiqsa",
      groupsClaimPath: "groups", groupsFrom: "id_token_then_userinfo", idpLogout: false, issuer: ISSUER,
      scopes: "openid email profile", syncGroups: false, trustUnverifiedEmail: false
    };
    mockApi(overview(oidcState({
      draft: {
        config,
        matchesActive: false,
        secrets: { clientSecret: true },
        test: { attemptedAt: "2026-10-08T12:00:00.000Z", code: "issuer_mismatch", passed: false, version: 2 },
        version: 2
      },
      health: { lastAcceptedAt: null, lastAttemptAt: "2026-10-08T11:00:00.000Z", lastFailureAt: "2026-10-08T11:00:00.000Z", lastFailureCode: "id_token_invalid" }
    })));
    renderSection();
    const card = await screen.findByTestId("admin-sign-in-card-oidc");

    expect(within(card).getByTestId("admin-sign-in-test")).toHaveTextContent("Test failed: The discovery document names a different issuer.");
    expect(within(card).getByTestId("admin-sign-in-health")).toHaveTextContent("the ID token failed validation");
    // A saved configuration keeps its own choice.
    expect(within(card).getByRole("checkbox", { name: /Sync groups/ })).not.toBeChecked();
    expect(within(card).getByLabelText("Issuer")).toHaveValue(ISSUER);
  });
});
