import { act, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAdminFieldErrors } from "./useAdminFieldErrors";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useAdminFieldErrors", () => {
  it("reports, focuses, and clears only the matching field error", () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    const input = document.createElement("input");
    input.id = "group-name";
    document.body.append(input);
    const feedback = {
      clearErrorIf: vi.fn(),
      reportError: vi.fn()
    };
    const { result } = renderHook(() => useAdminFieldErrors(feedback), { wrapper: StrictMode });

    act(() => result.current.reportFieldError("group-name", "group_required"));

    expect(result.current.fieldError).toEqual({
      field: "group-name",
      message: "Enter a group name."
    });
    expect(feedback.reportError).toHaveBeenCalledWith("Enter a group name.");
    expect(document.activeElement).toBe(input);

    act(() => result.current.clearFieldError("invite-email"));
    expect(result.current.fieldError?.field).toBe("group-name");
    expect(feedback.clearErrorIf).not.toHaveBeenCalled();

    act(() => result.current.clearFieldError("group-name"));
    expect(result.current.fieldError).toBeNull();
    expect(feedback.clearErrorIf).toHaveBeenCalledWith("Enter a group name.");
    expect(feedback.clearErrorIf).toHaveBeenCalledTimes(1);
    input.remove();
  });
});
