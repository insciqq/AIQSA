import { useEffect } from "react";
import { subscribeToSessionExpired } from "./shellApi";
import { useEventCallback } from "./useEventCallback";

/** Reconcile an interrupted answer without resending the user's message. */
export function useInterruptedRunRecovery(input: {
  chatId: string | null;
  interrupted: boolean;
  refresh(chatId: string): Promise<boolean>;
}): void {
  const refresh = useEventCallback(input.refresh);
  useEffect(() => {
    const chatId = input.chatId;
    if (!chatId || !input.interrupted) return;
    let stopped = false;
    let checking = false;
    let wakePending = false;
    let delay = 1_000;
    let timer: ReturnType<typeof setTimeout>;
    const halt = () => { stopped = true; clearTimeout(timer); };
    const schedule = (ms: number) => {
      clearTimeout(timer);
      if (!stopped && document.visibilityState === "visible") timer = setTimeout(() => { void check(); }, ms);
    };
    const check = async () => {
      if (stopped || checking || document.visibilityState !== "visible") return;
      checking = true;
      try {
        if (await refresh(chatId)) halt();
      } catch { /* Keep the interruption visible until a successful read. */ }
      finally {
        checking = false;
        schedule(wakePending ? 0 : delay);
        wakePending = false;
        delay = Math.min(delay * 2, 30_000);
      }
    };
    const wake = () => {
      delay = 1_000;
      if (checking) wakePending = true;
      else schedule(0);
    };
    const unsubscribe = subscribeToSessionExpired(halt);
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    window.addEventListener("focus", wake);
    window.addEventListener("pageshow", wake);
    schedule(delay);
    return () => {
      halt(); unsubscribe();
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
      window.removeEventListener("focus", wake);
      window.removeEventListener("pageshow", wake);
    };
  }, [input.chatId, input.interrupted, refresh]);
}
