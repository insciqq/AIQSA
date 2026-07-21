import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAnswerNotification } from "./useAnswerNotification";

describe("useAnswerNotification", () => {
  afterEach(() => {
    document.head.querySelectorAll('link[rel~="icon"]').forEach((link) => link.remove());
    window.localStorage.removeItem("aiqsa.answerSound");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("closes its audio context and restores the favicon on unmount", async () => {
    const close = vi.fn(async () => undefined);
    const audioContext = {
      close,
      resume: vi.fn(async () => undefined),
      state: "running"
    };
    const AudioContextMock = vi.fn(function AudioContextMock() {
      return audioContext;
    });
    vi.stubGlobal("AudioContext", AudioContextMock);

    const favicon = document.createElement("link");
    favicon.rel = "icon";
    favicon.href = "/favicon-alert.svg";
    document.head.append(favicon);

    const { result, unmount } = renderHook(() => useAnswerNotification());
    await act(async () => {
      await result.current.primeAnswerSound();
    });

    unmount();

    expect(close).toHaveBeenCalledOnce();
    expect(new URL(favicon.href).pathname).toBe("/favicon.svg");
  });

  it("uses the latest sound preference from an in-flight notification callback", async () => {
    const start = vi.fn();
    const audioParam = {
      exponentialRampToValueAtTime: vi.fn(),
      setValueAtTime: vi.fn()
    };
    const audioContext = {
      close: vi.fn(async () => undefined),
      createGain: vi.fn(() => ({ connect: vi.fn(), gain: audioParam })),
      createOscillator: vi.fn(() => ({
        connect: vi.fn(),
        frequency: audioParam,
        start,
        stop: vi.fn(),
        type: "sine"
      })),
      currentTime: 0,
      destination: {},
      resume: vi.fn(async () => undefined),
      state: "running"
    };
    vi.stubGlobal(
      "AudioContext",
      vi.fn(function AudioContextMock() {
        return audioContext;
      })
    );
    const { result } = renderHook(() => useAnswerNotification());
    const notificationCapturedAtRunStart = result.current.notifyAnswerReady;

    act(() => result.current.toggleNotificationSound());
    await act(async () => {
      await notificationCapturedAtRunStart();
    });
    expect(start).not.toHaveBeenCalled();

    act(() => result.current.toggleNotificationSound());
    await act(async () => {
      await notificationCapturedAtRunStart();
    });
    expect(start).toHaveBeenCalledOnce();
  });
});
