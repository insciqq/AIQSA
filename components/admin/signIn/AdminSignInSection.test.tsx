import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState, type ReactNode } from "react";
import { AdminSectionTopbarProvider, type AdminShellTopbar } from "@/components/admin/AdminShell";
import type { AdminConfirmationRequest } from "@/components/admin/useAdminConfirmationController";
import type { AdminSignInMethodState, AdminSignInOverview } from "@/lib/contracts/adminSignIn";
import { AdminSignInSection } from "./AdminSignInSection";

const GOOGLE_CLIENT = "1234-abc.apps.googleusercontent.com";
const TYPED_SECRET = "typed-write-only-secret";

function method(name: "google" | "yandex", overrides: Partial<AdminSignInMethodState> = {}): AdminSignInMethodState {
  return {
    active: { activatedAt: null, config: null, enabled: false, secrets: { clientSecret: false }, version: 0 },
    draft: { config: null, matchesActive: false, secrets: { clientSecret: false }, test: null, version: 0 },
    environmentConfigured: false,
    health: { lastAcceptedAt: null, lastAttemptAt: null, lastFailureAt: null, lastFailureCode: null },
    method: name,
    problem: null,
    requiresTest: true,
    status: "off",
    ...overrides
  } as AdminSignInMethodState;
}

function overview(overrides: Partial<AdminSignInOverview> = {}): AdminSignInOverview {
  return {
    appBaseUrl: "https://aiqsa.example",
    currentSessionSignInMethod: "password",
    methods: [
      method("google", { environmentConfigured: true, status: "active_environment" }),
      method("yandex")
    ],
    policy: { passwordLoginEnabled: true, registrationEnabled: true, updatedAt: null, version: 0 },
    ...overrides
  };
}

type Call = { body: unknown; method: string; url: string };

function mockApi(handlers: (call: Call) => Response | null, initial = overview()) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const call = { body: init?.body ? JSON.parse(String(init.body)) : null, method: init?.method ?? "GET", url };
    calls.push(call);
    if (url === "/api/admin/sign-in" && call.method === "GET") return Response.json(initial);
    return handlers(call) ?? Response.json({ error: "unexpected_request" }, { status: 500 });
  });
  return calls;
}

function TopbarHarness({ children }: Readonly<{ children: ReactNode }>) {
  const [topbar, setTopbar] = useState<AdminShellTopbar | null>(null);
  return (
    <AdminSectionTopbarProvider value={setTopbar}>
      <h1 data-testid="topbar-title">{topbar?.title}</h1>
      {children}
    </AdminSectionTopbarProvider>
  );
}

function renderSection() {
  const confirmations: AdminConfirmationRequest[] = [];
  const feedback = { reportError: vi.fn(), reportNotice: vi.fn() };
  render(
    <TopbarHarness>
      <AdminSignInSection feedback={feedback} requestConfirmation={(config) => { confirmations.push(config); }} />
    </TopbarHarness>
  );
  return { confirmations, feedback };
}

