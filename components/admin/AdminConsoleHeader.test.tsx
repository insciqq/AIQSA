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

    expect(screen.getByRole("heading", { name: "Control Center" })).toBeInTheDocument();
    expect(screen.getByText("admin@example.com")).toBeInTheDocument();
    expect(screen.getByText("Refreshing…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh Control Center dashboard" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "Return to chat" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("banner")).toHaveClass(
      "bg-answer-paper",
      "border-trace-subtle",
      "sm:[@media(max-height:32rem)]:!flex-row",
      "sm:[@media(max-height:32rem)]:!py-2"
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
    fireEvent.click(screen.getByRole("button", { name: "Refresh Control Center dashboard" }));

    expect(screen.getByText("Saving changes…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh Control Center dashboard" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refresh Control Center dashboard" })).toHaveTextContent(
      "Refresh dashboard"
    );
    expect(screen.getByRole("link", { name: "Return to chat" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("link", { name: "Return to chat" })).toHaveClass(
      "cursor-not-allowed",
      "text-ink-disabled",
      "opacity-60"
    );
    expect(onRefresh).not.toHaveBeenCalled();

    view.rerender(
      <AdminConsoleHeader
        adminEmail="admin@example.com"
        lastLoadedAt={new Date("2026-07-12T08:00:00.000Z")}
        loading={false}
        onRefresh={onRefresh}
        submitting={false}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh Control Center dashboard" }));

    expect(onRefresh).toHaveBeenCalledOnce();
    expect(onRefresh).toHaveBeenCalledWith();
  });
});
