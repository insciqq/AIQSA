import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState, type ReactNode } from "react";
import { AdminSectionTopbarProvider, type AdminShellTopbar } from "@/components/admin/AdminShell";
import type { AdminConfirmationRequest } from "@/components/admin/useAdminConfirmationController";
import type { AdminEmailConfiguration, AdminEmailState } from "@/lib/contracts/email";
import { AdminEmailSection } from "./AdminEmailSection";

const bannedWords = /\bdraft\b|revision|pending|probe|evidence|adapter|fingerprint|\bversion\b/iu;
const STORED_PASSWORD = "stored-write-only-password";

const configuration: AdminEmailConfiguration = {
  allowInternalNetwork: false,
  authentication: { mode: "password", username: "mailer@example.com" },
  from: { address: "noreply@example.com", displayName: "AIQSA" },
  host: "smtp.example.com",
  port: 587,
  transport: "starttls_required"
};

function emailState(overrides: Partial<AdminEmailState> = {}): AdminEmailState {
  return {
    active: {
      activatedAt: null,
      activatedByUserId: null,
      configuration: null,
      enabled: false,
      passwordConfigured: false,
      version: 1
    },
    configurationUpdatedAt: "2026-07-23T12:00:00.000Z",
    configurationUpdatedByUserId: "admin-1",
    draft: { configuration, passwordConfigured: true, test: null, version: 4 },
    health: {
      activeVersion: null,
      degraded: false,
      lastAcceptedAt: null,
      lastAttemptAt: null,
      lastFailureAt: null,
      lastFailureCode: null
    },
    ...overrides
  };
}

function activeState(): AdminEmailState {
  return emailState({
    active: {
      activatedAt: "2026-07-23T12:06:00.000Z",
      activatedByUserId: "admin-1",
      configuration,
      enabled: true,
      passwordConfigured: true,
      version: 2
    },
    health: {
      activeVersion: 2,
      degraded: false,
      lastAcceptedAt: null,
      lastAttemptAt: null,
      lastFailureAt: null,
      lastFailureCode: null
    }
  });
}

type Call = { body: Record<string, unknown> | null; method: string };
type Router = (input: Call) => Response | null | undefined;

function mockFetch(state: { current: AdminEmailState }, router: Router = () => null) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
    calls.push({ body, method });
    const routed = router({ body, method });
    if (routed) return routed;
    if (url === "/api/admin/email" && method === "GET") return Response.json({ email: state.current });
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

function renderSection(adminEmail = "admin@example.com") {
  const confirmations: AdminConfirmationRequest[] = [];
  const feedback = { reportError: vi.fn(), reportNotice: vi.fn() };
  const onMutationCommitted = vi.fn();
  const view = render(
    <TopbarHarness>
      <AdminEmailSection
        active
        adminEmail={adminEmail}
        feedback={feedback}
        onMutationCommitted={onMutationCommitted}
        requestConfirmation={(config) => { confirmations.push(config); }}
      />
    </TopbarHarness>
  );
  return { confirmations, feedback, onMutationCommitted, view };
}

async function openMenu() {
  fireEvent.click(await screen.findByRole("button", { name: "More actions" }));
  return screen.getByRole("menu", { name: "More actions" });
}

