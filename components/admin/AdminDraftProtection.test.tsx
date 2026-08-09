import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAdminDraftRegistry } from "./AdminDraftProtection";

describe("Control Center draft registry", () => {
  it("discards only requested owners and removes clean/unmounted entries", () => {
    const firstDiscard = vi.fn();
    const secondDiscard = vi.fn();
    const { result } = renderHook(() => useAdminDraftRegistry());
    let unregisterFirst!: () => void;
    let unregisterSecond!: () => void;

    act(() => {
      unregisterFirst = result.current.register("first", {
        dirty: true,
        discard: firstDiscard
      });
      unregisterSecond = result.current.register("second", {
        dirty: true,
        discard: secondDiscard
      });
    });
    expect(result.current.dirty).toBe(true);
    expect(result.current.hasDirty(["first"])).toBe(true);

    act(() => result.current.discard(["first"]));
    expect(firstDiscard).toHaveBeenCalledOnce();
    expect(secondDiscard).not.toHaveBeenCalled();
    expect(result.current.hasDirty(["first"])).toBe(false);
    expect(result.current.hasDirty(["second"])).toBe(true);
    expect(result.current.dirty).toBe(true);

    act(() => unregisterSecond());
    expect(result.current.dirty).toBe(false);
    act(() => unregisterFirst());
  });

  it("does not let an obsolete cleanup remove a newer owner registration", () => {
    const { result } = renderHook(() => useAdminDraftRegistry());
    let unregisterOld!: () => void;
    let unregisterCurrent!: () => void;

    act(() => {
      unregisterOld = result.current.register("shared-owner", {
        dirty: true,
        discard: vi.fn()
      });
      unregisterCurrent = result.current.register("shared-owner", {
        dirty: false,
        discard: vi.fn(),
        pending: true
      });
    });
    expect(result.current.dirty).toBe(false);
    expect(result.current.pending).toBe(true);

    act(() => unregisterOld());
    expect(result.current.pending).toBe(true);
    act(() => unregisterCurrent());
    expect(result.current.pending).toBe(false);
  });
});
