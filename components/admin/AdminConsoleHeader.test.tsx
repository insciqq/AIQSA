import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AdminConsoleHeader } from "./AdminConsoleHeader";

describe("AdminConsoleHeader", () => {
  it("reports resource state and exposes refresh without owning it", () => {
    const onRefresh = vi.fn();
    const view = render(
      <AdminConsoleHeader
        adminEmail="admin@example.com"
        lastLoadedAt={null}
        loading
        onRefresh={onRefresh}
        submitting={false}
      />
    );

    expect(screen.getByText(/refreshing admin data/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh admin overview" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "Return to workspace" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("banner")).toHaveClass(
      "sm:[@media(max-height:32rem)]:!flex-row",
      "sm:[@media(max-height:32rem)]:!py-2"
    );
    expect(screen.getByText("Admin console").parentElement).toHaveClass(
      "sm:[@media(max-height:32rem)]:!hidden"
    );

    view.rerender(
      <AdminConsoleHeader
        adminEmail="admin@example.com"
        lastLoadedAt={new Date("2026-07-12T08:00:00.000Z")}
        loading={false}
        onRefresh={onRefresh}
        submitting
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh admin overview" }));

    expect(screen.getByText(/saving admin changes/i)).toBeInTheDocument();
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(onRefresh).toHaveBeenCalledWith();
  });
});
