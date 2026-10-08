import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState, type ReactNode } from "react";
import { AdminSectionTopbarProvider, type AdminShellTopbar } from "@/components/admin/AdminShell";
import type { AdminSignInMethodState, AdminSignInOverview } from "@/lib/contracts/adminSignIn";
import type { AdminTrustedHeaderProbe } from "@/lib/contracts/trustedHeaderSignIn";
import { AdminSignInSection } from "./AdminSignInSection";

function trustedHeader(overrides: Partial<AdminSignInMethodState<"trusted_header">> = {}): AdminSignInMethodState {
  return {
    active: { activatedAt: null, config: null, enabled: false, secrets: {}, version: 0 },
    draft: { config: null, matchesActive: false, secrets: {}, test: null, version: 0 },
    environmentConfigured: false,
    health: { lastAcceptedAt: null, lastAttemptAt: null, lastFailureAt: null, lastFailureCode: null },
    method: "trusted_header",
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

function mockApi(input: {
  method?: AdminSignInMethodState;
  probe(url: URL): AdminTrustedHeaderProbe;
  saved?: AdminSignInMethodState;
}) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
    const url = typeof request === "string" ? request : request instanceof URL ? request.toString() : request.url;
    const call = { body: init?.body ? JSON.parse(String(init.body)) : null, method: init?.method ?? "GET", url };
    calls.push(call);
    if (url === "/api/admin/sign-in") return Response.json(overview(input.method ?? trustedHeader()));
    if (url.startsWith("/api/admin/sign-in/trusted-header")) {
      return Response.json(input.probe(new URL(url, "https://aiqsa.example")));
    }
    if (url === "/api/admin/sign-in/methods/trusted_header" && call.method === "PUT" && input.saved) {
      return Response.json({ method: input.saved });
    }
    return Response.json({ error: "unexpected_request" }, { status: 500 });
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
      <AdminSignInSection feedback={{ reportError: vi.fn(), reportNotice: vi.fn() }} requestConfirmation={vi.fn()} />
    </TopbarHarness>
  );
}

describe("TrustedHeaderSignInCard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("explains that the method needs trusted-proxy mode from the environment", async () => {
    mockApi({ probe: () => ({ clientIdentityMode: "direct_peer", emailHeader: null }) });
    renderSection();

    const card = await screen.findByTestId("admin-sign-in-card-trusted_header");
    const mode = await within(card).findByText(/Client identity mode:/);
    expect(mode).toHaveTextContent("direct (network peer)");
    expect(mode).toHaveTextContent("cannot be activated");
    expect(within(card).getByTestId("trusted-header-mode")).toHaveTextContent("AIQSA_TRUST_PROXY_HEADERS=true");
    expect(within(card).getByTestId("trusted-header-mode")).toHaveTextContent("overwrite any the browser sends");
  });

  it("fills a proxy preset, checks this request's header and saves the configuration", async () => {
    const saved = trustedHeader({
      draft: {
        config: {
          adminGroups: [],
          allowedGroups: ["staff"],
          autoCreateUsers: true,
          emailHeader: "Remote-Email",
          groupsHeader: "Remote-Groups",
          groupsSeparator: ",",
          nameHeader: "Remote-Name",
          syncGroups: true
        },
        matchesActive: false,
        secrets: {},
        test: null,
        version: 1
      }
    });
    const calls = mockApi({
      probe: (url) => ({
        clientIdentityMode: "trusted_proxy",
        emailHeader: url.searchParams.get("emailHeader") === "Remote-Email"
          ? { domainHint: "@example.com", present: true, usable: true }
          : null
      }),
      saved
    });
    renderSection();
    const card = await screen.findByTestId("admin-sign-in-card-trusted_header");
    await within(card).findByText(/AIQSA trusts the proxy in front of it/);

    fireEvent.click(within(card).getByRole("button", { name: "Authelia" }));
    expect(within(card).getByLabelText("Email header")).toHaveValue("Remote-Email");
    expect(within(card).getByLabelText("Name header")).toHaveValue("Remote-Name");
    expect(within(card).getByLabelText("Groups header")).toHaveValue("Remote-Groups");

    fireEvent.click(within(card).getByRole("button", { name: "Check this request" }));
    await waitFor(() => expect(within(card).getByTestId("trusted-header-probe"))
      .toHaveTextContent("This request carries Remote-Email with an address at @example.com."));
    expect(calls.some((call) => call.url === "/api/admin/sign-in/trusted-header?emailHeader=Remote-Email")).toBe(true);

    fireEvent.change(within(card).getByLabelText("Allowed groups"), { target: { value: "staff\n\n" } });
    fireEvent.click(within(card).getByLabelText("Sync groups with external names"));
    fireEvent.click(within(card).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));
    expect(calls.find((call) => call.method === "PUT")?.body).toEqual({
      config: saved.draft.config,
      expectedDraftVersion: 0,
      secretActions: {}
    });
  });

  it("marks an invalid header name instead of saving", async () => {
    const calls = mockApi({ probe: () => ({ clientIdentityMode: "trusted_proxy", emailHeader: null }) });
    renderSection();
    const card = await screen.findByTestId("admin-sign-in-card-trusted_header");

    fireEvent.change(within(card).getByLabelText("Email header"), { target: { value: "Remote Email" } });
    fireEvent.click(within(card).getByRole("button", { name: "Save" }));

    expect(await within(card).findByText("Enter a header name, such as X-Auth-Request-Email.")).toBeInTheDocument();
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
  });
});
