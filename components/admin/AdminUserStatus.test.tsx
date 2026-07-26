import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AdminUserStatus } from "./AdminUserStatus";

describe("AdminUserStatus", () => {
  it("uses the shared availability treatment for active and disabled accounts", () => {
    render(
      <div>
        <AdminUserStatus status="active" />
        <AdminUserStatus status="disabled" />
      </div>
    );

    expect(screen.getByText("Active")).toHaveAttribute("data-resource-availability", "enabled");
    expect(screen.getByText("Disabled")).toHaveAttribute("data-resource-availability", "disabled");
  });

  it("keeps pending and denied in their own lifecycle domain", () => {
    render(
      <div>
        <AdminUserStatus status="pending" />
        <AdminUserStatus status="denied" />
      </div>
    );

    expect(screen.getByText("pending").closest("span[data-user-status]"))
      .toHaveAttribute("data-user-status", "pending");
    expect(screen.getByText("denied").closest("span[data-user-status]"))
      .toHaveAttribute("data-user-status", "denied");
  });
});
