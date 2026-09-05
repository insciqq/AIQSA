"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { decodeChatContinuationResult } from "@/lib/contracts/chatContinuation";
import { decodeChatDetailResponse, type ChatDetail } from "@/lib/contracts/chats";
import { chatDetailFromApi, shellFetch } from "./shellApi";
import { loadChatMemoryState } from "./chatLifecycleApi";

export type ChatContinuationControl = Readonly<{
  busy: boolean;
  error: string | null;
  suggested: boolean;
  onContinue(): void;
  onDismiss(): void;
  onCancel(): void;
}>;

function dismissed(key: string): boolean {
  try { return localStorage.getItem(key) === "1"; } catch { return false; }
}

const errors: Record<string, string> = {
  chat_not_found: "This chat is no longer available.",
  chat_changed: "The conversation changed. Wait for the latest answer and try again.",
  chat_busy: "Wait for the current answer to finish.",
  chat_summary_too_large: "This conversation is too large to summarize automatically.",
  chat_summary_unavailable: "Summaries are unavailable. Ask an administrator to check the System Model.",
  chat_summary_failed: "The summary could not be completed. Your conversation is still here.",
  chat_summary_cancelled: "Summarization was cancelled. Your conversation is still here."
};

function pollDelay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, 2000);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  });
}

export function useChatContinuation(input: Readonly<{
  accountId: string;
  chatId: string | null;
  leafMessageId: string | null;
  eligible: boolean;
  recommended: boolean;
  onOpen(chat: ChatDetail): void;
}>): ChatContinuationControl {
  const key = `aiqsa:context-warning:${encodeURIComponent(input.accountId)}:${encodeURIComponent(input.chatId ?? "")}`;
  const sourceKey = `${key}:${input.leafMessageId ?? ""}:${input.eligible}`;
  const [dismissal, setDismissal] = useState<string | null>(null);
  const [storedDismissal, setStoredDismissal] = useState<{ key: string; dismissed: boolean } | null>(null);
  const [state, setState] = useState({ sourceKey, busy: false, error: null as string | null });
  const operation = useRef<{ controller: AbortController; sourceKey: string; requestId: string } | null>(null);
  const retry = useRef<{ sourceKey: string; requestId: string } | null>(null);
  const current = useRef(input);
  const currentSource = useRef(sourceKey);
  useLayoutEffect(() => { current.current = input; currentSource.current = sourceKey; });
  useEffect(() => () => { operation.current?.controller.abort(); operation.current = null; }, [sourceKey]);
  useEffect(() => {
    let mounted = true;
    queueMicrotask(() => { if (mounted) setStoredDismissal({ key, dismissed: dismissed(key) }); });
    return () => { mounted = false; };
  }, [key]);

  const onDismiss = () => {
    setDismissal(key);
    try { localStorage.setItem(key, "1"); } catch { /* The in-memory dismissal still lasts for this visit. */ }
  };
  const onCancel = () => {
    operation.current?.controller.abort();
    operation.current = null;
    retry.current = null;
    setState({ sourceKey, busy: false, error: "Summarization stopped. Your conversation is still here." });
  };

  const onContinue = async () => {
    if (!input.eligible || !input.chatId || !input.leafMessageId || operation.current) return;
    const controller = new AbortController();
    const requestId = retry.current?.sourceKey === sourceKey ? retry.current.requestId : crypto.randomUUID();
    const owner = { controller, requestId, sourceKey };
    operation.current = owner;
    retry.current = { sourceKey, requestId };
    const owns = () => operation.current === owner && !controller.signal.aborted && currentSource.current === sourceKey;
    setState({ sourceKey, busy: true, error: null });
    const timeout = setTimeout(() => controller.abort(), 190_000);
    try {
      while (owns()) {
        const response = await shellFetch(`/api/chats/${encodeURIComponent(input.chatId)}/continue`, {
          body: JSON.stringify({ expectedLeafMessageId: input.leafMessageId, requestId }),
          headers: { "content-type": "application/json" }, method: "POST", signal: controller.signal
        });
        const body: unknown = await response.json();
        if (!owns()) return;
        if (!response.ok) {
          // Only a definitive server failure permits a new paid attempt. Network loss reuses the claim.
          const code = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : "";
          if (code in errors) retry.current = null;
          throw new Error(errors[code] ?? "Could not check the summary. Try again to check its status.");
        }
        const result = decodeChatContinuationResult(body);
        if (!result) throw new Error("Could not check the summary. Try again to check its status.");
        if (result.status === "running") { await pollDelay(controller.signal); continue; }
        const detailResponse = await shellFetch(`/api/chats/${encodeURIComponent(result.chatId)}`, { signal: controller.signal });
        const detail = detailResponse.ok ? decodeChatDetailResponse(await detailResponse.json()) : null;
        if (!owns()) return;
        if (!detail || detail.id !== result.chatId || (detail.projectId ?? null) !== result.projectId) {
          throw new Error("The summary was saved, but the new chat could not be opened. Try again to open it.");
        }
        const summary = chatDetailFromApi(detail);
        if (result.projectId) summary.memoryMode = "EXCLUDED";
        else {
          const memory = await loadChatMemoryState(result.chatId, controller.signal);
          if (!owns()) return;
          summary.memoryMode = memory.mode;
          summary.temporaryRetentionDeadline = memory.temporaryRetentionDeadline;
        }
        current.current.onOpen(summary);
        return;
      }
    } catch (error) {
      if (operation.current === owner && currentSource.current === sourceKey) {
        const knownMessage = error instanceof Error && (Object.values(errors).includes(error.message) ||
          error.message.startsWith("The summary was saved"));
        setState({ sourceKey, busy: false, error: controller.signal.aborted
          ? "The summary is taking too long. Try again to check its status."
          : knownMessage ? error.message : "Could not check the summary. Try again to check its status." });
      }
    } finally {
      clearTimeout(timeout);
      if (operation.current === owner) { operation.current = null; setState((value) => ({ ...value, busy: false })); }
    }
  };

  return {
    busy: state.sourceKey === sourceKey && state.busy,
    error: state.sourceKey === sourceKey ? state.error : null,
    suggested: input.eligible && input.recommended && dismissal !== key && storedDismissal?.key === key && !storedDismissal.dismissed,
    onContinue: () => { void onContinue(); }, onDismiss, onCancel
  };
}
