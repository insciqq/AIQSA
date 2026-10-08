import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthLogin } from "./AuthLogin";

describe("AuthLogin with LDAP", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the sign-in form for the directory while local passwords are off", () => {
    render(
      <AuthLogin
        directorySignIn={{ loginUsesUsername: true }}
        nextPath="/"
        oauthProviders={["google"]}
        passwordLoginEnabled={false}
      />
    );

    expect(screen.queryByTestId("password-sign-in-off")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Username or email")).toHaveAttribute("type", "text");
    expect(screen.getByLabelText("Username or email")).toHaveAttribute("autocomplete", "username");
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Continue with Google" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset password" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Request access" })).not.toBeInTheDocument();
  });

  it("keeps the email field when the directory searches by email", () => {
    render(<AuthLogin directorySignIn={{ loginUsesUsername: false }} nextPath="/" />);

    expect(screen.getByLabelText("Email")).toHaveAttribute("type", "email");
  });

  it("posts a directory username and opens the second step when the server asks for it", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ status: "second_factor_required" }));
    render(<AuthLogin directorySignIn={{ loginUsesUsername: true }} nextPath="/" passwordLoginEnabled={false} />);

    fireEvent.change(screen.getByLabelText("Username or email"), { target: { value: "jdoe" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct horse" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Two-factor verification" })).toBeInTheDocument());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/auth/login");
    expect(JSON.parse(String(init?.body))).toEqual({ email: "jdoe", password: "correct horse" });
  });

  it("names an unreachable directory", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ error: "ldap_unavailable" }, { status: 503 }));
    render(<AuthLogin directorySignIn={{ loginUsesUsername: true }} nextPath="/" />);

    fireEvent.change(screen.getByLabelText("Username or email"), { target: { value: "jdoe" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct horse" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("The directory could not be reached. Try again later. (ldap_unavailable)")).toBeInTheDocument();
  });
});
