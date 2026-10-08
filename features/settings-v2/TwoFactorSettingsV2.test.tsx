import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TwoFactorSettingsV2 } from "./TwoFactorSettingsV2";

const accountApi = vi.hoisted(() => ({
  confirmTwoFactorSetup: vi.fn(),
  disableTwoFactor: vi.fn(),
  loadTwoFactorStatus: vi.fn(),
  regenerateRecoveryCodes: vi.fn(),
  startTwoFactorSetup: vi.fn()
}));

vi.mock("@/components/app-shell/accountApi", () => accountApi);

const codes = Array.from({ length: 10 }, (_, index) => `ABCD${index}-EFGH${index}`);
const off = { available: true, enabled: false, recoveryCodesRemaining: 0 };
const on = { available: true, enabled: true, recoveryCodesRemaining: 10 };
const setup = {
  otpauthUri: "otpauth://totp/AIQSA:ada%40example.test?algorithm=SHA1&digits=6&issuer=AIQSA&period=30&secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
  secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"
};

describe("TwoFactorSettingsV2", () => {
  beforeEach(() => {
    for (const mock of Object.values(accountApi)) mock.mockReset();
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => undefined) } });
  });

  it("tells accounts that only use an identity provider where their two-factor lives", async () => {
    accountApi.loadTwoFactorStatus.mockResolvedValue({ available: false, enabled: false, recoveryCodesRemaining: 0 });
    render(<TwoFactorSettingsV2 />);

    const row = await screen.findByTestId("settings-two-factor");
    expect(row).toHaveTextContent("identity provider, which handles two-factor authentication");
    expect(within(row).queryByRole("button")).not.toBeInTheDocument();
  });

  it("turns on with a QR code or key, a confirming code, and recovery codes shown once", async () => {
    accountApi.loadTwoFactorStatus.mockResolvedValue(off);
    accountApi.startTwoFactorSetup.mockResolvedValue(setup);
    accountApi.confirmTwoFactorSetup
      .mockRejectedValueOnce(new Error("invalid_code"))
      .mockResolvedValueOnce({ recoveryCodes: codes, status: on });
    const createObjectURL = vi.fn(() => "blob:codes");
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    render(<TwoFactorSettingsV2 />);

    fireEvent.click(await screen.findByRole("button", { name: "Turn on…" }));
    const form = await screen.findByTestId("settings-two-factor-setup");
    const qr = within(form).getByRole("img", { name: "QR code for your authenticator app" });
    expect(qr.querySelector("path")?.getAttribute("d")).toMatch(/^M\d+,\d+h1v1h-1z/u);
    expect(within(form).getByTestId("settings-two-factor-key")).toHaveTextContent("JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP");
    fireEvent.click(within(form).getByRole("button", { name: "Copy key" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(setup.secret);
    expect(await within(form).findByRole("button", { name: "Copied" })).toBeInTheDocument();

    const code = within(form).getByLabelText("Code from the app");
    expect(code).toHaveAttribute("autocomplete", "one-time-code");
    expect(code).toHaveAttribute("inputmode", "numeric");
    fireEvent.change(code, { target: { value: "000000" } });
    fireEvent.submit(form);
    expect(await within(form).findByRole("alert")).toHaveTextContent("That code did not work");

    fireEvent.change(code, { target: { value: "123456" } });
    fireEvent.submit(form);
    const shown = await screen.findByTestId("settings-two-factor-codes");
    expect(accountApi.confirmTwoFactorSetup).toHaveBeenLastCalledWith("123456");
    expect(within(shown).getAllByRole("listitem").map((item) => item.textContent)).toEqual(codes);
    expect(screen.getByTestId("settings-two-factor")).toHaveTextContent("On. Sign-in asks for a code from your authenticator app. 10 of 10 recovery codes left.");

    fireEvent.click(within(shown).getByRole("button", { name: "Copy codes" }));
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(expect.stringContaining(codes.join("\n")));
    fireEvent.click(within(shown).getByRole("button", { name: "Download .txt" }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);

    fireEvent.click(within(shown).getByRole("button", { name: "I saved them" }));
    expect(screen.queryByTestId("settings-two-factor-codes")).not.toBeInTheDocument();
    expect(screen.queryByText(codes[0]!)).not.toBeInTheDocument();
  });

  it("asks for a current code, or a recovery code, before new recovery codes", async () => {
    accountApi.loadTwoFactorStatus.mockResolvedValue(on);
    accountApi.regenerateRecoveryCodes
      .mockRejectedValueOnce(new Error("invalid_code"))
      .mockResolvedValueOnce({ recoveryCodes: codes, status: on });
    render(<TwoFactorSettingsV2 />);

    fireEvent.click(await screen.findByRole("button", { name: "New recovery codes…" }));
    const form = screen.getByTestId("settings-two-factor-proof");
    const field = within(form).getByLabelText("Current code from your authenticator app");
    expect(field).toHaveFocus();
    fireEvent.change(field, { target: { value: "000000" } });
    fireEvent.submit(form);
    expect(await within(form).findByRole("alert")).toHaveTextContent("(invalid_code)");
    expect(accountApi.regenerateRecoveryCodes).toHaveBeenLastCalledWith({ code: "000000" });

    fireEvent.click(within(form).getByRole("button", { name: "Use a recovery code" }));
    const recovery = within(form).getByLabelText("Recovery code");
    fireEvent.change(recovery, { target: { value: "ABCD0-EFGH0" } });
    fireEvent.submit(form);
    expect(await screen.findByTestId("settings-two-factor-codes")).toBeInTheDocument();
    expect(accountApi.regenerateRecoveryCodes).toHaveBeenLastCalledWith({ recoveryCode: "ABCD0-EFGH0" });
  });

  it("turns off with a current code", async () => {
    accountApi.loadTwoFactorStatus.mockResolvedValue({ ...on, recoveryCodesRemaining: 4 });
    accountApi.disableTwoFactor.mockResolvedValue(off);
    render(<TwoFactorSettingsV2 />);

    expect(await screen.findByTestId("settings-two-factor")).toHaveTextContent("4 of 10 recovery codes left.");
    fireEvent.click(screen.getByRole("button", { name: "Turn off…" }));
    const form = screen.getByTestId("settings-two-factor-proof");
    fireEvent.change(within(form).getByLabelText("Current code from your authenticator app"), { target: { value: "123456" } });
    fireEvent.click(within(form).getByRole("button", { name: "Turn off" }));

    await waitFor(() => expect(screen.getByTestId("settings-two-factor")).toHaveTextContent("Off."));
    expect(accountApi.disableTwoFactor).toHaveBeenCalledWith({ code: "123456" });
    expect(screen.getByRole("button", { name: "Turn on…" })).toBeInTheDocument();
  });

  it("explains a server without a usable encryption key", async () => {
    accountApi.loadTwoFactorStatus.mockResolvedValue(off);
    accountApi.startTwoFactorSetup.mockRejectedValue(new Error("two_factor_unavailable"));
    render(<TwoFactorSettingsV2 />);

    fireEvent.click(await screen.findByRole("button", { name: "Turn on…" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Two-factor sign-in is unavailable on this server. Contact the operator. (two_factor_unavailable)"
    );
  });
});
