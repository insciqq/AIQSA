import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthLogin } from "./AuthLogin";

describe("AuthLogin with OIDC", () => {
  afterEach(() => {
    window.history.replaceState({}, "", "/");
    vi.restoreAllMocks();
  });

  it("offers the OIDC button with the administrator's label and the next path", () => {
    render(<AuthLogin nextPath="/projects?tab=a" oauthProviders={["google", "oidc"]} oidcButtonLabel="Company SSO" />);

    const link = screen.getByRole("link", { name: "Continue with Company SSO" });
    expect(link).toHaveAttribute("href", "/api/auth/oauth/oidc?next=%2Fprojects%3Ftab%3Da");
    expect(link).toHaveTextContent(/^CContinue with Company SSO$/u);
    expect(screen.getByRole("link", { name: "Continue with Google" })).toBeInTheDocument();
  });

  it("keeps the OIDC button while password sign-in is off", () => {
    render(<AuthLogin nextPath="/" oauthProviders={["oidc"]} oidcButtonLabel="Keycloak" passwordLoginEnabled={false} />);

    expect(screen.getByTestId("password-sign-in-off")).toHaveTextContent("Use one of these methods.");
    expect(screen.getByRole("link", { name: "Continue with Keycloak" })).toHaveAttribute("href", "/api/auth/oauth/oidc?next=%2F");
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
  });

  it.each([
    ["source_changed", "This Company SSO account was linked through a previous sign-in configuration. Ask an administrator to unlink it, then sign in again. (oauth_source_changed)"],
    ["email_missing", "Company SSO did not share an email address for this account. Ask an administrator to check the identity provider's email claim. (oauth_email_missing)"],
    ["not_allowed", "This Company SSO account is not allowed to access AIQSA. (oauth_not_allowed)"],
    ["failed", "Company SSO sign-in could not be completed. Try again or use email and password. (oauth_failed)"]
  ] as const)("explains the %s outcome with the OIDC label", (outcome, message) => {
    render(
      <AuthLogin
        nextPath="/"
        oauthOutcome={outcome}
        oauthProvider="oidc"
        oauthProviders={["oidc"]}
        oidcButtonLabel="Company SSO"
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent(message);
  });

  it("falls back to SSO when no label reached the page", () => {
    render(<AuthLogin nextPath="/" oauthOutcome="email_missing" oauthProvider="oidc" />);
    expect(screen.getByRole("alert")).toHaveTextContent(/^SSO did not share an email address/u);
  });
});
