import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useBeforeUnloadGuard } from "./useBeforeUnloadGuard";

function Guard({ dirty, isDirty }: Readonly<{
  dirty: boolean;
  isDirty?: () => boolean;
}>) {
  useBeforeUnloadGuard(dirty, isDirty);
  return null;
}

function beforeUnload(): Event {
  return new Event("beforeunload", { cancelable: true });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useBeforeUnloadGuard", () => {
  it("owns one conditional listener across multiple dirty publishers", () => {
    const addEventListener = vi.spyOn(window, "addEventListener");
    const removeEventListener = vi.spyOn(window, "removeEventListener");
    const { rerender, unmount } = render(
      <>
        <Guard dirty={false} />
        <Guard dirty={false} />
      </>
    );
    expect(addEventListener.mock.calls.filter(([type]) => type === "beforeunload")).toHaveLength(0);

    rerender(
      <>
        <Guard dirty />
        <Guard dirty />
      </>
    );
    expect(addEventListener.mock.calls.filter(([type]) => type === "beforeunload")).toHaveLength(1);
    const blocked = beforeUnload();
    window.dispatchEvent(blocked);
    expect(blocked.defaultPrevented).toBe(true);

    rerender(
      <>
        <Guard dirty={false} />
        <Guard dirty />
      </>
    );
    const stillBlocked = beforeUnload();
    window.dispatchEvent(stillBlocked);
    expect(stillBlocked.defaultPrevented).toBe(true);

    unmount();
    expect(removeEventListener.mock.calls.filter(([type]) => type === "beforeunload")).toHaveLength(1);
    const clean = beforeUnload();
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
  });

  it("checks the live predicate before preventing a confirmed document exit", () => {
    let dirty = true;
    render(<Guard dirty isDirty={() => dirty} />);

    const blocked = beforeUnload();
    window.dispatchEvent(blocked);
    expect(blocked.defaultPrevented).toBe(true);

    dirty = false;
    const allowed = beforeUnload();
    window.dispatchEvent(allowed);
    expect(allowed.defaultPrevented).toBe(false);
  });
});
