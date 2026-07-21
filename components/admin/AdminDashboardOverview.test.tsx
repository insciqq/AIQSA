import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AdminDashboardOverview as AdminDashboardOverviewModel } from "./adminDashboardView";
import { AdminDashboardOverview } from "./AdminDashboardOverview";

const emptyOverview: AdminDashboardOverviewModel = {
  acceptedInvites: 0,
  accessRules: 0,
  activeGroups: 0,
  activeUsers: 0,
  grantableModels: 0,
  grantableSearch: 0,
  hasAttention: false,
  inactiveUsers: 0,
  noAccessUsers: [],
  openInvites: [],
  pendingUsers: [],
  revokedInvites: 0,
  soonExpiringInvites: [],
  totalGroups: 0,
  totalInvites: 0,
  totalUsers: 0
};

describe("AdminDashboardOverview", () => {
  it("renders an empty canonical overview without action controls", () => {
    render(<AdminDashboardOverview onSelectSection={vi.fn()} overview={emptyOverview} />);

    expect(screen.getByRole("region", { name: "Admin summary" })).toBeInTheDocument();
    expect(screen.getByText(/no current .* need attention/i)).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Needs attention" })).queryByRole("button")).not.toBeInTheDocument();
  });

  it("routes attention actions through section navigation", () => {
    const onSelectSection = vi.fn();
    render(
      <AdminDashboardOverview
        onSelectSection={onSelectSection}
        overview={{
          ...emptyOverview,
          hasAttention: true,
          pendingUsers: [
            {
              displayName: "Pending",
              effectiveEntitlements: { models: [], providers: [], searchStrategies: [] },
              email: "pending@example.com",
              groups: [],
              hasVerifiedIdentity: true,
              id: "pending",
              lastSessionAt: null,
              role: "user",
              status: "pending"
            }
          ]
        }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /pending approval/i }));
    expect(onSelectSection).toHaveBeenCalledWith("users");
  });
});
