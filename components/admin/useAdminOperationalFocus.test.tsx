import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { focusAdminElement, useAdminOperationalFocus } from "./useAdminOperationalFocus";

afterEach(() => {
  vi.restoreAllMocks();
});

function createFocusableElement() {
  const element = document.createElement("div");
  element.tabIndex = -1;
  document.body.append(element);
  return element;
}

describe("focusAdminElement", () => {
  it("scrolls and focuses a connected operational detail", () => {
    const element = createFocusableElement();
    const scrollIntoView = vi.fn();
    element.scrollIntoView = scrollIntoView;

    focusAdminElement(element);

    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    expect(document.activeElement).toBe(element);
    element.remove();
  });
});

describe("useAdminOperationalFocus", () => {
  it("focuses the requested target after selection reconciliation", () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    const { result } = renderHook(() => useAdminOperationalFocus());
    const detail = createFocusableElement();
    result.current.focus.users.detail.current = detail;

    act(() => result.current.requestFocus("user-detail"));

    expect(document.activeElement).toBe(detail);
    detail.remove();
  });

  it("honors repeated requests for an already-selected record", () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    const { result } = renderHook(() => useAdminOperationalFocus());
    const detail = createFocusableElement();
    const focus = vi.spyOn(detail, "focus");
    result.current.focus.groups.detail.current = detail;

    act(() => result.current.requestFocus("group-detail"));
    act(() => result.current.requestFocus("group-detail"));

    expect(focus).toHaveBeenCalledTimes(2);
    detail.remove();
  });
});
