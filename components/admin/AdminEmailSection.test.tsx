import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AdminEmailConfiguration, AdminEmailState } from "@/lib/contracts/email";
import { AdminEmailSection } from "./AdminEmailSection";

const configuration: AdminEmailConfiguration = {
  allowInternalNetwork: false,
  authentication: { mode: "password", username: "mailer@example.com" },
  from: { address: "noreply@example.com", displayName: "AIQSA" },
  host: "smtp.example.com",
  port: 587,
  transport: "starttls_required"
};

function emailState(overrides: Partial<AdminEmailState> = {}): AdminEmailState {
  const base: AdminEmailState = {
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
    draft: {
      configuration,
      passwordConfigured: true,
      test: null,
      version: 4
    },
    health: {
      activeVersion: null,
      degraded: false,
      lastAcceptedAt: null,
      lastAttemptAt: null,
      lastFailureAt: null,
      lastFailureCode: null
    }
  };
  return { ...base, ...overrides };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status
  });
}

describe("AdminEmailSection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps passwords write-only and supports save, exact test, activation, disable, and clear", async () => {
    let current = emailState();
    const onMutationCommitted = vi.fn(() => Promise.reject(new Error("dashboard refresh failed")));
    const requests: Array<{ body: Record<string, unknown> | null; method: string }> = [];
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string"
        ? JSON.parse(init.body) as Record<string, unknown>
        : null;
      requests.push({ body, method });
      if (method === "PUT") {
        current = emailState({
          draft: {
            configuration: body?.configuration as AdminEmailConfiguration,
            passwordConfigured: true,
            test: null,
            version: 5
          }
        });
        return json({ email: current });
      }
      if (method === "POST" && body?.action === "test") {
        current = {
          ...current,
          draft: {
            ...current.draft,
            test: {
              attemptedAt: "2026-07-23T12:05:00.000Z",
              code: "accepted",
              tested: true,
              version: current.draft.version
            }
          }
        };
        return json({ email: current, test: { code: "accepted", tested: true } });
      }
      if (method === "POST" && body?.action === "activate") {
        current = {
          ...current,
          active: {
            activatedAt: "2026-07-23T12:06:00.000Z",
            activatedByUserId: "admin-1",
            configuration: current.draft.configuration,
            enabled: true,
            passwordConfigured: true,
            version: 2
          },
          health: { ...current.health, activeVersion: 2 }
        };
        return json({ email: current });
      }
      if (method === "POST" && body?.action === "disable") {
        current = {
          ...current,
          active: { ...current.active, enabled: false, version: 3 },
          health: { ...current.health, activeVersion: 3 }
        };
        return json({ email: current });
      }
      if (method === "DELETE") {
        current = emailState({
          active: {
            activatedAt: null,
            activatedByUserId: null,
            configuration: null,
            enabled: false,
            passwordConfigured: false,
            version: 4
          },
          draft: { configuration: null, passwordConfigured: false, test: null, version: 6 }
        });
        return json({ email: current });
      }
      return json({ email: current });
    });
    vi.stubGlobal("fetch", fetcher);

    render(<AdminEmailSection onMutationCommitted={onMutationCommitted} />);

    fireEvent.click(await screen.findByRole("button", { name: /Draft configuration/i }));
    const host = await screen.findByLabelText("SMTP host");
    await waitFor(() => expect(host).toHaveValue("smtp.example.com"));
    expect(screen.getByText("The stored password is write-only.")).toBeInTheDocument();
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Password action"), { target: { value: "replace" } });
    const password = screen.getByLabelText("New password");
    expect(password).toHaveValue("");
    fireEvent.change(password, { target: { value: "new-write-only-password" } });
    fireEvent.change(host, { target: { value: "smtp2.example.com" } });
    expect(screen.getByText(/not part of the stored draft yet/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Test & activate/i }));
    expect(screen.getByRole("button", { name: "Test draft" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Draft configuration/i }));
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() => expect(requests.some(({ method }) => method === "PUT")).toBe(true));
    const save = requests.find(({ method }) => method === "PUT")?.body;
    expect(save).toMatchObject({
      configuration: { host: "smtp2.example.com" },
      expectedDraftVersion: 4,
      passwordAction: { kind: "replace", password: "new-write-only-password" }
    });
    await screen.findByText("Email draft saved. Test it before activation.");
    await waitFor(() => expect(onMutationCommitted).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(screen.queryByDisplayValue("new-write-only-password")).not.toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("Test recipient"), { target: { value: "admin@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Test draft" }));
    await screen.findByText(/accepted the test message/i);
    expect(screen.getByLabelText("Test recipient")).toHaveValue("");
    expect(requests.find(({ body }) => body?.action === "test")?.body).toEqual({
      action: "test",
      expectedDraftVersion: 5,
      recipient: "admin@example.com"
    });

    fireEvent.click(screen.getByRole("button", { name: "Activate" }));
    await screen.findByText(/now active/i);
    fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    await screen.findByText("Email delivery disabled.");
    for (const status of screen.getAllByText("Disabled")) {
      expect(status).toHaveClass("border-trace-strong", "bg-control-surface", "text-ink");
    }
    expect(screen.getByRole("button", { name: "Enable" })).toHaveClass("border-proof/25", "bg-proof/[0.08]", "text-proof");
    expect(onMutationCommitted).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /Clear configuration/i }));
    const clearButton = screen.getByRole("button", { name: "Clear email delivery" });
    expect(clearButton).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/I understand that the current SMTP configuration/i));
    expect(clearButton).toBeEnabled();
    fireEvent.click(clearButton);
    await screen.findByText("Email delivery configuration cleared.");
    await waitFor(() => expect(onMutationCommitted).toHaveBeenCalledTimes(2));
    expect(requests.find(({ method }) => method === "DELETE")?.body).toMatchObject({
      confirm: true,
      expectedActiveVersion: 3,
      expectedDraftVersion: 5
    });
  });

  it("shows the explicit no-auth plaintext warning and clears password on save", async () => {
    const current = emailState();
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") return json({ email: current });
      return json({ email: current });
    });
    vi.stubGlobal("fetch", fetcher);
    render(<AdminEmailSection />);
    fireEvent.click(await screen.findByRole("button", { name: /Draft configuration/i }));
    const host = await screen.findByLabelText("SMTP host");
    await waitFor(() => expect(host).toHaveValue("smtp.example.com"));

    fireEvent.change(screen.getByLabelText("Transport security"), {
      target: { value: "plaintext_internal_no_auth" }
    });
    fireEvent.change(screen.getByLabelText("Authentication"), { target: { value: "none" } });
    expect(screen.getByText(/Plaintext is allowed only/i)).toBeInTheDocument();
    expect(screen.getByText(/explicitly clears any stored draft password/i)).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Save draft" });
    expect(save).toBeDisabled();
    const internalApproval = screen.getByRole("checkbox", {
      name: /Allow a reviewed internal-network relay/i
    });
    expect(internalApproval).not.toBeChecked();
    fireEvent.click(internalApproval);
    expect(save).toBeDisabled();
    const exactRelayAcknowledgement = screen.getByRole("checkbox", {
      name: "Acknowledge exact plaintext relay"
    });
    expect(exactRelayAcknowledgement).not.toBeChecked();
    fireEvent.click(exactRelayAcknowledgement);
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      "/api/admin/email",
      expect.objectContaining({ method: "PUT" })
    ));
    const put = fetcher.mock.calls.find(([, init]) => init?.method === "PUT")?.[1];
    expect(JSON.parse(String(put?.body))).toMatchObject({
      configuration: {
        allowInternalNetwork: true,
        authentication: { mode: "none" },
        transport: "plaintext_internal_no_auth"
      },
      passwordAction: { confirm: true, kind: "clear" }
    });
  });

  it("does not inherit plaintext acknowledgement from a stored internal-network policy", async () => {
    const plaintextConfiguration: AdminEmailConfiguration = {
      ...configuration,
      allowInternalNetwork: true,
      authentication: { mode: "none" },
      transport: "plaintext_internal_no_auth"
    };
    const current = emailState({
      draft: {
        configuration: plaintextConfiguration,
        passwordConfigured: false,
        test: null,
        version: 8
      }
    });
    vi.stubGlobal("fetch", vi.fn(async () => json({ email: current })));
    render(<AdminEmailSection />);
    fireEvent.click(await screen.findByRole("button", { name: /Draft configuration/i }));
    const host = await screen.findByLabelText("SMTP host");
    await waitFor(() => expect(host).toHaveValue("smtp.example.com"));

    const configurationAcknowledge = screen.getByRole("checkbox", {
      name: "Acknowledge exact plaintext relay"
    });
    expect(configurationAcknowledge).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /Test & activate/i }));
    fireEvent.change(screen.getByLabelText("Test recipient"), {
      target: { value: "admin@example.com" }
    });
    const commissioningAcknowledge = screen.getByRole("checkbox", {
      name: "Acknowledge exact plaintext relay"
    });
    expect(commissioningAcknowledge).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Test draft" })).toBeDisabled();

    fireEvent.click(commissioningAcknowledge);
    expect(screen.getByRole("button", { name: "Test draft" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /Draft configuration/i }));
    expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled();
  });

  it("keeps compact email tasks separate and preserves an unfinished local draft", async () => {
    const current = emailState();
    vi.stubGlobal("fetch", vi.fn(async () => json({ email: current })));
    render(<AdminEmailSection />);

    await screen.findByRole("heading", { name: "Email tasks" });
    expect(screen.getByTestId("email-task-index")).toHaveClass("block");
    expect(screen.getByTestId("email-task-detail")).toHaveClass("hidden");

    fireEvent.click(screen.getByRole("button", { name: /Draft configuration/i }));
    expect(screen.getByTestId("email-task-index")).toHaveClass("hidden");
    expect(screen.getByTestId("email-task-detail")).toHaveClass("block");
    fireEvent.change(screen.getByLabelText("SMTP host"), { target: { value: "unfinished.example.com" } });

    fireEvent.click(screen.getByRole("button", { name: "Back to email tasks" }));
    expect(screen.getByTestId("email-task-index")).toHaveClass("block");
    fireEvent.click(screen.getByRole("button", { name: /Draft configuration/i }));
    expect(screen.getByLabelText("SMTP host")).toHaveValue("unfinished.example.com");
  });

  it("clears the one-use test recipient after a failed SMTP attempt", async () => {
    let current = emailState();
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        current = {
          ...current,
          draft: {
            ...current.draft,
            test: {
              attemptedAt: "2026-07-23T12:05:00.000Z",
              code: "smtp_connection_failed",
              tested: false,
              version: current.draft.version
            }
          }
        };
        return json({
          email: current,
          test: { code: "smtp_connection_failed", tested: false }
        });
      }
      return json({ email: current });
    });
    vi.stubGlobal("fetch", fetcher);
    render(<AdminEmailSection />);

    fireEvent.click(await screen.findByRole("button", { name: /Test & activate/i }));
    const recipient = screen.getByLabelText("Test recipient");
    fireEvent.change(recipient, { target: { value: "one-use@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Test draft" }));

    await screen.findByText(/did not accept the test message/i);
    expect(recipient).toHaveValue("");
  });
});
