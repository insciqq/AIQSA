import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAdminFeedback } from "./useAdminFeedback";

describe("useAdminFeedback", () => {
  it("keeps notices and errors independent and clears only the expected error", () => {
    const { result } = renderHook(() => useAdminFeedback());

    act(() => {
      result.current.reportNotice("Saved.");
      result.current.reportError("Could not refresh.");
    });
    expect(result.current.notice).toBe("Saved.");
    expect(result.current.error).toBe("Could not refresh.");

    act(() => result.current.clearErrorIf("A different error."));
    expect(result.current.error).toBe("Could not refresh.");

    act(() => result.current.clearErrorIf("Could not refresh."));
    expect(result.current.error).toBeNull();
    expect(result.current.notice).toBe("Saved.");

    act(() => result.current.reportError("Try again."));
    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
    expect(result.current.notice).toBe("Saved.");

    act(() => result.current.clearAll());
    expect(result.current).toMatchObject({
      error: null,
      notice: null
    });
  });

  it("carries one optional action with a notice and drops it with the notice", () => {
    const onSelect = vi.fn();
    const { result } = renderHook(() => useAdminFeedback());

    act(() => result.current.reportNotice("Saved for future work", { label: "Undo", onSelect }));
    expect(result.current.notice).toBe("Saved for future work");
    expect(result.current.noticeAction?.label).toBe("Undo");

    act(() => result.current.reportNotice("Plain notice"));
    expect(result.current.noticeAction).toBeNull();

    act(() => result.current.reportNotice("Again", { label: "Undo", onSelect }));
    act(() => result.current.clearNotice());
    expect(result.current.notice).toBeNull();
    expect(result.current.noticeAction).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
