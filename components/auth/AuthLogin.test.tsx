import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthLogin } from "./AuthLogin";

describe("AuthLogin", () => {
  afterEach(() => {
    window.history.replaceState({}, "", "/");
    vi.restoreAllMocks();
  });

  function fillCredentialForm() {
    fireEvent.change(screen.getByLabelText("Email"), {
      target: {
        value: "operator@aiqsa.local"
      }
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: {
        value: "password"
      }
    });
  }

  function expectAssociatedInvalidField(
    field: HTMLElement,
    alert: HTMLElement,
    helpId?: string
  ) {
    expect(alert.id).not.toBe("");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAttribute("aria-errormessage", alert.id);
    expect(field.getAttribute("aria-describedby")?.split(/\s+/)).toEqual(
      expect.arrayContaining([...(helpId ? [helpId] : []), alert.id])
    );
    expect(field).toHaveClass("border-critical", "focus:ring-focus");
  }

  it("presents a restrained, labeled sign-in workspace with autofill-safe field contracts", () => {
    render(<AuthLogin nextPath="/" />);

    expect(screen.getByTestId("auth-lockup")).toHaveTextContent("AIQSA");
    expect(screen.getByTestId("auth-root")).toHaveClass("v2-auth-root");
    expect(screen.getByTestId("auth-workspace")).toHaveClass("v2-auth-column");
    expect(screen.getByRole("heading", { level: 1, name: "Sign in to your workspace" })).toBeInTheDocument();
    expect(screen.getByText("Self-hosted · your data stays on your infrastructure")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" }).closest(".v2-auth-card")).not.toBeNull();
    expect(screen.getByLabelText("Email")).toHaveAttribute("autocomplete", "email");
    expect(screen.getByLabelText("Email")).toHaveAttribute("inputmode", "email");
    expect(screen.getByLabelText("Email")).toHaveClass(
      "border-control-boundary",
      "focus:ring-focus",
      "disabled:border-trace-subtle"
    );
    expect(screen.getByLabelText("Password")).toHaveAttribute("autocomplete", "current-password");
    expect(screen.getByLabelText("Password")).not.toHaveAttribute("aria-describedby");
    expect(screen.getByRole("button", { name: "Show password" })).toHaveAttribute("aria-controls", "password");
    expect(screen.getByLabelText("Email")).not.toHaveFocus();
    expect(screen.getByLabelText("Email")).not.toHaveAttribute("style");
    expect(screen.getByLabelText("Password")).not.toHaveAttribute("style");
  });

  it("hydrates stable login markup and handles the first mode-switch click", async () => {
    const container = document.createElement("div");
    container.innerHTML = renderToString(<AuthLogin nextPath="/" />);
    document.body.append(container);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let root: Root | null = null;

    await act(async () => {
      root = hydrateRoot(container, <AuthLogin nextPath="/" />);
    });

    expect(
      consoleError.mock.calls.some((call) =>
        call.some((value) => /hydration|did not match/i.test(String(value)))
      )
    ).toBe(false);
    expect(within(container).getByLabelText("Email")).not.toHaveAttribute("style");
    expect(within(container).getByLabelText("Password")).not.toHaveAttribute("style");

    fireEvent.click(within(container).getByRole("button", { name: "Request access" }));
    expect(within(container).getByRole("heading", { level: 1, name: "Request access" })).toBeInTheDocument();

    await act(async () => {
      root?.unmount();
    });
    container.remove();
  });

  it("explains that an expired or revoked session requires another sign-in", () => {
    render(<AuthLogin nextPath="/workspace" sessionExpired />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Your session ended or was revoked. Sign in again to continue. (session_expired)"
    );
  });

  it("shows only configured OAuth providers and preserves a safe internal destination", () => {
    render(
      <AuthLogin
        nextPath="/admin?tab=users#section"
        oauthProviders={["google", "yandex"]}
      />
    );

    const googleLink = screen.getByRole("link", { name: "Continue with Google" });
    expect(googleLink).toHaveAttribute(
      "href",
      "/api/auth/oauth/google?next=%2Fadmin%3Ftab%3Dusers%23section"
    );
    expect(screen.getByRole("link", { name: "Continue with Yandex" })).toHaveAttribute(
      "href",
      "/api/auth/oauth/yandex?next=%2Fadmin%3Ftab%3Dusers%23section"
    );
    expect(googleLink).toHaveClass("w-full");
    expect(googleLink.parentElement).toHaveClass("sm:grid-cols-2");
    expect(screen.getByText("or")).toBeInTheDocument();
    // OAuth follows the primary action (PRD §4.11): Sign in → or → Continue with …
    expect(
      screen.getByRole("button", { name: "Sign in" }).compareDocumentPosition(googleLink) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("does not expose unconfigured OAuth actions or carry an unsafe destination", () => {
    const { rerender } = render(<AuthLogin nextPath="/" />);

    expect(screen.queryByRole("link", { name: /Continue with/ })).not.toBeInTheDocument();

    rerender(<AuthLogin nextPath="https://evil.example/steal" oauthProviders={["google"]} />);
    const googleLink = screen.getByRole("link", { name: "Continue with Google" });
    expect(googleLink).toHaveAttribute(
      "href",
      "/api/auth/oauth/google?next=%2F"
    );
    expect(googleLink).toHaveClass("w-full");
    expect(googleLink.parentElement).not.toHaveClass("sm:grid-cols-2");
  });

  it("keeps OAuth choices out of proof-bearing modes and activates a newly received proof", async () => {
    const { rerender } = render(
      <AuthLogin inviteToken="invite-token" nextPath="/" oauthProviders={["google", "yandex"]} />
    );

    expect(screen.getByRole("heading", { level: 1, name: "Create your account" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Continue with/ })).not.toBeInTheDocument();

    rerender(<AuthLogin nextPath="/" oauthProviders={["google", "yandex"]} resetToken="reset-token" />);
    expect(await screen.findByRole("heading", { level: 1, name: "Choose a new password" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update password" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Continue with/ })).not.toBeInTheDocument();
  });

  it("starts a fresh uncontrolled field session when an invite or reset proof changes", async () => {
    const { rerender } = render(<AuthLogin inviteToken="invite-proof-a" nextPath="/" />);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Old invite name" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "old-invite-password" } });
    rerender(<AuthLogin inviteToken="invite-proof-b" nextPath="/" />);

    await waitFor(() => {
      expect(screen.getByLabelText("Name")).toHaveValue("");
      expect(screen.getByLabelText("Password")).toHaveValue("");
    });

    rerender(<AuthLogin nextPath="/" resetToken="reset-proof-a" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Update password" })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "old-reset-password" } });
    rerender(<AuthLogin nextPath="/" resetToken="reset-proof-b" />);

    await waitFor(() => expect(screen.getByLabelText("New password")).toHaveValue(""));
    expect(document.body.innerHTML).not.toContain("invite-proof-a");
    expect(document.body.innerHTML).not.toContain("invite-proof-b");
    expect(document.body.innerHTML).not.toContain("reset-proof-a");
    expect(document.body.innerHTML).not.toContain("reset-proof-b");
  });

  it("ignores a stale invite settlement after a proof transition and enables the new invite", async () => {
    let resolveFirstInvite!: (response: Response) => void;
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveFirstInvite = resolve;
          })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "active" }), {
          status: 200
        })
      );
    const navigateAfterLogin = vi.fn();
    window.history.replaceState({}, "", "/login?invite=invite-a&next=%2Fworkspace#auth");
    const { rerender } = render(
      <AuthLogin inviteToken="invite-a" navigateAfterLogin={navigateAfterLogin} nextPath="/workspace" />
    );

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Invite A" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "invite-a-password" } });
    fireEvent.submit(screen.getByRole("button", { name: "Create account" }).closest("form")!);
    expect(await screen.findByRole("button", { name: "Creating account…" })).toBeDisabled();

    window.history.replaceState({}, "", "/login?invite=invite-b&next=%2Fworkspace#auth");
    rerender(
      <AuthLogin inviteToken="invite-b" navigateAfterLogin={navigateAfterLogin} nextPath="/workspace" />
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Create account" })).toBeEnabled();
      expect(screen.getByLabelText("Name")).toHaveValue("");
      expect(screen.getByLabelText("Password")).toHaveValue("");
    });

    await act(async () => {
      resolveFirstInvite(
        new Response(JSON.stringify({ status: "active" }), {
          status: 200
        })
      );
    });
    expect(navigateAfterLogin).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { level: 1, name: "Create your account" })).toBeInTheDocument();
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(
      "/login?invite=invite-b&next=%2Fworkspace#auth"
    );

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Invite B" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "invite-b-password" } });
    fireEvent.submit(screen.getByRole("button", { name: "Create account" }).closest("form")!);

    await waitFor(() => expect(navigateAfterLogin).toHaveBeenCalledTimes(1));
    expect(navigateAfterLogin).toHaveBeenCalledWith("/workspace");
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "/api/auth/invite/accept",
      expect.objectContaining({
        body: JSON.stringify({
          displayName: "Invite B",
          password: "invite-b-password",
          token: "invite-b"
        }),
        method: "POST"
      })
    );
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(
      "/login?next=%2Fworkspace#auth"
    );
  });

  it("renders privacy-safe OAuth callback outcomes", () => {
    const { unmount } = render(
      <AuthLogin nextPath="/" oauthOutcome="pending" oauthProvider="google" oauthProviders={["google"]} />
    );

    const pendingStatus = screen.getByRole("status");
    const pendingForm = screen.getByRole("button", { name: "Sign in" }).closest("form");
    expect(pendingStatus).toHaveTextContent(
      "Google confirmed your account. AIQSA access is pending administrator approval."
    );
    expect(pendingForm).not.toBeNull();
    expect(pendingStatus.compareDocumentPosition(pendingForm!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByRole("status")).toHaveLength(1);

    unmount();
    render(
      <AuthLogin nextPath="/" oauthOutcome="not_allowed" oauthProvider="yandex" oauthProviders={["yandex"]} />
    );
    const disallowedAlert = screen.getByRole("alert");
    const disallowedForm = screen.getByRole("button", { name: "Sign in" }).closest("form");
    expect(disallowedAlert).toHaveTextContent(
      "This Yandex account is not allowed to access AIQSA. (oauth_not_allowed)"
    );
    expect(disallowedForm).not.toBeNull();
    expect(disallowedAlert.compareDocumentPosition(disallowedForm!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("moves focus to the first useful field on every manual mode transition", async () => {
    render(<AuthLogin nextPath="/" />);

    fireEvent.click(screen.getByRole("button", { name: "Request access" }));
    expect(screen.getByRole("heading", { level: 1, name: "Request access" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveFocus());

    fireEvent.click(screen.getByRole("button", { name: "Back to sign in" }));
    await waitFor(() => expect(screen.getByLabelText("Email")).toHaveFocus());

    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
    expect(screen.getByRole("heading", { level: 1, name: "Reset your password" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Email")).toHaveFocus());
  });

  it("uses a compact two-column registration composition without collecting a password", () => {
    render(<AuthLogin nextPath="/" />);

    fireEvent.click(screen.getByRole("button", { name: "Request access" }));
    expect(screen.getByTestId("register-form")).toHaveClass(
      "sm:[@media(max-height:45rem)]:grid",
      "sm:[@media(max-height:45rem)]:grid-cols-2",
      "sm:[@media(max-height:45rem)]:space-y-0"
    );
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Request access" })).toHaveClass(
      "sm:[@media(max-height:45rem)]:self-end"
    );
  });

  it("shows and hides passwords without clearing the field", () => {
    render(<AuthLogin nextPath="/" />);

    const password = screen.getByLabelText("Password");
    fireEvent.change(password, { target: { value: "kept-secret" } });
    expect(password).toHaveAttribute("type", "password");

    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(password).toHaveAttribute("type", "text");
    expect(password).toHaveValue("kept-secret");
    expect(screen.getByRole("button", { name: "Hide password" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Hide password" }));
    expect(password).toHaveAttribute("type", "password");
    expect(password).toHaveValue("kept-secret");
  });

  it("shows a readable message for missing email/password credentials", async () => {
    render(<AuthLogin nextPath="/" />);

    const submit = screen.getByRole("button", { name: "Sign in" });
    const form = submit.closest("form")!;
    const resetPassword = screen.getByRole("button", { name: "Reset password" });
    fireEvent.submit(form);

    const alert = await screen.findByRole("alert");
    const email = screen.getByLabelText("Email");
    const password = screen.getByLabelText("Password");

    expect(alert).toHaveTextContent("Enter email and password. (credentials_required)");
    expect(form).toContainElement(alert);
    expect(submit.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(alert.compareDocumentPosition(resetPassword) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(email).toHaveAttribute("aria-invalid", "true");
    expect(password).toHaveAttribute("aria-invalid", "true");
    expect(email).toHaveAttribute("aria-errormessage", alert.id);
    expect(password).toHaveAttribute("aria-errormessage", alert.id);
    expect(email).toHaveClass("border-critical", "focus:ring-focus");
    expect(password).toHaveClass("border-critical", "focus:ring-focus");
  });

  it.each([
    {
      expectedError: "Enter an email address to request access. (registration_required)",
      fieldId: "register-email",
      helpId: "register-email-help",
      name: "access request",
      prepare: () => fireEvent.click(screen.getByRole("button", { name: "Request access" })),
      renderAuth: () => <AuthLogin nextPath="/" />,
      submitName: "Request access",
      unrelatedFieldId: "register-name"
    },
    {
      expectedError: "Enter an email address. (email_required)",
      fieldId: "reset-email",
      helpId: "reset-email-help",
      name: "reset request",
      prepare: () => fireEvent.click(screen.getByRole("button", { name: "Reset password" })),
      renderAuth: () => <AuthLogin nextPath="/" />,
      submitName: "Send reset link",
      unrelatedFieldId: undefined
    },
    {
      expectedError: "Open the invite link and choose a password. (invite_token_password_required)",
      fieldId: "invite-password",
      helpId: "invite-password-help",
      name: "invite acceptance",
      prepare: undefined,
      renderAuth: () => <AuthLogin inviteToken="invite-token" nextPath="/" />,
      submitName: "Create account",
      unrelatedFieldId: "register-name"
    },
    {
      expectedError: "Open the verification link and choose a password. (verification_token_password_required)",
      fieldId: "verification-password",
      helpId: "verification-password-help",
      name: "email verification",
      prepare: undefined,
      renderAuth: () => <AuthLogin nextPath="/" verifyToken="verify-token" />,
      submitName: "Set password and verify",
      unrelatedFieldId: undefined
    },
    {
      expectedError: "Enter a new password. (reset_token_password_required)",
      fieldId: "new-password",
      helpId: "new-password-help",
      name: "reset completion",
      prepare: undefined,
      renderAuth: () => <AuthLogin nextPath="/" resetToken="reset-token" />,
      submitName: "Update password",
      unrelatedFieldId: undefined
    }
  ])("associates a local $name error with its attributable field", async ({
    expectedError,
    fieldId,
    helpId,
    prepare,
    renderAuth,
    submitName,
    unrelatedFieldId
  }) => {
    render(renderAuth());
    prepare?.();

    fireEvent.submit(screen.getByRole("button", { name: submitName }).closest("form")!);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(expectedError);
    expectAssociatedInvalidField(document.getElementById(fieldId)!, alert, helpId);
    if (unrelatedFieldId) {
      expect(document.getElementById(unrelatedFieldId)).not.toHaveAttribute("aria-invalid");
    }
  });

  it.each([
    {
      fieldId: "invite-password",
      fieldLabel: "Password",
      helpId: "invite-password-help",
      name: "invite acceptance",
      renderAuth: () => <AuthLogin inviteToken="invite-token" nextPath="/" />,
      submitName: "Create account"
    },
    {
      fieldId: "verification-password",
      fieldLabel: "New password",
      helpId: "verification-password-help",
      name: "email verification",
      renderAuth: () => <AuthLogin nextPath="/" verifyToken="verify-token" />,
      submitName: "Set password and verify"
    },
    {
      fieldId: "new-password",
      fieldLabel: "New password",
      helpId: "new-password-help",
      name: "reset completion",
      renderAuth: () => <AuthLogin nextPath="/" resetToken="reset-token" />,
      submitName: "Update password"
    }
  ])("associates a server password error with the $name field", async ({
    fieldId,
    fieldLabel,
    helpId,
    renderAuth,
    submitName
  }) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "password_too_short" }), { status: 400 })
    );
    render(renderAuth());
    fireEvent.change(screen.getByLabelText(fieldLabel), { target: { value: "short" } });

    fireEvent.submit(screen.getByRole("button", { name: submitName }).closest("form")!);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Use at least 8 characters. (password_too_short)");
    expectAssociatedInvalidField(document.getElementById(fieldId)!, alert, helpId);
  });

  it("marks both credential fields and keeps a rejected login next to its action", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401
      })
    );
    render(<AuthLogin nextPath="/" />);

    fillCredentialForm();
    const submit = screen.getByRole("button", { name: "Sign in" });
    const resetPassword = screen.getByRole("button", { name: "Reset password" });
    fireEvent.submit(submit.closest("form")!);

    const alert = await screen.findByRole("alert");

    expect(alert).toHaveTextContent("The credentials were not accepted. (unauthorized)");
    expect(submit.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(alert.compareDocumentPosition(resetPassword) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expectAssociatedInvalidField(screen.getByLabelText("Email"), alert);
    expectAssociatedInvalidField(screen.getByLabelText("Password"), alert);
  });

  it("shows a readable network error when credential login cannot reach the server", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    render(<AuthLogin nextPath="/" />);

    fillCredentialForm();
    fireEvent.submit(screen.getByRole("button", { name: "Sign in" }).closest("form")!);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Could not reach the server. Check your connection and try again. (network_error)"
      );
    });
    expect(screen.getByLabelText("Email")).toHaveFocus();
  });

  it.each([
    {
      expectedError: "Sign in failed. Try again. (login_failed)",
      fieldId: "email",
      name: "sign in",
      prepare: fillCredentialForm,
      renderAuth: () => <AuthLogin nextPath="/" />,
      submitName: "Sign in"
    },
    {
      expectedError: "Access request failed. Try again. (access_request_failed)",
      fieldId: "register-email",
      name: "access request",
      prepare: () => {
        fireEvent.click(screen.getByRole("button", { name: "Request access" }));
        fireEvent.change(screen.getByLabelText("Email"), { target: { value: "person@example.com" } });
      },
      renderAuth: () => <AuthLogin nextPath="/" />,
      submitName: "Request access"
    },
    {
      expectedError: "Password reset request failed. Try again. (reset_request_failed)",
      fieldId: "reset-email",
      name: "reset request",
      prepare: () => {
        fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
        fireEvent.change(screen.getByLabelText("Email"), { target: { value: "person@example.com" } });
      },
      renderAuth: () => <AuthLogin nextPath="/" />,
      submitName: "Send reset link"
    },
    {
      expectedError: "Account creation failed. Try again. (invite_acceptance_failed)",
      fieldId: "invite-password",
      name: "invite acceptance",
      prepare: () => fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password-value" } }),
      renderAuth: () => <AuthLogin inviteToken="invite-token" nextPath="/" />,
      submitName: "Create account"
    },
    {
      expectedError: "Email verification failed. Try again. (verification_failed)",
      fieldId: "verification-password",
      name: "email verification",
      prepare: () => fireEvent.change(screen.getByLabelText("New password"), { target: { value: "password-value" } }),
      renderAuth: () => <AuthLogin nextPath="/" verifyToken="verify-token" />,
      submitName: "Set password and verify"
    },
    {
      expectedError: "Password update failed. Try again. (password_reset_failed)",
      fieldId: "new-password",
      name: "reset completion",
      prepare: () => fireEvent.change(screen.getByLabelText("New password"), { target: { value: "password-value" } }),
      renderAuth: () => <AuthLogin nextPath="/" resetToken="reset-token" />,
      submitName: "Update password"
    }
  ])("uses operation-specific recovery copy for a malformed $name response", async ({
    expectedError,
    fieldId,
    prepare,
    renderAuth,
    submitName
  }) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not-json", { status: 200 }));
    render(renderAuth());
    prepare();

    fireEvent.submit(screen.getByRole("button", { name: submitName }).closest("form")!);

    expect(await screen.findByRole("alert")).toHaveTextContent(expectedError);
    expect(document.getElementById(fieldId)).not.toHaveAttribute("aria-invalid");
    expect(document.getElementById(fieldId)).not.toHaveAttribute("aria-errormessage");
  });

  it("does not navigate when sign-in returns an ok-only response without a user", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    const navigateAfterLogin = vi.fn();
    render(<AuthLogin navigateAfterLogin={navigateAfterLogin} nextPath="/" />);
    fillCredentialForm();

    fireEvent.submit(screen.getByRole("button", { name: "Sign in" }).closest("form")!);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Sign in failed. Try again. (login_failed)"
    );
    expect(navigateAfterLogin).not.toHaveBeenCalled();
  });

  it("uses fallback copy when a stable backend code matches an object prototype key", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "constructor" }), { status: 500 })
    );
    render(<AuthLogin nextPath="/" />);
    fillCredentialForm();

    fireEvent.submit(screen.getByRole("button", { name: "Sign in" }).closest("form")!);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Sign in failed. Try again. (constructor)"
    );
  });

  it("locks the active form and exposes readable busy status during sign in", async () => {
    let resolveFetch!: (response: Response) => void;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    );
    const navigateAfterLogin = vi.fn();
    render(<AuthLogin navigateAfterLogin={navigateAfterLogin} nextPath="/" />);

    fillCredentialForm();
    fireEvent.submit(screen.getByRole("button", { name: "Sign in" }).closest("form")!);

    expect(await screen.findByRole("button", { name: "Signing in…" })).toBeDisabled();
    expect(screen.getByLabelText("Email")).toBeDisabled();
    expect(screen.getByLabelText("Password")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Show password" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reset password" })).toBeDisabled();
    expect(screen.getAllByText("Signing in…")).toHaveLength(1);
    expect(screen.getByTestId("auth-submit-spinner")).toBeInTheDocument();
    expect(screen.queryByText("Signing in…", { selector: "p" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Signing in…" }).closest("form")).toHaveAttribute("aria-busy", "true");

    await act(async () => {
      resolveFetch(
        new Response(JSON.stringify({ user: { id: "user-1" } }), {
          status: 200
        })
      );
    });
    await waitFor(() => expect(navigateAfterLogin).toHaveBeenCalledWith("/"));
  });

  it("sanitizes unsafe post-login redirect targets at navigation time", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ user: { id: "user-1" } }), {
        status: 200
      })
    );
    const navigateAfterLogin = vi.fn();
    render(<AuthLogin navigateAfterLogin={navigateAfterLogin} nextPath="/\\evil.com" />);

    fillCredentialForm();
    fireEvent.submit(screen.getByRole("button", { name: "Sign in" }).closest("form")!);

    await waitFor(() => {
      expect(navigateAfterLogin).toHaveBeenCalledWith("/");
    });
  });

  it("keeps legitimate internal post-login redirect targets", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ user: { id: "user-1" } }), {
        status: 200
      })
    );
    const navigateAfterLogin = vi.fn();
    render(<AuthLogin navigateAfterLogin={navigateAfterLogin} nextPath="/admin?tab=users#section" />);

    fillCredentialForm();
    fireEvent.submit(screen.getByRole("button", { name: "Sign in" }).closest("form")!);

    await waitFor(() => {
      expect(navigateAfterLogin).toHaveBeenCalledWith("/admin?tab=users#section");
    });
  });

  it("requests a password reset with a generic success notice", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200
      })
    );
    render(<AuthLogin nextPath="/" />);

    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
    fireEvent.change(screen.getByLabelText("Email"), {
      target: {
        value: "operator@aiqsa.local"
      }
    });
    fireEvent.submit(screen.getByRole("button", { name: "Send reset link" }).closest("form")!);

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/auth/password-reset/request",
        expect.objectContaining({
          method: "POST"
        })
      );
    });
    expect(await screen.findByText("If the account can reset, a link has been sent.")).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveFocus();
    expect(screen.getByText("For privacy, the result is the same whether or not an eligible account exists.")).toBeInTheDocument();
  });

  it("accepts an invite with name and password and enters the workspace directly", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "active" }), {
        status: 200
      })
    );
    const navigateAfterLogin = vi.fn();
    window.history.replaceState({}, "", "/login?invite=invite-token&next=%2Fwelcome");
    render(<AuthLogin inviteToken="invite-token" navigateAfterLogin={navigateAfterLogin} nextPath="/welcome" />);

    expect(screen.getByRole("heading", { level: 1, name: "Create your account" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create account" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toHaveAttribute("autocomplete", "new-password");
    expect(
      screen.getByText("This one-time invitation confirms your email. Choose your name and password to enter AIQSA.")
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Name"), {
      target: {
        value: "Invited User"
      }
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: {
        value: "invited-password"
      }
    });
    fireEvent.submit(screen.getByRole("button", { name: "Create account" }).closest("form")!);

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/auth/invite/accept",
        expect.objectContaining({
          body: JSON.stringify({
            displayName: "Invited User",
            password: "invited-password",
            token: "invite-token"
          }),
          method: "POST"
        })
      );
    });
    expect(navigateAfterLogin).toHaveBeenCalledWith("/welcome");
    expect(window.location.search).toBe("?next=%2Fwelcome");
    expect(screen.queryByRole("heading", { level: 1, name: "Check your email" })).not.toBeInTheDocument();
  });

  it("keeps direct invite details available after an invalid-link response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid_invite_token" }), {
        status: 400
      })
    );
    render(<AuthLogin inviteToken="used-invite" nextPath="/" />);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Kept Name" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "kept-password" } });
    fireEvent.submit(screen.getByRole("button", { name: "Create account" }).closest("form")!);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "This invite link is invalid or expired. (invalid_invite_token)"
    );
    expect(screen.getByLabelText("Password")).not.toHaveAttribute("aria-invalid");
    expect(screen.getByLabelText("Password")).toHaveAccessibleDescription(
      "Use at least 8 characters. The invitation works only once."
    );
    expect(screen.getByLabelText("Name")).toHaveValue("Kept Name");
    expect(screen.getByLabelText("Password")).toHaveValue("kept-password");
    expect(screen.getByRole("button", { name: "Create account" })).toBeEnabled();
  });

  it("keeps generic request-received success truthful when delivery is intentionally undisclosed", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "request_received" }), {
        status: 200
      })
    );
    render(<AuthLogin nextPath="/" />);

    fireEvent.click(screen.getByRole("button", { name: "Request access" }));
    fireEvent.change(screen.getByLabelText("Email"), {
      target: {
        value: "eligible@example.com"
      }
    });
    fireEvent.submit(screen.getByRole("button", { name: "Request access" }).closest("form")!);

    const outcomeHeading = await screen.findByRole("heading", { level: 1, name: "Request received" });
    await waitFor(() => expect(outcomeHeading).toHaveFocus());
    expect(
      screen.getByText("Request received. If verification is needed, use the email link before signing in.")
    ).toBeInTheDocument();
    expect(screen.queryByText(/we sent/i)).not.toBeInTheDocument();
    expect(screen.getByText("The response stays generic so account and delivery details remain private.")).toBeInTheDocument();
  });

  it("shows an allowlist denial without entering the check-email state", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "registration_not_allowed" }), {
        status: 400
      })
    );
    render(<AuthLogin nextPath="/" />);

    fireEvent.click(screen.getByRole("button", { name: "Request access" }));
    fireEvent.change(screen.getByLabelText("Email"), {
      target: {
        value: "person@typo.example"
      }
    });
    fireEvent.submit(screen.getByRole("button", { name: "Request access" }).closest("form")!);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "This email or domain is not allowed to request access. (registration_not_allowed)"
    );
    expectAssociatedInvalidField(screen.getByLabelText("Email"), alert, "register-email-help");
    expect(screen.queryByText("Use the verification link we sent before signing in.")).not.toBeInTheDocument();
  });

  it("verifies email links and shows the active sign-in state", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "active" }), {
        status: 200
      })
    );
    window.history.replaceState(
      {},
      "",
      "/login?verify=verify-token&next=%2Fadmin&oauth=cancelled#auth"
    );
    render(
      <AuthLogin
        inviteToken="lower-priority-invite"
        nextPath="/admin"
        resetToken="lower-priority-reset"
        verifyToken="verify-token"
      />
    );

    expect(screen.getByRole("heading", { level: 1, name: "Choose your password" })).toBeInTheDocument();
    expect(screen.getByLabelText("New password")).toHaveFocus();
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("New password"), {
      target: {
        value: "verified-password"
      }
    });
    fireEvent.submit(screen.getByRole("button", { name: "Set password and verify" }).closest("form")!);

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/auth/verify-email",
        expect.objectContaining({
          body: JSON.stringify({
            password: "verified-password",
            token: "verify-token"
          }),
          method: "POST"
        })
      );
    });
    expect(
      await screen.findByText("Email verified and password set. Your account is active. Sign in to continue.")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Request access" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create account" })).not.toBeInTheDocument();
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(
      "/login?next=%2Fadmin&oauth=cancelled#auth"
    );
  });

  it("shows pending admin approval after verification when no approval rule matches", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "pending" }), {
        status: 200
      })
    );
    const { rerender } = render(<AuthLogin nextPath="/" verifyToken="verify-token" />);

    fireEvent.change(screen.getByLabelText("New password"), {
      target: {
        value: "pending-password"
      }
    });
    fireEvent.submit(screen.getByRole("button", { name: "Set password and verify" }).closest("form")!);

    expect(await screen.findByText("Email verified and password set. Access is pending admin approval.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Sign in to your workspace" })).toBeInTheDocument();
    rerender(<AuthLogin nextPath="/admin" verifyToken="verify-token" />);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("shows a stable error and sign-in escape path for an invalid verification link", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid_or_expired_verification_token" }), {
        status: 400
      })
    );
    render(<AuthLogin nextPath="/" verifyToken="expired-token" />);

    fireEvent.change(screen.getByLabelText("New password"), {
      target: {
        value: "kept-password"
      }
    });
    fireEvent.submit(screen.getByRole("button", { name: "Set password and verify" }).closest("form")!);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "This verification link is invalid or expired. (invalid_or_expired_verification_token)"
    );
    expect(screen.getByLabelText("New password")).not.toHaveAttribute("aria-invalid");
    expect(screen.getByRole("heading", { level: 1, name: "Choose your password" })).toBeInTheDocument();
    expect(screen.getByLabelText("New password")).toHaveValue("kept-password");
    expect(screen.getByRole("button", { name: "Back to sign in" })).toBeInTheDocument();
  });

  it("shows the reset completion form when a reset token is present", async () => {
    render(<AuthLogin nextPath="/" resetToken="reset-token" />);

    expect(screen.getByLabelText("New password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update password" })).toBeInTheDocument();
    expect(screen.getByText("Use at least 8 characters. This link works only once.")).toBeInTheDocument();
    expect(screen.getByLabelText("New password")).toHaveFocus();
  });

  it("completes a one-shot password reset and returns to a focused sign-in success state", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200
      })
    );
    window.history.replaceState({}, "", "/login?reset=reset-token&next=%2Fsettings");
    render(<AuthLogin nextPath="/settings" resetToken="reset-token" />);

    fireEvent.change(screen.getByLabelText("New password"), {
      target: {
        value: "new-password-value"
      }
    });
    fireEvent.submit(screen.getByRole("button", { name: "Update password" }).closest("form")!);

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/auth/password-reset/complete",
        expect.objectContaining({
          body: JSON.stringify({
            password: "new-password-value",
            token: "reset-token"
          }),
          method: "POST"
        })
      );
    });
    expect(await screen.findByText("Password updated. Sign in to continue.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Sign in to your workspace" })).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveFocus();
    expect(window.location.search).toBe("?next=%2Fsettings");
  });

  it("retires every proof after leaving a combined token URL and cannot resurrect invite semantics", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "request_received" }), {
        status: 200
      })
    );
    window.history.replaceState(
      {},
      "",
      "/login?verify=verify-token&reset=reset-token&invite=invite-token&next=%2Fadmin"
    );
    const proofProps = {
      inviteToken: "invite-token",
      nextPath: "/admin",
      resetToken: "reset-token",
      verifyToken: "verify-token"
    } as const;
    const { rerender } = render(<AuthLogin {...proofProps} />);

    fireEvent.click(screen.getByRole("button", { name: "Back to sign in" }));

    expect(screen.getByRole("heading", { level: 1, name: "Sign in to your workspace" })).toBeInTheDocument();
    expect(window.location.search).toBe("?next=%2Fadmin");
    expect(screen.getByRole("button", { name: "Request access" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create account" })).not.toBeInTheDocument();

    rerender(<AuthLogin {...proofProps} />);
    expect(screen.getByRole("heading", { level: 1, name: "Sign in to your workspace" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Request access" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Request access" }));
    expect(screen.getByRole("heading", { level: 1, name: "Request access" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "person@example.com" }
    });
    fireEvent.submit(screen.getByRole("button", { name: "Request access" }).closest("form")!);

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/auth/register",
        expect.objectContaining({
          body: JSON.stringify({ displayName: "", email: "person@example.com" }),
          method: "POST"
        })
      );
    });
    expect(fetch).not.toHaveBeenCalledWith("/api/auth/invite/accept", expect.anything());
  });

  it("keeps reset completion available after an invalid or replayed token error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid_or_expired_reset_token" }), {
        status: 400
      })
    );
    render(<AuthLogin nextPath="/" resetToken="used-token" />);

    fireEvent.change(screen.getByLabelText("New password"), {
      target: {
        value: "new-password-value"
      }
    });
    fireEvent.submit(screen.getByRole("button", { name: "Update password" }).closest("form")!);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "This reset link is invalid or expired. (invalid_or_expired_reset_token)"
    );
    expect(screen.getByLabelText("New password")).not.toHaveAttribute("aria-invalid");
    expect(screen.getByLabelText("New password")).toHaveValue("new-password-value");
    expect(screen.getByRole("button", { name: "Update password" })).toBeEnabled();
  });

  it("does not expose bootstrap token login in the normal sign-in UI", async () => {
    render(<AuthLogin nextPath="/" />);

    expect(screen.queryByLabelText("Access token")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Bootstrap token" })).not.toBeInTheDocument();
  });
});
