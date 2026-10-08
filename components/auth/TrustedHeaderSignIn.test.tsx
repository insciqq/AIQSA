import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AuthLogin } from "./AuthLogin";

describe("trusted-header sign-in on the login page", () => {
  it("offers the proxy sign-in beside the password form after ?local=1", () => {
    render(<AuthLogin nextPath="/c/chat-1" trustedHeader={{}} />);

    expect(screen.getByRole("link", { name: "Continue with your proxy sign-in" }))
      .toHaveAttribute("href", "/api/auth/trusted-header?next=%2Fc%2Fchat-1");
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("says the proxy provided no identity when the header was missing", () => {
    render(<AuthLogin nextPath="/" trustedHeader={{ outcome: "missing" }} />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "The proxy in front of AIQSA did not provide an identity. Sign in at the proxy, or use another method. (trusted_header_missing)"
    );
    expect(screen.getByRole("link", { name: "Continue with your proxy sign-in" })).toHaveAttribute("href", "/api/auth/trusted-header");
  });

  it("shows a pending account as a notice, not an error", () => {
    render(<AuthLogin nextPath="/" trustedHeader={{ outcome: "pending" }} />);

    expect(screen.getByRole("status")).toHaveTextContent("AIQSA access is pending administrator approval.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("stays reachable while password sign-in is off", () => {
    render(<AuthLogin nextPath="/" passwordLoginEnabled={false} trustedHeader={{ outcome: "not_allowed" }} />);

    expect(screen.getByTestId("password-sign-in-off")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("(trusted_header_not_allowed)");
    expect(screen.getByRole("link", { name: "Continue with your proxy sign-in" })).toBeInTheDocument();
  });

  it("is absent while the method cannot sign anyone in", () => {
    render(<AuthLogin nextPath="/" />);

    expect(screen.queryByTestId("trusted-header-sign-in")).not.toBeInTheDocument();
  });
});
