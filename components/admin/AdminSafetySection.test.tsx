import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AdminSafetySection } from "./AdminSafetySection";

describe("AdminSafetySection", () => {
  it("renders the safety guidance and delegates the global session reset request", () => {
    const onRequestRevokeAllSessions = vi.fn();

    render(
      <AdminSafetySection
        actionsDisabled={false}
        currentAdminEmail="admin@example.com"
        lastRefreshedText="10:42:00"
        onRequestRevokeAllSessions={onRequestRevokeAllSessions}
      />
    );

    const heading = screen.getByRole("heading", { level: 3, name: "Global session reset" });
    expect(heading.closest("section")).toHaveClass("border-critical");
    expect(screen.getByText("Installation-wide action")).toBeVisible();
    expect(
      screen.getByText(/revokes every active session, including yours/i)
    ).toBeInTheDocument();
    expect(screen.getByText("Every active AIQSA session")).toBeVisible();
    expect(screen.getByText("Your current administrator session")).toBeVisible();
    expect(screen.getByText("Everyone must sign in again")).toBeVisible();

    const currentAdmin = screen.getByRole("complementary");
    expect(within(currentAdmin).getByText("Current admin")).toBeInTheDocument();
    expect(within(currentAdmin).getByText("admin@example.com")).toBeInTheDocument();
    expect(within(currentAdmin).getByText("Last refreshed 10:42:00")).toBeInTheDocument();

    const revokeButton = screen.getByRole("button", { name: "Revoke all sessions" });
    expect(revokeButton).toHaveAttribute("type", "button");
    expect(revokeButton).toHaveClass("text-critical");
    expect(screen.getByText("A final confirmation names the consequence before this runs.")).toBeVisible();

    fireEvent.click(revokeButton);

    expect(onRequestRevokeAllSessions).toHaveBeenCalledTimes(1);
  });

  it("disables the global session reset while another action is pending", () => {
    const onRequestRevokeAllSessions = vi.fn();

    render(
      <AdminSafetySection
        actionsDisabled
        currentAdminEmail="admin@example.com"
        lastRefreshedText="Never"
        onRequestRevokeAllSessions={onRequestRevokeAllSessions}
      />
    );

    const revokeButton = screen.getByRole("button", { name: "Revoke all sessions" });
    expect(revokeButton).toBeDisabled();
    expect(screen.getByText("Unavailable while another administrator action finishes.")).toBeVisible();

    fireEvent.click(revokeButton);

    expect(onRequestRevokeAllSessions).not.toHaveBeenCalled();
  });
});