describe("AdminEmailSection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders one form from the stored settings with the delivery state on top and never the password", async () => {
    const state = { current: emailState() };
    mockFetch(state);
    renderSection();

    const form = await screen.findByRole("form", { name: "Email settings" });
    expect(screen.getByTestId("topbar-title")).toHaveTextContent("Email");
    expect(screen.getByTestId("email-delivery-status")).toHaveTextContent("Not configured");
    expect(screen.getByTestId("email-delivery-summary")).toHaveTextContent("Email is not set up.");
    expect(within(form).getByLabelText("Host")).toHaveValue("smtp.example.com");
    expect(within(form).getByLabelText("Port")).toHaveValue(587);
    expect(within(form).getByLabelText("Transport security")).toHaveValue("starttls_required");
    expect(within(form).getByLabelText("From address")).toHaveValue("noreply@example.com");
    expect(within(form).getByLabelText("From name")).toHaveValue("AIQSA");
    expect(within(form).getByLabelText("Username")).toHaveValue("mailer@example.com");
    expect(within(form).getByLabelText("Password")).toHaveValue("");
    expect(within(form).getByText("Leave blank to keep the stored password. It is never shown here.")).toBeInTheDocument();
    expect(within(form).getByLabelText("Send a test to")).toHaveValue("admin@example.com");
    expect(within(form).getByRole("button", { name: "Test & Save" })).toBeEnabled();
    expect(within(form).getByText(/A test message goes to that address first/)).toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Save draft|Activate|Test draft/ })).not.toBeInTheDocument();
    expect(screen.getByTestId("admin-email-section").textContent).not.toMatch(bannedWords);
    expect(document.body.textContent).not.toContain(STORED_PASSWORD);
    expect(document.body.innerHTML).not.toContain(STORED_PASSWORD);
  });

  it("tests and saves as one action, keeps the typed password write-only and reports activation", async () => {
    const state = { current: emailState() };
    const calls = mockFetch(state, ({ body, method }) => {
      if (method === "POST" && body?.action === "test_and_activate") {
        const draft = body.draft as { configuration: AdminEmailConfiguration };
        state.current = {
          ...activeState(),
          active: { ...activeState().active, configuration: draft.configuration },
          draft: {
            configuration: draft.configuration,
            passwordConfigured: true,
            test: { attemptedAt: "2026-07-23T12:05:00.000Z", code: "accepted", tested: true, version: 5 },
            version: 5
          }
        };
        return Response.json({ email: state.current, test: { code: "accepted", tested: true } });
      }
      return null;
    });
    const { feedback, onMutationCommitted } = renderSection();

    const form = await screen.findByRole("form", { name: "Email settings" });
    fireEvent.change(within(form).getByLabelText("Host"), { target: { value: "smtp2.example.com" } });
    fireEvent.change(within(form).getByLabelText("Password"), { target: { value: "new-write-only-password" } });
    fireEvent.change(within(form).getByLabelText("Send a test to"), { target: { value: "operator@example.com" } });
    fireEvent.click(within(form).getByRole("button", { name: "Test & Save" }));

    await waitFor(() => expect(feedback.reportNotice).toHaveBeenCalledWith(
      "Test message sent to operator@example.com. Email delivery is active."
    ));
    const posts = calls.filter(({ method }) => method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({
      action: "test_and_activate",
      draft: {
        configuration: { ...configuration, host: "smtp2.example.com" },
        expectedDraftVersion: 4,
        passwordAction: { kind: "replace", password: "new-write-only-password" }
      },
      expectedActiveVersion: 1,
      testRecipient: "operator@example.com"
    });
    expect(screen.getByTestId("email-delivery-status")).toHaveTextContent("Working");
    expect(screen.getByTestId("email-delivery-summary"))
      .toHaveTextContent("Delivering from noreply@example.com via smtp2.example.com:587 (STARTTLS).");
    expect(screen.getByTestId("email-delivery-detail")).toHaveTextContent("Test message sent");
    expect(within(form).getByLabelText("Password")).toHaveValue("");
    expect(within(form).getByLabelText("Send a test to")).toHaveValue("operator@example.com");
    expect(screen.queryByDisplayValue("new-write-only-password")).not.toBeInTheDocument();
    await waitFor(() => expect(onMutationCommitted).toHaveBeenCalledTimes(1));
    expect(feedback.reportError).not.toHaveBeenCalled();
    expect(screen.getByTestId("admin-email-section").textContent).not.toMatch(bannedWords);
  });

  it("keeps the delivery state and the typed fields when the test message fails, and shows the cause in the form", async () => {
    const state = { current: activeState() };
    mockFetch(state, ({ body, method }) => {
      if (method === "POST" && body?.action === "test_and_activate") {
        const draft = body.draft as { configuration: AdminEmailConfiguration };
        state.current = {
          ...state.current,
          draft: {
            configuration: draft.configuration,
            passwordConfigured: true,
            test: { attemptedAt: "2026-07-23T12:07:00.000Z", code: "smtp_authentication_failed", tested: false, version: 5 },
            version: 5
          }
        };
        return Response.json({
          email: state.current,
          error: "email_test_failed",
          test: { code: "smtp_authentication_failed", tested: false }
        }, { status: 422 });
      }
      return null;
    });
    const { feedback } = renderSection();

    const form = await screen.findByRole("form", { name: "Email settings" });
    expect(screen.getByTestId("email-delivery-status")).toHaveTextContent("Working");
    fireEvent.change(within(form).getByLabelText("Host"), { target: { value: "smtp-next.example.com" } });
    fireEvent.click(within(form).getByRole("button", { name: "Test & Save" }));

    const failure = await screen.findByRole("alert");
    expect(failure).toHaveTextContent("The mail server rejected the username or password.");
    expect(screen.getByTestId("email-delivery-status")).toHaveTextContent("Working");
    expect(screen.getByTestId("email-delivery-summary")).toHaveTextContent("via smtp.example.com:587");
    expect(within(form).getByLabelText("Host")).toHaveValue("smtp-next.example.com");
    expect(feedback.reportNotice).not.toHaveBeenCalled();
    expect(feedback.reportError).not.toHaveBeenCalled();

    // The next attempt continues from the stored settings the failure left behind.
    fireEvent.change(within(form).getByLabelText("Host"), { target: { value: "smtp-final.example.com" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("validates inline before sending anything", async () => {
    const state = { current: emailState({ draft: { configuration: null, passwordConfigured: false, test: null, version: 0 } }) };
    const calls = mockFetch(state);
    renderSection("");

    const form = await screen.findByRole("form", { name: "Email settings" });
    fireEvent.click(within(form).getByRole("button", { name: "Test & Save" }));

    expect(within(form).getByText("Enter the mail server host name.")).toBeInTheDocument();
    expect(within(form).getByText("Enter the sender address.")).toBeInTheDocument();
    expect(within(form).getByText("Enter the username.")).toBeInTheDocument();
    expect(within(form).getByText("Enter the password.")).toBeInTheDocument();
    expect(within(form).getByText("Enter the address that receives the test message.")).toBeInTheDocument();
    expect(within(form).getByLabelText("Host")).toHaveAttribute("aria-invalid", "true");
    await waitFor(() => expect(within(form).getByLabelText("Host")).toHaveFocus());
    expect(calls.filter(({ method }) => method === "POST")).toHaveLength(0);

    fireEvent.change(within(form).getByLabelText("Host"), { target: { value: "smtp.example.com" } });
    expect(within(form).queryByText("Enter the mail server host name.")).not.toBeInTheDocument();
  });

  it("requires the private-address and unencrypted acknowledgements for an internal relay and clears sign-in", async () => {
    const state = { current: emailState() };
    const calls = mockFetch(state, ({ body, method }) => {
      if (method === "POST" && body?.action === "test_and_activate") {
        return Response.json({ email: state.current, test: { code: "accepted", tested: true } });
      }
      return null;
    });
    renderSection();

    const form = await screen.findByRole("form", { name: "Email settings" });
    fireEvent.change(within(form).getByLabelText("Transport security"), { target: { value: "plaintext_internal_no_auth" } });
    expect(within(form).getByLabelText("Port")).toHaveValue(25);
    expect(within(form).getByLabelText("Authentication")).toHaveValue("none");
    expect(within(form).getByLabelText("Authentication")).toBeDisabled();
    expect(within(form).queryByLabelText("Password")).not.toBeInTheDocument();
    const acknowledgement = within(form).getByRole("checkbox", { name: /I accept unencrypted delivery to smtp.example.com/ });
    expect(acknowledgement).not.toBeChecked();

    fireEvent.click(within(form).getByRole("button", { name: "Test & Save" }));
    expect(within(form).getByText(/allow private addresses first/)).toBeInTheDocument();
    expect(within(form).getByText("Confirm unencrypted delivery to this relay.")).toBeInTheDocument();
    expect(calls.filter(({ method }) => method === "POST")).toHaveLength(0);

    fireEvent.click(within(form).getByRole("checkbox", { name: /Allow a private or loopback address/ }));
    fireEvent.click(acknowledgement);
    fireEvent.click(within(form).getByRole("button", { name: "Test & Save" }));

    await waitFor(() => expect(calls.filter(({ method }) => method === "POST")).toHaveLength(1));
    expect(calls.find(({ method }) => method === "POST")?.body).toMatchObject({
      draft: {
        configuration: {
          allowInternalNetwork: true,
          authentication: { mode: "none" },
          port: 25,
          transport: "plaintext_internal_no_auth"
        },
        passwordAction: { confirm: true, kind: "clear" }
      }
    });
  });

  it("turns delivery off and on from the topbar menu without a confirmation", async () => {
    const state = { current: activeState() };
    const calls = mockFetch(state, ({ body, method }) => {
      if (method === "POST" && (body?.action === "disable" || body?.action === "enable")) {
        state.current = {
          ...state.current,
          active: { ...state.current.active, enabled: body.action === "enable", version: state.current.active.version + 1 }
        };
        return Response.json({ email: state.current });
      }
      return null;
    });
    const { confirmations, feedback, onMutationCommitted } = renderSection();

    await screen.findByRole("form", { name: "Email settings" });
    let menu = await openMenu();
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Disable", "Clear configuration"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Disable" }));

    await waitFor(() => expect(feedback.reportNotice).toHaveBeenCalledWith("Email delivery turned off."));
    expect(calls.find(({ body }) => body?.action === "disable")?.body).toEqual({ action: "disable", expectedActiveVersion: 2 });
    expect(screen.getByTestId("email-delivery-status")).toHaveTextContent("Disabled");
    expect(screen.getByTestId("email-delivery-summary")).toHaveTextContent("Delivery is turned off.");
    expect(confirmations).toHaveLength(0);

    menu = await openMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Enable" }));
    await waitFor(() => expect(feedback.reportNotice).toHaveBeenCalledWith("Email delivery turned on."));
    expect(calls.find(({ body }) => body?.action === "enable")?.body).toEqual({ action: "enable", expectedActiveVersion: 3 });
    expect(screen.getByTestId("email-delivery-status")).toHaveTextContent("Working");
    await waitFor(() => expect(onMutationCommitted).toHaveBeenCalledTimes(2));
  });

  it("clears the configuration through the shared confirmation host and hides the menu when nothing is stored", async () => {
    const state = { current: activeState() };
    const calls = mockFetch(state, ({ method }) => {
      if (method === "DELETE") {
        state.current = emailState({
          active: { activatedAt: null, activatedByUserId: null, configuration: null, enabled: false, passwordConfigured: false, version: 3 },
          draft: { configuration: null, passwordConfigured: false, test: null, version: 5 }
        });
        return Response.json({ email: state.current });
      }
      return null;
    });
    const { confirmations, feedback } = renderSection();

    await screen.findByRole("form", { name: "Email settings" });
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Clear configuration" }));

    expect(calls.filter(({ method }) => method === "DELETE")).toHaveLength(0);
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]).toMatchObject({
      confirmLabel: "Clear configuration",
      testId: "admin-confirm-clear-email",
      title: "Clear email configuration?",
      tone: "destructive"
    });
    await confirmations[0]!.onConfirm();

    await waitFor(() => expect(feedback.reportNotice).toHaveBeenCalledWith("Email configuration cleared."));
    expect(calls.find(({ method }) => method === "DELETE")?.body).toEqual({
      confirm: true,
      expectedActiveVersion: 2,
      expectedDraftVersion: 4
    });
    expect(screen.getByTestId("email-delivery-status")).toHaveTextContent("Not configured");
    expect(screen.getByLabelText("Host")).toHaveValue("");
    await waitFor(() => expect(screen.queryByRole("button", { name: "More actions" })).not.toBeInTheDocument());
  });

  it("reports action failures through the shared feedback host and offers a retry when loading fails", async () => {
    const state = { current: activeState() };
    let failLoad = true;
    mockFetch(state, ({ body, method }) => {
      if (method === "GET" && failLoad) return Response.json({ error: "email_state_invalid" }, { status: 409 });
      if (method === "POST" && body?.action === "disable") {
        return Response.json({ error: "email_active_conflict" }, { status: 409 });
      }
      return null;
    });
    const { feedback } = renderSection();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The stored email settings are inconsistent.");
    failLoad = false;
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));

    await screen.findByRole("form", { name: "Email settings" });
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Disable" }));
    await waitFor(() => expect(feedback.reportError).toHaveBeenCalledWith(
      "Email settings changed elsewhere. The page was refreshed; try again."
    ));
    expect(screen.getByTestId("email-delivery-status")).toHaveTextContent("Working");
  });
});
