import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminFeedbackHost } from "./AdminFeedbackHost";

describe("AdminFeedbackHost", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("announces a notice that dismisses itself and an error that stays until closed", () => {
    const clearError = vi.fn();
    const clearNotice = vi.fn();
    render(
      <AdminFeedbackHost feedback={{ clearError, clearNotice, error: "Group could not be saved.", notice: "Group created." }} />
    );

    expect(screen.getByRole("status")).toHaveTextContent("Group created.");
    expect(screen.getByRole("alert")).toHaveTextContent("Group could not be saved.");

    act(() => {
      vi.advanceTimersByTime(6_000);
    });
    expect(clearNotice).toHaveBeenCalledTimes(1);
    expect(clearError).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
    expect(clearError).toHaveBeenCalledTimes(1);
  });

  it("renders nothing without feedback", () => {
    render(<AdminFeedbackHost feedback={{ clearError: vi.fn(), clearNotice: vi.fn(), error: null, notice: null }} />);
    expect(screen.queryByTestId("admin-feedback")).not.toBeInTheDocument();
  });

  it("offers the notice action, runs it once, and then clears the notice", () => {
    const clearNotice = vi.fn();
    const onSelect = vi.fn();
    render(
      <AdminFeedbackHost
        feedback={{
          clearError: vi.fn(),
          clearNotice,
          error: null,
          notice: "Saved for future work",
          noticeAction: { label: "Undo", onSelect }
        }}
      />
    );

    act(() => {
      vi.advanceTimersByTime(6_000);
    });
    expect(clearNotice).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(clearNotice).toHaveBeenCalledTimes(1);
  });
});
