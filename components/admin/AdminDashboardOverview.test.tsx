import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AdminDashboardOverview as AdminDashboardOverviewModel } from "./adminDashboardView";
import { AdminDashboardOverview } from "./AdminDashboardOverview";

const emptyOverview: AdminDashboardOverviewModel = {
  acceptedInvites: 0,
  accessRules: 0,
  activeGroups: 0,
  activeUsers: 0,
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

    const summary = screen.getByRole("region", { name: "Admin summary" });
    expect(summary).toHaveClass(
      "[@media(max-height:32rem)]:!grid-flow-col",
      "[@media(max-height:32rem)]:!overflow-x-auto"
    );
    expect(summary).toHaveTextContent("Exact email and domain approval rules");
    expect(summary).not.toHaveTextContent(/models.*search strategies/i);
    expect(screen.queryByRole("region", { name: "Needs attention" })).not.toBeInTheDocument();
    expect(screen.queryByText(/no current .* need attention/i)).not.toBeInTheDocument();
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

    expect(screen.getByRole("region", { name: "Needs attention" })).toHaveClass(
      "[@media(max-height:32rem)]:!grid-flow-col",
      "[@media(max-height:32rem)]:!overflow-x-auto"
    );
    fireEvent.click(screen.getByRole("button", { name: /pending approval/i }));
    expect(onSelectSection).toHaveBeenCalledWith("users");
  });
});
