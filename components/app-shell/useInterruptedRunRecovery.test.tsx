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
