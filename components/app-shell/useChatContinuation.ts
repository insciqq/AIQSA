"use client";

import { randomUUID } from "@/lib/browser/randomUUID";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { decodeChatContinuationResult, type ChatContinuationModelSelection, type ChatContinuationProgress } from "@/lib/contracts/chatContinuation";
import { decodeChatDetailResponse, type ChatDetail } from "@/lib/contracts/chats";
import { chatDetailFromApi, shellFetch } from "./shellApi";
import { loadChatMemoryState } from "./chatLifecycleApi";
import { composerSessionKey, type ComposerSessionKey } from "./composerSessionStore";

export type ChatContinuationControl = Readonly<{
  busy: boolean;
  error: string | null;
  progress?: string | null;
  suggested: boolean;
  uploading?: boolean;
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
  chat_summary_no_progress: "The selected model could not shorten this conversation enough. Ask an administrator to check the System Model.",
  chat_summary_outcome_unknown: "A summary request was interrupted and its outcome is unknown. Earlier paid work was not repeated.",
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
  modelSelection?: ChatContinuationModelSelection;
  uploading?: boolean;
  onOpen(chat: ChatDetail, sourceKey: ComposerSessionKey): void | Promise<void>;
}>): ChatContinuationControl {
  const key = `aiqsa:context-warning:${encodeURIComponent(input.accountId)}:${encodeURIComponent(input.chatId ?? "")}`;
  const sourceKey = `${key}:${input.leafMessageId ?? ""}:${input.eligible}`;
  const [dismissal, setDismissal] = useState<string | null>(null);
  const [storedDismissal, setStoredDismissal] = useState<{ key: string; dismissed: boolean } | null>(null);
  const [state, setState] = useState({ sourceKey, busy: false, error: null as string | null, progress: null as ChatContinuationProgress | null });
  const operation = useRef<{ controller: AbortController; sourceKey: string; requestId: string; cancelRequested: boolean; cancelSent: boolean } | null>(null);
  const retry = useRef<{ sourceKey: string; requestId: string; modelSelection?: ChatContinuationModelSelection } | null>(null);
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
    if (!operation.current) return;
    operation.current.cancelRequested = true;
    setState(value => ({ ...value, error: "Stopping the summary…" }));
  };

  const onContinue = async () => {
    if (!input.eligible || !input.chatId || !input.leafMessageId || input.uploading || operation.current) return;
    const controller = new AbortController();
    const requestId = retry.current?.sourceKey === sourceKey ? retry.current.requestId : randomUUID();
    const modelSelection = retry.current?.sourceKey === sourceKey ? retry.current.modelSelection : input.modelSelection;
    const sourceSessionKey = composerSessionKey(input.chatId);
    const owner = { controller, requestId, sourceKey, cancelRequested: false, cancelSent: false };
    operation.current = owner;
    retry.current = { sourceKey, requestId, modelSelection };
    const owns = () => operation.current === owner && !controller.signal.aborted && currentSource.current === sourceKey;
    setState({ sourceKey, busy: true, error: null, progress: null });
    try {
      while (owns()) {
        const response = await shellFetch(`/api/chats/${encodeURIComponent(input.chatId)}/continue`, {
          body: JSON.stringify({ expectedLeafMessageId: input.leafMessageId, requestId, modelSelection }),
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
        if (result.status === "running") {
          setState(value => ({ ...value, progress: result.progress ?? null }));
          if (owner.cancelRequested && !owner.cancelSent) {
            const cancelled = await shellFetch(`/api/chats/${encodeURIComponent(input.chatId)}/continue`, {
              body: JSON.stringify({ expectedLeafMessageId: input.leafMessageId, requestId }),
              headers: { "content-type": "application/json" }, method: "DELETE", signal: controller.signal
            });
            if (!cancelled.ok) throw new Error("Could not request cancellation. Check the summary's status again.");
            owner.cancelSent = true;
          }
          await pollDelay(controller.signal);
          continue;
        }
        if (owner.cancelRequested) {
          setState(value => ({ ...value, busy: false, error: "The summary finished before cancellation. Choose Summarize again to open it without repeating the work." }));
          return;
        }
        const detailResponse = await shellFetch(`/api/chats/${encodeURIComponent(result.chatId)}`, { signal: controller.signal });
        const detail = detailResponse.ok ? decodeChatDetailResponse(await detailResponse.json()) : null;
        if (!owns() || owner.cancelRequested) return;
        if (!detail || detail.id !== result.chatId || (detail.projectId ?? null) !== result.projectId) {
          throw new Error("The summary was saved, but the new chat could not be opened. Try again to open it.");
        }
        const summary = chatDetailFromApi(detail);
        if (result.projectId) summary.memoryMode = "EXCLUDED";
        else {
          const memory = await loadChatMemoryState(result.chatId, controller.signal);
          if (!owns() || owner.cancelRequested) return;
          summary.memoryMode = memory.mode;
          summary.temporaryRetentionDeadline = memory.temporaryRetentionDeadline;
        }
        await current.current.onOpen(summary, sourceSessionKey);
        return;
      }
    } catch (error) {
      if (operation.current === owner && currentSource.current === sourceKey) {
        const knownMessage = error instanceof Error && (Object.values(errors).includes(error.message) ||
          error.message.startsWith("The summary was saved"));
        setState({ sourceKey, busy: false, progress: null, error: controller.signal.aborted
          ? "Summary status checking stopped. Try again to check its status."
          : knownMessage ? error.message : "Could not check the summary. Try again to check its status." });
      }
    } finally {
      if (operation.current === owner) { operation.current = null; setState((value) => ({ ...value, busy: false })); }
    }
  };

  return {
    busy: state.sourceKey === sourceKey && state.busy,
    error: state.sourceKey === sourceKey ? state.error : null,
    progress: state.sourceKey === sourceKey && state.progress ? state.progress.stage === "preparing" ? "Preparing your summary…"
      : `${state.progress.stage === "combining" ? "Combining summaries" : "Summarizing conversation"} · ${state.progress.completedParts} parts processed` : null,
    suggested: input.eligible && input.recommended && dismissal !== key && storedDismissal?.key === key && !storedDismissal.dismissed,
    uploading: input.uploading ?? false,
    onContinue: () => { void onContinue(); }, onDismiss, onCancel
  };
}
