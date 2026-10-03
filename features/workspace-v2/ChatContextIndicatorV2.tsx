"use client";

import { useCallback, useId, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { composerContextGauge, type ComposerContextStats } from "@/components/app-shell/composerContextStats";
import { formatTokenCount } from "@/components/app-shell/shellFormatting";
import { useMenuDismissalV2 } from "@/components/ui-v2/useMenuDismissalV2";
import { useModalLayerV2 } from "@/components/ui-v2/useModalLayerV2";
import { UiV2Button, UiV2IconButton, type UiV2MenuAction } from "@/components/ui-v2";
import type { ChatContinuationControl } from "@/components/app-shell/useChatContinuation";
import type { ChatWorkspaceState } from "@/lib/contracts/workspace";
import type { ChatUsageStats } from "@/lib/contracts/chats";
import { costCoverageNote, formatEstimatedCostMicros } from "@/lib/domain/formatEstimatedCost";

/** The description of a gauge, or of the phone "⋯", that marks a suggested continuation. */
export const CONTINUATION_SUGGESTED_DESCRIPTION = "Continuing in a new chat with a summary is suggested";

/** Below this width the header has no room for the gauge (workspace.css). */
const PHONE_QUERY = "(max-width: 767px)";

function phoneSnapshot(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(PHONE_QUERY).matches;
}

function subscribeToPhone(change: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => undefined;
  const media = window.matchMedia(PHONE_QUERY);
  media.addEventListener?.("change", change);
  return () => media.removeEventListener?.("change", change);
}

/**
 * The chat context panel of one chat. Phones have no gauge: the header "⋯"
 * entry opens the panel as a bottom sheet, and so does each request the model
 * context rejects. The panel closes when another chat opens.
 */
export function useChatContextPanelV2(chatKey: string | null, stats: ComposerContextStats | null | undefined) {
  const sheet = useSyncExternalStore(subscribeToPhone, phoneSnapshot, () => false);
  const rejected = Boolean(stats?.requestRejected);
  const [state, setState] = useState({ chatKey, open: false, rejected });
  // A chat that only now gets its id (a reload, a first message) keeps the panel.
  if (state.chatKey !== chatKey) setState({ chatKey, open: state.chatKey === null && state.open, rejected });
  else if (state.rejected !== rejected) setState({ chatKey, open: state.open || (rejected && sheet), rejected });
  const setOpen = useCallback((open: boolean) => setState((current) => ({ ...current, open })), []);
  const gauge = stats ? composerContextGauge(stats) : null;
  const menuAction: UiV2MenuAction | null = stats && gauge ? {
    icon: "chart",
    label: gauge.percent !== null ? `Context · ${gauge.percent}%` : stats.requestRejected ? "Context · too large" : "Context",
    mobileOnly: true,
    onSelect: () => setOpen(true),
    ...(gauge.tone === "warning" || gauge.tone === "critical" ? { tone: gauge.tone } : {})
  } : null;
  return { menuAction, open: state.chatKey === chatKey && state.open, setOpen, sheet };
}

function ChatContextSheetV2({ children, onClose, panelRef }: Readonly<{
  children: ReactNode;
  onClose(): void;
  /**
   * The popover's dismissal target: a popover that turns into the sheet (the
   * window narrowed) still owns the focus the sheet takes, so it stays open.
   */
  panelRef: RefObject<HTMLElement | null>;
}>) {
  const { dialogRef, initialFocusRef, onDialogKeyDown, portalReady } = useModalLayerV2({ onClose });
  if (!portalReady) return null;
  return createPortal(
    <div className="v2-chat-context-sheet-layer">
      <button
        aria-label="Close chat context"
        className="v2-chat-context-sheet-scrim"
        tabIndex={-1}
        type="button"
        onClick={onClose}
      />
      <section
        aria-label="Chat context"
        aria-modal="true"
        className="v2-chat-context-popover"
        data-layout="sheet"
        ref={(node) => { dialogRef.current = node; panelRef.current = node; }}
        role="dialog"
        onKeyDown={onDialogKeyDown}
      >
        <div className="v2-chat-context-sheet-bar">
          <span aria-hidden="true" className="v2-chat-context-sheet-handle" />
          <UiV2IconButton icon="close" label="Close chat context" ref={initialFocusRef} onClick={onClose} />
        </div>
        {children}
      </section>
    </div>,
    document.body
  );
}

/**
 * The header's context gauge and its panel: an anchored popover beside the
 * gauge, or a bottom sheet on phones (`sheet`), where the gauge stays hidden
 * and the header "⋯" menu opens the panel instead. A suggested continuation
 * only marks the gauge (and "⋯" on phones); the panel opens on click, so it
 * never covers the answer by itself.
 */
export function ChatContextIndicatorV2({
  stats, usageStats, continuation, continuationFiles, open: openProp, onOpenChange, sheet = false
}: Readonly<{
  stats: ComposerContextStats; continuation?: ChatContinuationControl | null;
  usageStats?: ChatUsageStats | null;
  continuationFiles?: ChatWorkspaceState["continuationFiles"];
  /** Opened by the person; owned by the header (`useChatContextPanelV2`) when given. */
  open?: boolean;
  onOpenChange?(open: boolean): void;
  sheet?: boolean;
}>) {
  const [ownOpen, setOwnOpen] = useState(false);
  const manualOpen = openProp ?? ownOpen;
  const setOpen = onOpenChange ?? setOwnOpen;
  const fillMaskId = useId();
  const suggestedId = useId();
  const open = manualOpen;
  const suggested = Boolean(continuation?.suggested);
  // Owned here so the popover and the sheet share it across a width change;
  // a closed panel reopens folded.
  const [detailsOpen, setDetailsOpen] = useState(false);
  if (!open && detailsOpen) setDetailsOpen(false);
  const close = () => { setOpen(false); continuation?.onDismiss(); };
  const { menuRef, triggerRef } = useMenuDismissalV2<HTMLButtonElement, HTMLElement>({
    onClose: close, open: open && !sheet
  });
  const gauge = composerContextGauge(stats);
  const label = stats.requestRejected ? "This request exceeds the model context capacity" : gauge.percent === null
    ? "Chat context size is unavailable"
    : `Chat context is approximately ${gauge.percent}% full`;
  const measured = Boolean(stats.session) && stats.basis !== "preliminary";
  // "Current" only while its run is in flight; a stopped or failed run keeps
  // only its request measurement, which then describes the last request.
  const estimateDescription = !measured ? "Preliminary estimate."
    : stats.session?.phase === "request" && stats.requestInFlight ? "Based on the current request."
      : `Based on the last ${stats.session?.phase === "request" ? "request" : "reply"}${stats.draftInputTokens ? " and your draft" : ""}.${stats.basis === "settings_changed" ? " Settings changed since." : ""}`;
  const recommended = Boolean(continuation?.suggested || gauge.tone === "warning" ||
    gauge.tone === "critical" || stats.session?.droppedMessages);
  const continuationDescription = "A new chat starts with a summary of this one and takes your draft, files and settings (and Workspace files, if on). This chat stays as it is.";
  const circumference = 2 * Math.PI * 9;
  const remaining = stats.safeInputBudgetTokens === null ? null :
    Math.max(0, stats.safeInputBudgetTokens - stats.approximateInputTokens);
  const count = (value: number | null) => value === null ? "Unavailable" : formatTokenCount(value);
  const costNote = usageStats ? costCoverageNote(usageStats.knownCostRecordCount, usageStats.recordCount) : null;
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

  const panel = (
    <>
      <div aria-label="Context" role="group">
        <h2 className="v2-chat-context-group-title">Context</h2>
        <strong>{label}.</strong>
        <p>{estimateDescription}</p>
        {gauge.tone === "critical" ? <p role="alert">{stats.requestRejected ? "This request doesn't fit the model's context." : "No room left for this request."} Shorten it, remove attachments, or continue in a new chat with a summary.</p> : null}
        {gauge.tone === "warning" ? <p>Almost full. You can keep going here or continue in a new chat with a summary.</p> : null}
        {continuation ? <div className="v2-chat-context-continuation">
          {recommended ? <p>{continuationDescription}</p> : null}
          {continuation.uploading ? <p role="status">Wait for uploads to finish.</p> : null}
          {continuation.error ? <p role="alert">{continuation.error}</p> : null}
          {continuation.busy ? <>
            <p role="status">{continuation.progress ?? "Preparing your summary…"}</p>
            <UiV2Button onClick={continuation.onCancel}>Cancel</UiV2Button>
          </> : <div className="v2-chat-context-actions">
            <UiV2Button tone={recommended ? "primary" : "ghost"} disabled={continuation.uploading}
              aria-label="Summarize and open new chat" aria-description={recommended ? undefined : continuationDescription}
              data-tooltip={recommended ? undefined : continuationDescription} data-tooltip-side="top"
              onClick={continuation.onContinue}>Summarize and open new chat</UiV2Button>
            {/* Without hover the tooltip never shows; the button already carries it as its description. */}
            {recommended ? <UiV2Button onClick={close}>Stay here</UiV2Button>
              : <p aria-hidden="true" className="v2-chat-context-touch-note">{continuationDescription}</p>}
          </div>}
        </div> : null}
        {continuationFiles ? <p role={continuationFiles.status === "failed" ? "alert" : "status"}>
          {continuationFiles.status === "ready" ? "Workspace project files were restored in this chat." :
            continuationFiles.status === "pending" ? "Workspace project files are waiting to be restored." :
              continuationFiles.status === "failed" ? `Workspace starts without the previous chat’s project files. ${continuationFailure}` :
                "The previous chat had no Workspace project disk to copy."}
        </p> : null}
        {stats.session?.droppedMessages ? <p>{stats.session.droppedMessages} earlier {stats.session.droppedMessages === 1 ? "message is" : "messages are"} still in this chat, but were omitted from the model request. You can continue in a new chat with a summary.</p> : null}
        <details open={detailsOpen} onToggle={(event) => setDetailsOpen(event.currentTarget.open)}>
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
            <div><dt>Answer reserve</dt><dd>{count(stats.answerReserveTokens === undefined ? stats.session?.maxOutputTokens ?? null : stats.answerReserveTokens)}</dd></div>
            <div><dt>Safety margin</dt><dd>{count(stats.safetyMarginTokens === undefined ? stats.session?.safetyMarginTokens ?? null : stats.safetyMarginTokens)}</dd></div>
            {stats.session ? <>
              <div><dt>Loaded tools</dt><dd>{stats.session.loadedTools}</dd></div>
              <div><dt>Earlier messages omitted</dt><dd>{stats.session.droppedMessages}</dd></div>
            </> : null}
          </dl>
          <p>Share of the model&apos;s full context window. Room for the answer and a safety margin is reserved, so the usable input budget is smaller. Tools and private context are added when a request runs.</p>
        </details>
      </div>
      {usageStats?.hasCompletedAnswer && usageStats.recordCount > 0 ? <div aria-label="Spent" className="v2-chat-context-spent" role="group">
        <h2 className="v2-chat-context-group-title">Spent</h2>
        <dl>
          <div><dt>Tokens spent</dt><dd>{usageStats.totalTokens === null ? "—" : usageStats.totalTokens.toLocaleString("en-US")}</dd></div>
          <div><dt>Approximate cost</dt><dd>{formatEstimatedCostMicros(usageStats.estimatedCostMicros)}</dd></div>
        </dl>
        {costNote ? <p>{costNote}</p> : null}
        {usageStats.incompleteRecordCount > 0 ? <p>Token usage is incomplete for {usageStats.incompleteRecordCount} of {usageStats.recordCount} requests.</p> : null}
      </div> : null}
    </>
  );

  return (
    <span className="v2-chat-context">
      <button
        ref={triggerRef}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`${label}${measured || stats.requestRejected ? "" : ". Preliminary estimate"}`}
        className="v2-chat-context-trigger v2-focusable"
        data-context-tone={gauge.tone}
        data-context-estimate={measured ? "snapshot" : "preliminary"}
        data-suggested={suggested || undefined}
        aria-describedby={suggested ? suggestedId : undefined}
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
            strokeDasharray={measured ? undefined : "3 3"} />
          <circle cx="12" cy="12" fill="none" r="9" stroke="currentColor" strokeWidth="3"
            mask={`url(#${fillMaskId})`} strokeDasharray={measured ? undefined : "3 3"} />
        </svg>
        <span>{stats.requestRejected && gauge.percent === null ? "!" : gauge.percent === null ? "?" : `${gauge.percent}%`}</span>
      </button>
      {suggested ? <span hidden id={suggestedId}>{CONTINUATION_SUGGESTED_DESCRIPTION}</span> : null}
      {open && !sheet ? (
        <section ref={menuRef} aria-label="Chat context" className="v2-chat-context-popover" role="dialog">{panel}</section>
      ) : null}
      {open && sheet ? <ChatContextSheetV2 panelRef={menuRef} onClose={close}>{panel}</ChatContextSheetV2> : null}
    </span>
  );
}
