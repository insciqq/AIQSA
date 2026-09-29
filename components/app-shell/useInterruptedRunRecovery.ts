import { useEffect } from "react";
import { subscribeToSessionExpired } from "./shellApi";
import { useEventCallback } from "./useEventCallback";

/** Reconcile interrupted answers and foreground returns without resending. */
export function useInterruptedRunRecovery(input: {
  chatId: string | null;
  interrupted: boolean;
  refresh(chatId: string): Promise<boolean>;
  refreshOnReturn?(chatId: string, signal: AbortSignal): Promise<boolean>;
}): void {
  const refresh = useEventCallback(input.refresh);
  const refreshOnReturn = useEventCallback(input.refreshOnReturn ?? (async () => true));
  useEffect(() => {
    const chatId = input.chatId;
    if (!chatId) return;
    let stopped = false;
    let checking = false;
    let wakePending = false;
    let requested = input.interrupted;
    let controller: AbortController | null = null;
    let delay = 1_000;
    let timer: ReturnType<typeof setTimeout>;
    const halt = () => { stopped = true; clearTimeout(timer); controller?.abort(); };
    const schedule = (ms: number) => {
      clearTimeout(timer);
      if (!stopped && requested && document.visibilityState === "visible") timer = setTimeout(() => { void check(); }, ms);
    };
    const check = async () => {
      if (stopped || checking || document.visibilityState !== "visible") return;
      checking = true;
      controller = new AbortController();
      try {
        const reconciled = input.interrupted
          ? await refresh(chatId)
          : await refreshOnReturn(chatId, controller.signal);
        if (reconciled && !controller.signal.aborted) requested = false;
      } catch { /* Keep the interruption visible until a successful read. */ }
      finally {
        checking = false;
        controller = null;
        requested ||= wakePending;
        schedule(wakePending ? 0 : delay);
        wakePending = false;
        delay = Math.min(delay * 2, 30_000);
      }
    };
    const wake = () => {
      requested = true;
      delay = 1_000;
      if (document.visibilityState !== "visible") controller?.abort();
      if (checking) wakePending = true;
      else schedule(0);
    };
    const unsubscribe = subscribeToSessionExpired(halt);
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    window.addEventListener("focus", wake);
    window.addEventListener("pageshow", wake);
    document.addEventListener("resume", wake);
    schedule(delay);
    return () => {
      halt(); unsubscribe();
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
      window.removeEventListener("focus", wake);
      window.removeEventListener("pageshow", wake);
      document.removeEventListener("resume", wake);
    };
  }, [input.chatId, input.interrupted, refresh, refreshOnReturn]);
}
