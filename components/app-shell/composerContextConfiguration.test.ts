import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { resetComposerControlStoreForTest } from "@/tests/support/appShellStores";
import { useComposerControlStore } from "./composerControlStore";
import { useComposerContextConfigurationKey } from "./composerContextConfiguration";

afterEach(() => resetComposerControlStoreForTest());

describe("live composer context configuration", () => {
  it("invalidates accepted Auto context immediately when Skills changes without another render", () => {
    const { result } = renderHook(() => useComposerContextConfigurationKey({ memoryMode: "NORMAL", workspaceEnabled: false }));
    const accepted = result.current;

    act(() => useComposerControlStore.getState().setSkillsMode("off"));

    expect(result.current).not.toBe(accepted);
    expect(JSON.parse(result.current).skillsMode).toBe("off");
    act(() => useComposerControlStore.getState().setSkillsMode("auto"));
    expect(result.current).toBe(accepted);
  });

  it("keeps presentation-only changes outside the accepted control binding", () => {
    const { result } = renderHook(() => useComposerContextConfigurationKey({ memoryMode: "NORMAL", workspaceEnabled: false }));
    const accepted = result.current;

    act(() => useComposerControlStore.getState().setShowCitations(false));

    expect(result.current).toBe(accepted);
  });
});
