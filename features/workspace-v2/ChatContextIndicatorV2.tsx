"use client";

import { useState } from "react";
import { composerContextGauge, type ComposerContextStats } from "@/components/app-shell/composerContextStats";
import { formatTokenCount } from "@/components/app-shell/shellFormatting";
import { useMenuDismissalV2 } from "@/components/ui-v2/useMenuDismissalV2";
import { UiV2Button } from "@/components/ui-v2";
import type { ChatContinuationControl } from "@/components/app-shell/useChatContinuation";

export function ChatContextIndicatorV2({ stats, continuation }: Readonly<{
  stats: ComposerContextStats; continuation?: ChatContinuationControl | null;
}>) {
  const [manualOpen, setOpen] = useState(false);
  const open = manualOpen || Boolean(continuation?.suggested);
  const close = () => { setOpen(false); continuation?.onDismiss(); };
  const { menuRef, triggerRef } = useMenuDismissalV2<HTMLButtonElement, HTMLElement>({
    onClose: close, open
  });
  const gauge = composerContextGauge(stats);
  const label = stats.requestRejected ? "This request exceeds the model context capacity" : gauge.percent === null
    ? "Chat context size is unavailable"
    : `Chat context is approximately ${gauge.percent}% full`;
  const circumference = 2 * Math.PI * 9;
  const remaining = stats.safeInputBudgetTokens === null ? null :
    Math.max(0, stats.safeInputBudgetTokens - stats.approximateInputTokens);
  const count = (value: number | null) => value === null ? "Unavailable" : formatTokenCount(value);

  return (
    <span className="v2-chat-context">
      <button
        ref={triggerRef}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={label}
        className="v2-chat-context-trigger v2-focusable"
        data-context-tone={gauge.tone}
        data-testid="header-context-indicator"
        title={label}
        type="button"
        onClick={() => { if (open) close(); else setOpen(true); }}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <circle className="v2-chat-context-track" cx="12" cy="12" fill="none" r="9" strokeWidth="3" />
          <circle cx="12" cy="12" fill="none" r="9" stroke="currentColor" strokeWidth="3"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - Math.min(1, gauge.fraction ?? 0))}
            strokeLinecap="round" />
        </svg>
        <span>{stats.requestRejected && gauge.percent === null ? "!" : gauge.percent === null ? "?" : `${gauge.percent}%`}</span>
      </button>
      {open ? (
        <section ref={menuRef} aria-label="Chat context" className="v2-chat-context-popover" role="dialog">
          <strong>{label}.</strong>
          <p>The percentage estimates how much of the full model context window is used. Space for its next answer is reserved; the answer reserve and safety margin reduce the safe input budget.</p>
          {gauge.tone === "critical" ? <p role="alert">{stats.requestRejected ? "The server could not fit this request in the model context window." : "There is no safe input room for the current request."} Shorten the message, remove attachments, or continue in a new chat with a summary.</p> : null}
          {gauge.tone === "warning" ? <p>The safe input budget is nearly full. You can keep working here or continue in a new chat with a summary.</p> : null}
          {continuation ? <div className="v2-chat-context-continuation">
            <p>Continue in a new chat with a short summary of this conversation. Files and Workspace won’t be carried over.</p>
            {continuation.error ? <p role="alert">{continuation.error}</p> : null}
            {continuation.busy ? <>
              <p role="status">Preparing your summary…</p>
              <UiV2Button onClick={continuation.onCancel}>Cancel</UiV2Button>
            </> : <div className="v2-chat-context-actions">
              <UiV2Button tone="primary" onClick={continuation.onContinue}>Summarize and open new chat</UiV2Button>
              <UiV2Button onClick={close}>Stay here</UiV2Button>
            </div>}
          </div> : null}
          {stats.session?.droppedMessages ? <p>{stats.session.droppedMessages} earlier {stats.session.droppedMessages === 1 ? "message is" : "messages are"} still in this chat, but were omitted from the model request. You can continue in a new chat with a summary.</p> : null}
          <details>
            <summary>Advanced details</summary>
            <p>{stats.session
              ? stats.session.phase === "after_answer" ? "Estimated from the last request and completed answer." : "Estimated from the current request."
              : "Preliminary estimate. Tools and private context are measured when an answer runs."}</p>
            <dl>
              <div><dt>Context tokens</dt><dd>~{count(stats.approximateInputTokens)}</dd></div>
              <div><dt>Safe input budget</dt><dd>{count(stats.safeInputBudgetTokens)}</dd></div>
              <div><dt>Available input tokens</dt><dd>{count(remaining)}</dd></div>
              <div><dt>Model context limit</dt><dd>{count(stats.totalContextTokens)}</dd></div>
              <div><dt>Answer reserve</dt><dd>{count(stats.answerReserveTokens ?? stats.session?.maxOutputTokens ?? null)}</dd></div>
              <div><dt>Safety margin</dt><dd>{count(stats.safetyMarginTokens ?? stats.session?.safetyMarginTokens ?? null)}</dd></div>
              {stats.session ? <>
                <div><dt>Loaded tools</dt><dd>{stats.session.loadedTools}</dd></div>
                <div><dt>Earlier messages omitted</dt><dd>{stats.session.droppedMessages}</dd></div>
              </> : null}
            </dl>
          </details>
        </section>
      ) : null}
    </span>
  );
}
