import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useStudioNavigation } from "./useStudioNavigation";
import { initialStudioSection, rememberStudioSection, storedStudioSection } from "@/components/app-shell/shellStorage";

const available = ["assistants", "knowledge", "files"] as const;

describe("Studio navigation", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); window.localStorage.clear(); });

  it("chooses explicit, remembered, Assistants and first available sections in that order", () => {
    expect(initialStudioSection(available)).toBe("assistants");
    rememberStudioSection("files");
    expect(initialStudioSection(available)).toBe("files");
    expect(initialStudioSection(available, "knowledge")).toBe("knowledge");
    expect(initialStudioSection(["knowledge"])).toBe("knowledge");
    expect(initialStudioSection([])).toBeUndefined();
    window.localStorage.setItem("aiqsa.studio.section", "broken");
    expect(initialStudioSection(available)).toBe("assistants");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("unavailable"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("unavailable"); });
    expect(initialStudioSection(available)).toBe("assistants");
    expect(() => rememberStudioSection("files")).not.toThrow();
    vi.stubGlobal("window", undefined);
    expect(storedStudioSection(available)).toBeNull();
    expect(() => rememberStudioSection("files")).not.toThrow();
  });

  it("defers the exact destination and preference write until the draft owner proceeds", () => {
    const onSelect = vi.fn();
    const onExit = vi.fn();
    const editAssistant = vi.fn();
    let pending: (() => void) | undefined;
    const guard = vi.fn((proceed: () => void) => { pending = proceed; });
    const { result } = renderHook(() => useStudioNavigation({ available, onSelect, onExit }));
    act(() => result.current.registerGuard(guard, false));
    act(() => result.current.open("knowledge"));
    expect(onSelect).not.toHaveBeenCalled();
    expect(storedStudioSection(available)).toBeNull();
    expect(result.current.tab).toBe("assistants");
    act(() => pending?.());
    expect(result.current.tab).toBe("knowledge");
    expect(storedStudioSection(available)).toBe("knowledge");
    act(() => result.current.open("assistants", editAssistant));
    expect(editAssistant).not.toHaveBeenCalled();
    act(() => pending?.());
    expect(editAssistant).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenLastCalledWith("assistants");

    const createChat = vi.fn();
    act(() => result.current.exit(createChat));
    expect(onExit).not.toHaveBeenCalled();
    expect(createChat).not.toHaveBeenCalled();
    act(() => pending?.());
    expect(onExit).toHaveBeenCalledOnce();
    expect(createChat).toHaveBeenCalledOnce();
    expect(onExit.mock.invocationCallOrder[0]).toBeLessThan(createChat.mock.invocationCallOrder[0]!);
  });

  it("leaves a current subview intact and blocks every transition while a mutation is pending", () => {
    const onSelect = vi.fn();
    const onExit = vi.fn();
    const guard = vi.fn((proceed: () => void) => proceed());
    const { result } = renderHook(() => useStudioNavigation({ available, onSelect, onExit }));
    act(() => result.current.registerGuard(guard, false));
    act(() => { result.current.open(); result.current.open("assistants"); });
    expect(guard).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    act(() => result.current.registerGuard(guard, true));
    const sideEffect = vi.fn();
    act(() => { result.current.open("files", sideEffect); result.current.exit(sideEffect); });
    expect(result.current.busy).toBe(true);
    expect(guard).not.toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();
    expect(sideEffect).not.toHaveBeenCalled();
    act(() => result.current.registerGuard(null, false));
    rememberStudioSection("files");
    act(() => result.current.open());
    expect(onSelect).toHaveBeenCalledWith("files");
  });
});
