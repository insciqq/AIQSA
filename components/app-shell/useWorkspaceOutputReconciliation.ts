import { useEffect } from "react";
import type { ThreadMessage } from "./types";
import { subscribeToSessionExpired } from "./shellApi";
import { useEventCallback } from "./useEventCallback";

type RefreshOptions = Readonly<{
  forceDetail: true;
  preserveControls: true;
  resumeRuns: false;
  signal: AbortSignal;
  onUnavailable(): void;
}>;

/** Only personal terminal outputs need this source; Projects own their SSE refresh. */
export function useWorkspaceOutputReconciliation(input: Readonly<{
  accountId: string;
  chatId: string | null;
  messages: readonly ThreadMessage[];
  projectId?: string | null;
  streaming: boolean;
  refreshActiveChat(chatId: string, options: RefreshOptions): Promise<unknown>;
}>): void {
  const pending = input.messages.filter((message) => message.status === "complete" &&
    ["exporting", "retrying"].includes(message.workspaceActivity?.outputStatus?.state ?? ""))
    .map((message) => message.id).join("\0");
  const enabled = !input.projectId && !input.streaming && pending.length > 0 &&
    !input.messages.some((message) => message.status === "streaming");
  const refresh = useEventCallback(input.refreshActiveChat);
  useEffect(() => {
    const chatId = input.chatId;
    if (!enabled || !chatId) return;
    let stopped = false;
    let delay = 2_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | null = null;
    const halt = () => {
      stopped = true;
      clearTimeout(timer);
      request?.abort();
    };
    const schedule = () => {
      if (!stopped && !request && document.visibilityState === "visible") {
        clearTimeout(timer);
        timer = setTimeout(() => { void poll(); }, delay);
      }
    };
    const poll = async () => {
      if (stopped || request || document.visibilityState !== "visible") return;
      const current = new AbortController();
      request = current;
      const timeout = setTimeout(() => current.abort(), 15_000);
      try {
        await refresh(chatId, {
          forceDetail: true, preserveControls: true, resumeRuns: false,
          signal: current.signal, onUnavailable: halt
        });
      } catch { /* Transient failure retains the existing files and bounded cadence. */ }
      finally {
        clearTimeout(timeout);
        request = null;
        delay = Math.min(30_000, delay * 2);
        schedule();
      }
    };
    const visibility = () => {
      clearTimeout(timer);
      if (document.visibilityState !== "visible") request?.abort();
      else { delay = 2_000; schedule(); }
    };
    const unsubscribe = subscribeToSessionExpired(halt);
    document.addEventListener("visibilitychange", visibility);
    schedule();
    return () => {
      halt(); unsubscribe();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [input.accountId, input.chatId, enabled, pending, refresh]);
}
