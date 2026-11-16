import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useStudioNavigation } from "./useStudioNavigation";
import { initialStudioSection, rememberStudioSection, storedStudioSection } from "@/components/app-shell/shellStorage";

const available = ["general", "assistants", "memory", "files"] as const;

describe("Settings navigation", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); window.localStorage.clear(); });

  it("chooses explicit, remembered, General and first available sections in that order", () => {
    expect(initialStudioSection(available)).toBe("general");
    rememberStudioSection("files");
    expect(initialStudioSection(available)).toBe("files");
    expect(initialStudioSection(available, "memory")).toBe("memory");
    expect(initialStudioSection(["memory"])).toBe("memory");
    expect(initialStudioSection([])).toBeUndefined();
    window.localStorage.setItem("aiqsa.studio.section", "broken");
    expect(initialStudioSection(available)).toBe("general");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("unavailable"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("unavailable"); });
    expect(initialStudioSection(available)).toBe("general");
    expect(() => rememberStudioSection("files")).not.toThrow();
    vi.stubGlobal("window", undefined);
    expect(storedStudioSection(available)).toBeNull();
    expect(() => rememberStudioSection("files")).not.toThrow();
  });

  it("opens the gear on General, else the last section, beside the list; a named section shows itself", () => {
    const onSelect = vi.fn();
    const { result } = renderHook(() => useStudioNavigation({ available, onSelect, onExit: vi.fn() }));
    act(() => result.current.open());
    expect(onSelect).toHaveBeenLastCalledWith("general");
    expect(result.current).toMatchObject({ sectionShown: false, tab: "general" });

    act(() => result.current.open("files"));
    expect(result.current).toMatchObject({ sectionShown: true, tab: "files" });
    act(() => result.current.showSection(false));
    act(() => result.current.open());
    expect(result.current).toMatchObject({ sectionShown: false, tab: "files" });

    // Inside Settings a change keeps the list or the section as shown.
    act(() => result.current.select("memory"));
    expect(result.current).toMatchObject({ sectionShown: false, tab: "memory" });
    act(() => result.current.showSection(true));
    act(() => result.current.select("assistants"));
    expect(result.current).toMatchObject({ sectionShown: true, tab: "assistants" });

    // A section this account is not offered opens the list on the last one.
    act(() => result.current.showSection(false));
    act(() => result.current.open("telegram"));
    expect(result.current).toMatchObject({ sectionShown: false, tab: "assistants" });
  });

  it("says when a link named a section this installation does not offer", () => {
    const onUnavailable = vi.fn();
    const { result } = renderHook(() => useStudioNavigation({ available, onExit: vi.fn(), onSelect: vi.fn(), onUnavailable }));
    act(() => result.current.open("memory"));
    act(() => result.current.open());
    expect(onUnavailable).not.toHaveBeenCalled();
    act(() => result.current.open("computers"));
    expect(onUnavailable).toHaveBeenCalledExactlyOnceWith("computers");
    expect(result.current).toMatchObject({ sectionShown: false, tab: "memory" });
  });

  it("shows the open section for a link to it while Settings holds a guard", () => {
    const guard = vi.fn((proceed: () => void) => proceed());
    const { result } = renderHook(() => useStudioNavigation({ available, onSelect: vi.fn(), onExit: vi.fn() }));
    act(() => result.current.open("memory"));
    act(() => result.current.showSection(false));
    act(() => result.current.registerGuard(guard, false));
    act(() => result.current.open("memory"));
    expect(guard).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({ sectionShown: true, tab: "memory" });
    act(() => result.current.showSection(false));
    act(() => result.current.open());
    expect(result.current.sectionShown).toBe(false);
  });

  it("defers the exact destination and preference write until the draft owner proceeds", () => {
    const onSelect = vi.fn();
    const onExit = vi.fn();
    const editAssistant = vi.fn();
    let pending: (() => void) | undefined;
    const guard = vi.fn((proceed: () => void) => { pending = proceed; });
    const { result } = renderHook(() => useStudioNavigation({ available, onSelect, onExit }));
    act(() => result.current.registerGuard(guard, false));
    act(() => result.current.open("memory"));
    expect(onSelect).not.toHaveBeenCalled();
    expect(storedStudioSection(available)).toBeNull();
    expect(result.current.tab).toBe("general");
    act(() => pending?.());
    expect(result.current.tab).toBe("memory");
    expect(storedStudioSection(available)).toBe("memory");
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
    act(() => { result.current.open(); result.current.open("general"); });
    expect(guard).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    act(() => result.current.registerGuard(guard, true));
    const sideEffect = vi.fn();
    act(() => { result.current.open("files", sideEffect); result.current.select("files", sideEffect); result.current.exit(sideEffect); });
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
