import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useInterruptedRunRecovery } from "./useInterruptedRunRecovery";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it("waits while hidden, retries on return and stops after reconciliation", async () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  const refresh = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
  const hook = renderHook(() => useInterruptedRunRecovery({ chatId: "chat", interrupted: true, refresh }));
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(refresh).not.toHaveBeenCalled();
  visibility.mockReturnValue("visible");
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(refresh).toHaveBeenCalledWith("chat");
  act(() => window.dispatchEvent(new Event("online")));
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(refresh).toHaveBeenCalledTimes(2);
  hook.unmount();
});

it("remembers an online event during a failed read and drops retries after navigation", async () => {
  vi.useFakeTimers();
  let finish!: (value: boolean) => void;
  const refresh = vi.fn().mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = resolve; }))
    .mockResolvedValue(false);
  const hook = renderHook(({ chatId }) => useInterruptedRunRecovery({ chatId, interrupted: true, refresh }),
    { initialProps: { chatId: "chat-a" as string | null } });
  await act(() => vi.advanceTimersByTimeAsync(1_000));
  act(() => window.dispatchEvent(new Event("online")));
  await act(async () => { finish(false); });
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(refresh).toHaveBeenCalledTimes(2);
  hook.rerender({ chatId: null });
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(refresh).toHaveBeenCalledTimes(2);
  hook.unmount();
});

it("refreshes idle chat state on each return and retries a failed foreground read", async () => {
  vi.useFakeTimers();
  const refresh = vi.fn();
  const refreshOnReturn = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
  const hook = renderHook(() => useInterruptedRunRecovery({ chatId: "chat", interrupted: false, refresh, refreshOnReturn }));
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(refreshOnReturn).not.toHaveBeenCalled();
  act(() => window.dispatchEvent(new Event("pageshow")));
  await act(() => vi.advanceTimersByTimeAsync(1_000));
  expect(refreshOnReturn).toHaveBeenCalledTimes(2);
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(refreshOnReturn).toHaveBeenCalledTimes(2);
  act(() => document.dispatchEvent(new Event("resume")));
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(refreshOnReturn).toHaveBeenCalledTimes(3);
  expect(refresh).not.toHaveBeenCalled();
  hook.unmount();
});

it("aborts an idle refresh on navigation and ignores its late settlement", async () => {
  vi.useFakeTimers();
  let finish!: (value: boolean) => void;
  const refreshOnReturn = vi.fn((_chatId: string, _signal: AbortSignal) => new Promise<boolean>(resolve => { finish = resolve; }));
  const hook = renderHook(({ chatId }) => useInterruptedRunRecovery({ chatId, interrupted: false, refresh: vi.fn(), refreshOnReturn }),
    { initialProps: { chatId: "chat-a" } });
  act(() => window.dispatchEvent(new Event("focus")));
  await act(() => vi.advanceTimersByTimeAsync(0));
  const signal = refreshOnReturn.mock.calls[0][1];
  hook.rerender({ chatId: "chat-b" });
  expect(signal.aborted).toBe(true);
  await act(async () => finish(false));
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(refreshOnReturn).toHaveBeenCalledOnce();
  hook.unmount();
});
