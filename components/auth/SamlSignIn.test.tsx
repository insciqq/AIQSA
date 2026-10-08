import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AuthLogin } from "./AuthLogin";

describe("AuthLogin with SAML", () => {
  afterEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("offers the configured SAML label after the primary action, keeping a safe destination", () => {
    const { rerender } = render(<AuthLogin nextPath="/admin?tab=users" samlSignIn={{ buttonLabel: "Acme SSO" }} />);

    const saml = screen.getByRole("link", { name: "Continue with Acme SSO" });
    expect(saml).toHaveAttribute("href", "/api/auth/saml/start?next=%2Fadmin%3Ftab%3Dusers");
    expect(screen.getByText("or")).toBeInTheDocument();
    expect(saml.parentElement).not.toHaveClass("sm:grid-cols-2");
    expect(
      screen.getByRole("button", { name: "Sign in" }).compareDocumentPosition(saml) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    rerender(<AuthLogin nextPath="https://evil.example/steal" oauthProviders={["google"]} samlSignIn={{ buttonLabel: "SAML" }} />);
    const pair = screen.getByRole("link", { name: "Continue with SAML" });
    expect(pair).toHaveAttribute("href", "/api/auth/saml/start?next=%2F");
    expect(pair.parentElement).toHaveClass("sm:grid-cols-2");
  });

  it("keeps SAML among the remaining methods while password sign-in is off", () => {
    render(<AuthLogin nextPath="/chats" passwordLoginEnabled={false} samlSignIn={{ buttonLabel: "SAML" }} />);

    expect(screen.getByTestId("password-sign-in-off")).toHaveTextContent("Use one of these methods.");
    expect(screen.getByRole("link", { name: "Continue with SAML" })).toHaveAttribute("href", "/api/auth/saml/start?next=%2Fchats");
  });

  it("explains a SAML outcome without naming account details", () => {
    const { unmount } = render(<AuthLogin nextPath="/" samlOutcome="pending" samlSignIn={{ buttonLabel: "Acme SSO" }} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Acme SSO confirmed your account. AIQSA access is pending administrator approval."
    );
    unmount();

    render(<AuthLogin nextPath="/" samlOutcome="account_conflict" />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "SAML could not be linked to an existing AIQSA account. Sign in another way or contact the operator. (saml_account_conflict)"
    );
    expect(screen.queryByRole("link", { name: /Continue with/ })).not.toBeInTheDocument();
  });

  it("does not render SAML when the method is off", () => {
    render(<AuthLogin nextPath="/" oauthProviders={["google"]} />);

    expect(screen.queryByTestId("saml-sign-in")).not.toBeInTheDocument();
  });
});
