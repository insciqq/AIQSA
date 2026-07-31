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

  it("shows a quiet expandable release indicator only when a newer release exists", () => {
    const { rerender } = render(
      <AdminConsoleHeader
        adminEmail="admin@example.com"
        lastLoadedAt={new Date("2026-07-31T13:00:00.000Z")}
        loading={false}
        onRefresh={() => undefined}
        releaseStatus={{
          checkedAt: "2026-07-31T13:00:00.000Z",
          currentVersion: "0.1.12",
          latestVersion: "0.1.12",
          publishedAt: "2026-07-30T12:00:00.000Z",
          releaseUrl: "https://github.com/insciqq/AIQSA/releases/tag/v0.1.12",
          state: "current"
        }}
        submitting={false}
      />
    );

    expect(screen.getByText("v0.1.12")).toBeVisible();
    expect(screen.queryByText(/Update available/)).not.toBeInTheDocument();

    rerender(
      <AdminConsoleHeader
        adminEmail="admin@example.com"
        lastLoadedAt={new Date("2026-07-31T13:00:00.000Z")}
        loading={false}
        onRefresh={() => undefined}
        releaseStatus={{
          checkedAt: "2026-07-31T13:00:00.000Z",
          currentVersion: "0.1.12",
          latestVersion: "0.2.0",
          publishedAt: "2026-07-31T12:00:00.000Z",
          releaseUrl: "https://github.com/insciqq/AIQSA/releases/tag/v0.2.0",
          state: "update_available"
        }}
        submitting={false}
      />
    );

    const trigger = screen.getByText("Update available · v0.2.0").closest("summary");
    expect(trigger).not.toBeNull();
    fireEvent.click(trigger!);

    const details = screen.getByTestId("admin-release-update-details");
    expect(details).toBeVisible();
    expect(details).toHaveTextContent("Installedv0.1.12");
    expect(details).toHaveTextContent("Latestv0.2.0");
    expect(details).toHaveTextContent("PublishedJul 31, 2026");
    expect(screen.getByRole("link", { name: /View release notes/i })).toHaveAttribute(
      "href",
      "https://github.com/insciqq/AIQSA/releases/tag/v0.2.0"
    );
  });
});
