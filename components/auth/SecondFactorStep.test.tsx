import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthLogin } from "./AuthLogin";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
}

/** Signs in with a password whose account has two-factor sign-in, landing on the second step. */
async function reachSecondStep(responses: Response[], nextPath = "/") {
  const fetchMock = vi.spyOn(globalThis, "fetch");
  fetchMock.mockResolvedValueOnce(jsonResponse({ status: "second_factor_required" }));
  for (const response of responses) fetchMock.mockResolvedValueOnce(response);
  const navigateAfterLogin = vi.fn();
  render(<AuthLogin navigateAfterLogin={navigateAfterLogin} nextPath={nextPath} />);

  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.test" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct horse" } });
  fireEvent.submit(screen.getByRole("button", { name: "Sign in" }).closest("form")!);

  const code = await screen.findByLabelText("Authentication code");
  return { code, fetchMock, navigateAfterLogin };
}

describe("second-factor sign-in step", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("asks for a code instead of entering the workspace, with a phone-friendly field in focus", async () => {
    const { code, navigateAfterLogin } = await reachSecondStep([]);

    expect(navigateAfterLogin).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { level: 1, name: "Two-factor verification" })).toBeInTheDocument();
    expect(code).toHaveAttribute("autocomplete", "one-time-code");
    expect(code).toHaveAttribute("inputmode", "numeric");
    expect(code).toHaveAttribute("aria-describedby", "second-factor-code-help");
    await waitFor(() => expect(code).toHaveFocus());
    // Password-only links stay with the password step.
    expect(screen.queryByRole("button", { name: "Reset password" })).not.toBeInTheDocument();
  });

  it("sends the code and enters the requested page", async () => {
    const { code, fetchMock, navigateAfterLogin } = await reachSecondStep([jsonResponse({ user: { id: "user-1" } })], "/admin");

    fireEvent.change(code, { target: { value: "123 456" } });
    fireEvent.submit(screen.getByTestId("second-factor-form"));

    await waitFor(() => expect(navigateAfterLogin).toHaveBeenCalledWith("/admin"));
    expect(fetchMock).toHaveBeenLastCalledWith("/api/auth/second-factor", expect.objectContaining({
      body: JSON.stringify({ code: "123 456" }),
      method: "POST"
    }));
  });

  it("explains a wrong code next to the field and keeps the step", async () => {
    const { code, navigateAfterLogin } = await reachSecondStep([jsonResponse({ error: "invalid_code" }, 401)]);

    fireEvent.change(code, { target: { value: "000000" } });
    fireEvent.submit(screen.getByTestId("second-factor-form"));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("That code did not work. Use the current code from your authenticator app. (invalid_code)");
    const field = screen.getByLabelText("Authentication code");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAttribute("aria-errormessage", alert.id);
    await waitFor(() => expect(field).toHaveFocus());
    expect(navigateAfterLogin).not.toHaveBeenCalled();
  });

  it("switches to a recovery code and sends it as one", async () => {
    const { fetchMock, navigateAfterLogin } = await reachSecondStep([
      jsonResponse({ error: "invalid_code" }, 401),
      jsonResponse({ user: { id: "user-1" } })
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Use a recovery code" }));
    const recovery = screen.getByLabelText("Recovery code");
    await waitFor(() => expect(recovery).toHaveFocus());
    expect(recovery).toHaveAttribute("autocomplete", "off");
    expect(recovery).toHaveAttribute("inputmode", "text");

    fireEvent.change(recovery, { target: { value: "abcde-fghjk" } });
    fireEvent.submit(screen.getByTestId("second-factor-form"));
    expect(await screen.findByRole("alert")).toHaveTextContent("That recovery code is not valid or was already used. (invalid_code)");

    fireEvent.submit(screen.getByTestId("second-factor-form"));
    await waitFor(() => expect(navigateAfterLogin).toHaveBeenCalledWith("/"));
    expect(fetchMock).toHaveBeenLastCalledWith("/api/auth/second-factor", expect.objectContaining({
      body: JSON.stringify({ recoveryCode: "abcde-fghjk" })
    }));
  });

  it("returns to the password step when the challenge expired", async () => {
    const { code } = await reachSecondStep([jsonResponse({ error: "challenge_expired" }, 401)]);

    fireEvent.change(code, { target: { value: "123456" } });
    fireEvent.submit(screen.getByTestId("second-factor-form"));

    expect(await screen.findByRole("alert")).toHaveTextContent("This sign-in step expired. Sign in again. (challenge_expired)");
    expect(screen.getByRole("heading", { level: 1, name: "Sign in to your workspace" })).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });

  it("asks for a code before sending, and goes back on request", async () => {
    const { fetchMock } = await reachSecondStep([]);

    fireEvent.submit(screen.getByTestId("second-factor-form"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter the code. (code_required)");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Back to sign in" }));
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
  });

  it("shows rate limits and network failures readably", async () => {
    const { code } = await reachSecondStep([jsonResponse({ error: "rate_limited" }, 429)]);

    fireEvent.change(code, { target: { value: "123456" } });
    fireEvent.submit(screen.getByTestId("second-factor-form"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many attempts. Wait a bit before trying again. (rate_limited)");

    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new TypeError("offline"));
    fireEvent.submit(screen.getByTestId("second-factor-form"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("(network_error)"));
  });
});
