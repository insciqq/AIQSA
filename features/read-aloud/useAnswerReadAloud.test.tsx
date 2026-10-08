import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSharedReadAloudControllerForTests } from "./readAloudController";
import { useAnswerReadAloud } from "./useAnswerReadAloud";

class FakeUtterance {
  lang = "";
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  voice: SpeechSynthesisVoice | null = null;
  constructor(readonly text: string) {}
}

type HookProps = { chatKey: string | null; ids: string[]; runActive: boolean };

function installSpeech() {
  const synth = {
    addEventListener: vi.fn(),
    cancel: vi.fn(),
    getVoices: () => [],
    paused: false,
    speak: vi.fn()
  };
  Object.defineProperty(window, "speechSynthesis", { configurable: true, value: synth });
  Object.defineProperty(window, "SpeechSynthesisUtterance", { configurable: true, value: FakeUtterance });
  return synth;
}

function renderReadAloud(initial: HookProps) {
  return renderHook((props: HookProps) => useAnswerReadAloud({
    chatKey: props.chatKey,
    hasMessage: (id) => props.ids.includes(id),
    runActive: props.runActive
  }), { initialProps: initial });
}

describe("useAnswerReadAloud", () => {
  beforeEach(() => resetSharedReadAloudControllerForTests());
  afterEach(() => {
    Reflect.deleteProperty(window, "speechSynthesis");
    Reflect.deleteProperty(window, "SpeechSynthesisUtterance");
    resetSharedReadAloudControllerForTests();
  });

  it("is absent without browser speech", () => {
    const { result } = renderReadAloud({ chatKey: "c1", ids: ["a1"], runActive: false });
    expect(result.current).toBeNull();
  });

  it("tracks the speaking answer and stops on chat switch", () => {
    const synth = installSpeech();
    const initial = { chatKey: "c1", ids: ["a1", "a2"], runActive: false };
    const { rerender, result } = renderReadAloud(initial);
    act(() => result.current?.toggle("a1", "Hello there."));
    expect(result.current?.activeId).toBe("a1");
    expect(synth.speak).toHaveBeenCalledTimes(1);

    act(() => result.current?.toggle("a2", "Second."));
    expect(result.current?.activeId).toBe("a2");

    rerender({ ...initial, chatKey: "c2" });
    expect(result.current?.activeId).toBeNull();
    expect(synth.cancel).toHaveBeenCalled();
  });

  it("stops when a run starts, when the answer leaves the thread, and on unmount", () => {
    installSpeech();
    const initial = { chatKey: "c1", ids: ["a1"], runActive: false };
    const { rerender, result, unmount } = renderReadAloud(initial);

    act(() => result.current?.toggle("a1", "Hello."));
    rerender({ ...initial, runActive: true });
    expect(result.current?.activeId).toBeNull();

    rerender(initial);
    act(() => result.current?.toggle("a1", "Hello."));
    rerender({ ...initial, ids: [] });
    expect(result.current?.activeId).toBeNull();

    rerender(initial);
    act(() => result.current?.toggle("a1", "Hello."));
    expect(result.current?.activeId).toBe("a1");
    const cancelsBefore = vi.mocked(window.speechSynthesis.cancel).mock.calls.length;
    unmount();
    expect(window.speechSynthesis.cancel).toHaveBeenCalledTimes(cancelsBefore + 1);
  });

  it("stops on page hide", () => {
    const synth = installSpeech();
    const { result } = renderReadAloud({ chatKey: "c1", ids: ["a1"], runActive: false });
    act(() => result.current?.toggle("a1", "Hello."));
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(result.current?.activeId).toBeNull();
    expect(synth.cancel).toHaveBeenCalled();
  });
});
