import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
});
