"use client";

import { useId, useState } from "react";
import { composerContextGauge, type ComposerContextStats } from "@/components/app-shell/composerContextStats";
import { formatTokenCount } from "@/components/app-shell/shellFormatting";
import { useMenuDismissalV2 } from "@/components/ui-v2/useMenuDismissalV2";
import { UiV2Button } from "@/components/ui-v2";
import type { ChatContinuationControl } from "@/components/app-shell/useChatContinuation";
import type { ChatWorkspaceState } from "@/lib/contracts/workspace";

export function ChatContextIndicatorV2({ stats, continuation, continuationFiles }: Readonly<{
  stats: ComposerContextStats; continuation?: ChatContinuationControl | null;
  continuationFiles?: ChatWorkspaceState["continuationFiles"];
}>) {
  const [manualOpen, setOpen] = useState(false);
  const fillMaskId = useId();
  const open = manualOpen || Boolean(continuation?.suggested);
  const close = () => { setOpen(false); continuation?.onDismiss(); };
  const { menuRef, triggerRef } = useMenuDismissalV2<HTMLButtonElement, HTMLElement>({
    onClose: close, open
  });
  const gauge = composerContextGauge(stats);
  const label = stats.requestRejected ? "This request exceeds the model context capacity" : gauge.percent === null
    ? "Chat context size is unavailable"
    : `Chat context is approximately ${gauge.percent}% full`;
  const estimateDescription = stats.session
    ? `${stats.session.phase === "after_answer" ? "Estimated from the last request and completed answer" : "Estimated from the current request"}${stats.draftInputTokens ? ", plus your draft and attachments" : ""}.`
    : "Preliminary estimate. Tools and private context are included when a request runs.";
  const circumference = 2 * Math.PI * 9;
  const remaining = stats.safeInputBudgetTokens === null ? null :
    Math.max(0, stats.safeInputBudgetTokens - stats.approximateInputTokens);
  const count = (value: number | null) => value === null ? "Unavailable" : formatTokenCount(value);
  const continuationFailure = continuationFiles?.status === "failed"
    ? continuationFiles.reason === "source_disk_missing" ? "The source Workspace disk was already gone." :
      continuationFiles.reason === "archive_limit" ? "The project archive exceeded the Workspace limit." :
        continuationFiles.reason === "unsupported_entries" ? "The project archive contained unsupported file types." :
          continuationFiles.reason === "runner_unavailable" ? "The Workspace runner was unavailable." :
            continuationFiles.reason === "timeout" ? "The Workspace copy exceeded its time budget." :
              continuationFiles.reason === "reset_consumed" ? "Workspace was reset; the copied files will not be restored again." :
                continuationFiles.reason === "restored_disk_lost" ? "The restored Workspace disk was lost; the old copy will not be applied again." :
                  continuationFiles.reason === "interrupted" ? "The Workspace copy was interrupted." :
                "The Workspace archive could not be restored."
    : null;

  return (
    <span className="v2-chat-context">
      <button
        ref={triggerRef}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`${label}${stats.session || stats.requestRejected ? "" : ". Preliminary estimate"}`}
        className="v2-chat-context-trigger v2-focusable"
        data-context-tone={gauge.tone}
        data-context-estimate={stats.session ? "snapshot" : "preliminary"}
        data-testid="header-context-indicator"
        title={`${label}. ${estimateDescription}`}
        type="button"
        onClick={() => { if (open) close(); else setOpen(true); }}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <defs><mask id={fillMaskId} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
            <circle cx="12" cy="12" fill="none" r="9" stroke="white" strokeWidth="3"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - (gauge.fraction ?? 0))} />
          </mask></defs>
          <circle className="v2-chat-context-track" cx="12" cy="12" fill="none" r="9" strokeWidth="3"
            strokeDasharray={stats.session ? undefined : "3 3"} />
          <circle cx="12" cy="12" fill="none" r="9" stroke="currentColor" strokeWidth="3"
            mask={`url(#${fillMaskId})`} strokeDasharray={stats.session ? undefined : "3 3"} />
        </svg>
        <span>{stats.requestRejected && gauge.percent === null ? "!" : gauge.percent === null ? "?" : `${gauge.percent}%`}</span>
      </button>
      {open ? (
        <section ref={menuRef} aria-label="Chat context" className="v2-chat-context-popover" role="dialog">
          <strong>{label}.</strong>
          <p>{estimateDescription}</p>
          <p>The percentage estimates how much of the full model context window is used. Space for its next answer is reserved; the answer reserve and safety margin reduce the safe input budget.</p>
          {gauge.tone === "critical" ? <p role="alert">{stats.requestRejected ? "The server could not fit this request in the model context window." : "There is no safe input room for the current request."} Shorten the message, remove attachments, or continue in a new chat with a summary.</p> : null}
          {gauge.tone === "warning" ? <p>The safe input budget is nearly full. You can keep working here or continue in a new chat with a summary.</p> : null}
          {continuation ? <div className="v2-chat-context-continuation">
            <p>Continue in a new chat with a short summary of this conversation. Your composer settings, unsent text and attached files come along. When Workspace is on, its project files are copied too. Earlier messages and their attachments stay in this chat.</p>
            {continuation.uploading ? <p role="status">Wait for uploads to finish.</p> : null}
            {continuation.error ? <p role="alert">{continuation.error}</p> : null}
            {continuation.busy ? <>
              <p role="status">{continuation.progress ?? "Preparing your summary…"}</p>
              <UiV2Button onClick={continuation.onCancel}>Cancel</UiV2Button>
            </> : <div className="v2-chat-context-actions">
              <UiV2Button tone="primary" disabled={continuation.uploading} onClick={continuation.onContinue}>Summarize and open new chat</UiV2Button>
              <UiV2Button onClick={close}>Stay here</UiV2Button>
            </div>}
          </div> : null}
          {continuationFiles ? <p role={continuationFiles.status === "failed" ? "alert" : "status"}>
            {continuationFiles.status === "ready" ? "Workspace project files were restored in this chat." :
              continuationFiles.status === "pending" ? "Workspace project files are waiting to be restored." :
                continuationFiles.status === "failed" ? `Workspace starts without the previous chat’s project files. ${continuationFailure}` :
                  "The previous chat had no Workspace project disk to copy."}
          </p> : null}
          {stats.session?.droppedMessages ? <p>{stats.session.droppedMessages} earlier {stats.session.droppedMessages === 1 ? "message is" : "messages are"} still in this chat, but were omitted from the model request. You can continue in a new chat with a summary.</p> : null}
          <details>
            <summary>Advanced details</summary>
            <dl>
              <div><dt>Context tokens</dt><dd>~{count(stats.approximateInputTokens)}</dd></div>
              {stats.session ? <>
                <div><dt>{stats.session.phase === "after_answer" ? "Request and answer estimate" : "Request estimate"}</dt><dd>~{count(stats.session.approximateInputTokens)}</dd></div>
                <div><dt>Draft and attachments estimate</dt><dd>~{count(stats.draftInputTokens ?? 0)}</dd></div>
              </> : null}
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
