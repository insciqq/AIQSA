import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("presents a restrained, labeled sign-in workspace with autofill-safe field contracts", () => {
    render(<AuthLogin nextPath="/" />);

    expect(screen.getByText("AIQSA")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByText("Use the email and password for your active account.")).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveAttribute("autocomplete", "email");
    expect(screen.getByLabelText("Email")).toHaveAttribute("inputmode", "email");
    expect(screen.getByLabelText("Password")).toHaveAttribute("autocomplete", "current-password");
    expect(screen.getByLabelText("Password")).toHaveAccessibleDescription("Case-sensitive");
    expect(screen.getByRole("button", { name: "Show password" })).toHaveAttribute("aria-controls", "password");
    expect(screen.getByLabelText("Email")).toHaveFocus();
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
    expect(screen.getByText("or use email")).toBeInTheDocument();
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

  it("keeps OAuth choices out of proof-bearing invite and reset modes", () => {
    const { rerender } = render(
      <AuthLogin inviteToken="invite-token" nextPath="/" oauthProviders={["google", "yandex"]} />
    );

    expect(screen.queryByRole("link", { name: /Continue with/ })).not.toBeInTheDocument();

    rerender(<AuthLogin nextPath="/" oauthProviders={["google", "yandex"]} resetToken="reset-token" />);
    expect(screen.queryByRole("link", { name: /Continue with/ })).not.toBeInTheDocument();
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

    fireEvent.submit(screen.getByRole("button", { name: "Sign in" }).closest("form")!);

    expect(await screen.findByRole("alert")).toHaveTextContent("Enter email and password. (credentials_required)");
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
    expect(screen.getByText("Signing in…", { selector: "p" })).toHaveAttribute("role", "status");
    expect(screen.getByRole("button", { name: "Signing in…" }).closest("form")).toHaveAttribute("aria-busy", "true");

    await act(async () => {
      resolveFetch(
        new Response(JSON.stringify({ ok: true }), {
          status: 200
        })
      );
    });
    await waitFor(() => expect(navigateAfterLogin).toHaveBeenCalledWith("/"));
  });

  it("sanitizes unsafe post-login redirect targets at navigation time", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
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
      new Response(JSON.stringify({ ok: true }), {
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

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This invite link is invalid or expired. (invalid_invite_token)"
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

    expect(await screen.findByRole("heading", { level: 1, name: "Request received" })).toHaveFocus();
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

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This email or domain is not allowed to request access. (registration_not_allowed)"
    );
    expect(screen.queryByText("Use the verification link we sent before signing in.")).not.toBeInTheDocument();
  });

  it("shows SMTP configuration failures without entering the check-email state", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "verification_email_unavailable" }), {
        status: 503
      })
    );
    render(<AuthLogin nextPath="/" />);

    fireEvent.click(screen.getByRole("button", { name: "Request access" }));
    fireEvent.change(screen.getByLabelText("Email"), {
      target: {
        value: "person@example.com"
      }
    });
    fireEvent.submit(screen.getByRole("button", { name: "Request access" }).closest("form")!);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Verification email is not configured on this server. Ask the operator to configure SMTP. (verification_email_unavailable)"
    );
    expect(screen.queryByText("Use the verification link we sent before signing in.")).not.toBeInTheDocument();
  });

  it("keeps a retryable registration form visible after an SMTP send failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "verification_email_failed" }), {
        status: 502
      })
    );
    render(<AuthLogin nextPath="/" />);

    fireEvent.click(screen.getByRole("button", { name: "Request access" }));
    fireEvent.change(screen.getByLabelText("Email"), {
      target: {
        value: "person@example.com"
      }
    });
    fireEvent.submit(screen.getByRole("button", { name: "Request access" }).closest("form")!);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The server could not send the verification email. Ask the operator to check SMTP delivery. (verification_email_failed)"
    );
    expect(screen.getByLabelText("Email")).toHaveValue("person@example.com");
    expect(screen.getByRole("button", { name: "Request access" })).toBeEnabled();
    expect(screen.queryByRole("heading", { level: 1, name: "Request received" })).not.toBeInTheDocument();
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
    render(<AuthLogin nextPath="/admin" verifyToken="verify-token" />);

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
    expect(screen.getByRole("heading", { level: 1, name: "Sign in" })).toBeInTheDocument();
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

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This verification link is invalid or expired. (invalid_or_expired_verification_token)"
    );
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
    expect(screen.getByRole("heading", { level: 1, name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveFocus();
    expect(window.location.search).toBe("?next=%2Fsettings");
  });

  it("scrubs proof parameters when explicitly leaving a token mode", () => {
    window.history.replaceState(
      {},
      "",
      "/login?verify=verify-token&reset=reset-token&invite=invite-token&next=%2Fadmin"
    );
    render(<AuthLogin nextPath="/admin" verifyToken="verify-token" />);

    fireEvent.click(screen.getByRole("button", { name: "Back to sign in" }));

    expect(screen.getByRole("heading", { level: 1, name: "Sign in" })).toBeInTheDocument();
    expect(window.location.search).toBe("?next=%2Fadmin");
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

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This reset link is invalid or expired. (invalid_or_expired_reset_token)"
    );
    expect(screen.getByLabelText("New password")).toHaveValue("new-password-value");
    expect(screen.getByRole("button", { name: "Update password" })).toBeEnabled();
  });

  it("does not expose bootstrap token login in the normal sign-in UI", async () => {
    render(<AuthLogin nextPath="/" />);

    expect(screen.queryByLabelText("Access token")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Bootstrap token" })).not.toBeInTheDocument();
  });
});
