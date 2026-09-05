"use client";

import { useState } from "react";
import { composerContextGauge, type ComposerContextStats } from "@/components/app-shell/composerContextStats";
import { formatTokenCount } from "@/components/app-shell/shellFormatting";
import { useMenuDismissalV2 } from "@/components/ui-v2/useMenuDismissalV2";

export function ChatContextIndicatorV2({ stats }: Readonly<{ stats: ComposerContextStats }>) {
  const [open, setOpen] = useState(false);
  const { menuRef, triggerRef } = useMenuDismissalV2<HTMLButtonElement, HTMLElement>({
    onClose: () => setOpen(false), open
  });
  const gauge = composerContextGauge(stats);
  const label = gauge.percent === null
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
        onClick={() => setOpen((value) => !value)}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <circle className="v2-chat-context-track" cx="12" cy="12" fill="none" r="9" strokeWidth="3" />
          <circle cx="12" cy="12" fill="none" r="9" stroke="currentColor" strokeWidth="3"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - Math.min(1, gauge.fraction ?? 0))}
            strokeLinecap="round" />
        </svg>
        <span>{gauge.percent === null ? "?" : `${gauge.percent}%`}</span>
      </button>
      {open ? (
        <section ref={menuRef} aria-label="Chat context" className="v2-chat-context-popover" role="dialog">
          <strong>{label}.</strong>
          <p>This is how much of the conversation the model can keep in view. Space for its next answer is reserved.</p>
          {stats.session?.droppedMessages ? <p>Some earlier messages no longer fit in the model’s context.</p> : null}
          <details>
            <summary>Advanced details</summary>
            <p>{stats.session
              ? stats.session.phase === "after_answer" ? "Estimated from the last request and completed answer." : "Estimated from the current request."
              : "Preliminary estimate. Tools and private context are measured when an answer runs."}</p>
            <dl>
              <div><dt>Context tokens</dt><dd>~{count(stats.approximateInputTokens)}</dd></div>
              <div><dt>Available tokens</dt><dd>{count(remaining)}</dd></div>
              <div><dt>Model context limit</dt><dd>{count(stats.totalContextTokens)}</dd></div>
              {stats.session ? <>
                <div><dt>Answer reserve</dt><dd>{count(stats.session.maxOutputTokens)}</dd></div>
                <div><dt>Safety margin</dt><dd>{count(stats.session.safetyMarginTokens)}</dd></div>
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