describe("AdminSignInSection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows each method's source, the environment hint and the callback URL to copy", async () => {
    mockApi(() => null);
    renderSection();

    const google = await screen.findByTestId("admin-sign-in-card-google");
    expect(screen.getByTestId("topbar-title")).toHaveTextContent("Sign-in");
    expect(within(google).getByTestId("admin-sign-in-status")).toHaveTextContent("Active (environment)");
    expect(within(google).getByTestId("admin-sign-in-environment")).toHaveTextContent("AIQSA_GOOGLE_OAUTH_CLIENT_ID");
    expect(within(google).getByTestId("admin-sign-in-environment")).toHaveTextContent("enter the same values, Test, Activate, then remove the variables");
    expect(within(google).getByDisplayValue("https://aiqsa.example/api/auth/oauth/google/callback")).toBeInTheDocument();
    expect(within(screen.getByTestId("admin-sign-in-card-yandex")).getByTestId("admin-sign-in-status")).toHaveTextContent("Off");
    expect(within(google).getByRole("button", { name: "Activate" })).toBeDisabled();
  });

  it("saves a draft with a write-only secret, tests it and activates it", async () => {
    const savedDraft = method("google", {
      draft: { config: { clientId: GOOGLE_CLIENT }, matchesActive: false, secrets: { clientSecret: true }, test: null, version: 1 },
      environmentConfigured: true,
      status: "active_environment"
    });
    const tested = method("google", {
      ...savedDraft,
      draft: { ...savedDraft.draft, test: { attemptedAt: "2026-10-08T12:00:00.000Z", code: "format_checked", passed: true, version: 1 } }
    });
    const active = method("google", {
      ...tested,
      active: { activatedAt: "2026-10-08T12:01:00.000Z", config: { clientId: GOOGLE_CLIENT }, enabled: true, secrets: { clientSecret: true }, version: 1 },
      draft: { ...tested.draft, matchesActive: true },
      status: "active_admin"
    });
    const calls = mockApi((call) => {
      if (call.url === "/api/admin/sign-in/methods/google" && call.method === "PUT") return Response.json({ method: savedDraft });
      if (call.url === "/api/admin/sign-in/methods/google" && (call.body as { action?: string }).action === "test") {
        return Response.json({ method: tested, test: { code: "format_checked", passed: true } });
      }
      if (call.url === "/api/admin/sign-in/methods/google") return Response.json({ method: active });
      return null;
    });
    const { feedback } = renderSection();
    const google = await screen.findByTestId("admin-sign-in-card-google");

    fireEvent.change(within(google).getByLabelText("Client ID"), { target: { value: GOOGLE_CLIENT } });
    fireEvent.change(within(google).getByLabelText("Client secret"), { target: { value: TYPED_SECRET } });
    fireEvent.click(within(google).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(within(google).getByLabelText("Client secret")).toHaveValue(""));
    expect(calls.find((call) => call.method === "PUT")?.body).toEqual({
      config: { clientId: GOOGLE_CLIENT },
      expectedDraftVersion: 0,
      secretActions: { clientSecret: { kind: "replace", value: TYPED_SECRET } }
    });
    expect(document.body.innerHTML).not.toContain(TYPED_SECRET);
    expect(within(google).getByText(/Stored\. Leave blank to keep it/)).toBeInTheDocument();

    fireEvent.click(within(google).getByRole("button", { name: "Test" }));
    await waitFor(() => expect(within(google).getByTestId("admin-sign-in-test")).toHaveTextContent("Test passed"));
    fireEvent.click(within(google).getByRole("button", { name: "Activate" }));

    await waitFor(() => expect(within(google).getByTestId("admin-sign-in-status")).toHaveTextContent("Active (admin)"));
    expect(calls.at(-1)?.body).toEqual({ action: "activate", expectedActiveVersion: 0, expectedDraftVersion: 1 });
    expect(feedback.reportNotice).toHaveBeenCalledWith("Google sign-in is active.");
    expect(within(google).getByTestId("admin-sign-in-environment")).toHaveTextContent("overrides the environment variables");
  });

  it("keeps the stored secret when the field is left blank", async () => {
    const saved = method("google", {
      draft: { config: { clientId: GOOGLE_CLIENT }, matchesActive: false, secrets: { clientSecret: true }, test: null, version: 3 }
    });
    const calls = mockApi((call) => call.method === "PUT" ? Response.json({ method: saved }) : null, overview({ methods: [saved] }));
    renderSection();
    const google = await screen.findByTestId("admin-sign-in-card-google");

    fireEvent.change(within(google).getByLabelText("Client ID"), { target: { value: "9999-new.apps.googleusercontent.com" } });
    fireEvent.click(within(google).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));
    expect(calls.find((call) => call.method === "PUT")?.body).toEqual({
      config: { clientId: "9999-new.apps.googleusercontent.com" },
      expectedDraftVersion: 3,
      secretActions: { clientSecret: { kind: "preserve" } }
    });
  });

  it("asks before activating a draft whose identity source changed and confirms with the count", async () => {
    const tested = method("google", {
      draft: {
        config: { clientId: GOOGLE_CLIENT },
        matchesActive: false,
        secrets: { clientSecret: true },
        test: { attemptedAt: "2026-10-08T12:00:00.000Z", code: "format_checked", passed: true, version: 2 },
        version: 2
      }
    });
    const calls = mockApi((call) => {
      const body = call.body as { confirmSourceChange?: boolean };
      return body?.confirmSourceChange
        ? Response.json({ method: { ...tested, status: "active_admin" } })
        : Response.json({ affectedIdentities: 4, error: "sign_in_source_changed" }, { status: 409 });
    }, overview({ methods: [tested] }));
    const { confirmations } = renderSection();
    const google = await screen.findByTestId("admin-sign-in-card-google");

    fireEvent.click(within(google).getByRole("button", { name: "Activate" }));

    await waitFor(() => expect(confirmations).toHaveLength(1));
    expect(confirmations[0]!.body).toContain("4 accounts signed in through the previous Google source");
    await confirmations[0]!.onConfirm();
    expect(calls.at(-1)?.body).toEqual({ action: "activate", confirmSourceChange: true, expectedActiveVersion: 0, expectedDraftVersion: 2 });
  });

  it("shows in the card why the method the administrator signed in with stays on", async () => {
    const active = method("google", {
      active: { activatedAt: "2026-10-08T12:01:00.000Z", config: { clientId: GOOGLE_CLIENT }, enabled: true, secrets: { clientSecret: true }, version: 1 },
      draft: { config: { clientId: GOOGLE_CLIENT }, matchesActive: true, secrets: { clientSecret: true }, test: null, version: 1 },
      status: "active_admin"
    });
    const calls = mockApi((call) => call.url === "/api/admin/sign-in/methods/google"
      ? Response.json({ error: "password_login_lockout_risk" }, { status: 409 })
      : null, overview({
      currentSessionSignInMethod: "google",
      methods: [active],
      policy: { passwordLoginEnabled: false, registrationEnabled: true, updatedAt: null, version: 1 }
    }));
    const { confirmations, feedback } = renderSection();
    const google = await screen.findByTestId("admin-sign-in-card-google");

    fireEvent.click(within(google).getByRole("button", { name: "Disable" }));
    await confirmations[0]!.onConfirm();

    expect(calls.at(-1)?.body).toEqual({ action: "disable", expectedActiveVersion: 1 });
    const message = await within(google).findByTestId("admin-sign-in-message");
    expect(message).toHaveTextContent("Google stays on: password sign-in is off and you signed in with Google");
    expect(message).toHaveTextContent("AIQSA_BOOTSTRAP_AUTH_TOKEN");
    expect(feedback.reportNotice).not.toHaveBeenCalled();
    expect(within(google).getByTestId("admin-sign-in-status")).toHaveTextContent("Active (admin)");
  });

  it("explains the lockout guard when password sign-in cannot be turned off", async () => {
    const calls = mockApi((call) => call.url === "/api/admin/sign-in/policy"
      ? Response.json({ error: "password_login_lockout_risk" }, { status: 409 })
      : null);
    const { confirmations } = renderSection();
    const policy = await screen.findByTestId("admin-sign-in-policy");

    expect(policy).toHaveTextContent("to turn passwords off, sign in through an active external method first");
    fireEvent.click(within(policy).getByRole("switch", { name: "Password sign-in" }));
    expect(confirmations[0]!.title).toBe("Turn password sign-in off?");
    await confirmations[0]!.onConfirm();

    expect(calls.at(-1)?.body).toEqual({ expectedVersion: 0, passwordLoginEnabled: false, registrationEnabled: true });
    expect(await within(policy).findByTestId("admin-sign-in-policy-message")).toHaveTextContent("bootstrap token");
    expect(within(policy).getByRole("switch", { name: "Password sign-in" })).toHaveAttribute("aria-checked", "true");
  });
});
