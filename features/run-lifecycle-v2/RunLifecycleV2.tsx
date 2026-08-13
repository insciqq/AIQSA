"use client";

import { UiV2Button, UiV2IconButton } from "@/components/ui-v2";
import {
  ConversationTurnV2,
  type ConversationMessageActionsV2
} from "@/features/conversation-v2/ConversationV2";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode
} from "react";
import {
  settledRunPresentationV2,
  type RunPresentationV2
} from "./runPresentation";

type MaybePromise = Promise<unknown> | unknown;

function RunActivityLineV2({ presentation }: { presentation: RunPresentationV2 }) {
  if (presentation.kind !== "activity" || !presentation.activity) return null;

  return (
    <div
      className="v2-run-status-line"
      data-activity={presentation.activity.kind}
      data-testid="run-status-line"
    >
      <span className="v2-run-spinner" aria-hidden="true" />
      <span>{presentation.activity.label}</span>
    </div>
  );
}

function RunConnectionLossV2({
  onRefresh
}: {
  onRefresh?(): MaybePromise;
}) {
  const [refreshing, setRefreshing] = useState(false);

  async function refresh() {
    if (!onRefresh || refreshing) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } catch {
      // The source owner keeps the connection-loss state visible and retryable.
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="v2-run-connection" data-testid="run-connection-lost">
      <span className="v2-run-connection-mark" aria-hidden="true" />
      <span>Connection lost</span>
      <span aria-hidden="true">·</span>
      <button
        className="v2-focusable"
        type="button"
        disabled={!onRefresh || refreshing}
        aria-busy={refreshing || undefined}
        onClick={() => void refresh()}
      >
        {refreshing ? "Refreshing…" : "Refresh"}
      </button>
    </div>
  );
}

function RunCancelledV2({ onRegenerate }: { onRegenerate?(): void }) {
  return (
    <div className="v2-run-terminal-strip" data-kind="cancelled">
      <span className="v2-run-stop-mark" aria-hidden="true" />
      <span>Stopped</span>
      {onRegenerate ? (
        <UiV2Button onClick={onRegenerate}>Regenerate</UiV2Button>
      ) : null}
    </div>
  );
}

function RunErrorV2({
  onRegenerate,
  onRetry,
  onSelectModel,
  presentation
}: {
  onRegenerate?(): void;
  onRetry?(): void;
  onSelectModel?(): void;
  presentation: RunPresentationV2;
}) {
  if (
    (presentation.kind !== "recoverable_error" && presentation.kind !== "terminal_error") ||
    !presentation.failure
  ) {
    return null;
  }

  const recoverable = presentation.kind === "recoverable_error";
  return (
    <section
      className="v2-run-error-card"
      data-kind={presentation.kind}
      aria-label={recoverable ? "Answer interrupted by an error" : "Run failed"}
    >
      <div className="v2-run-error-heading">
        <h2>{recoverable ? "Answer interrupted by a provider error" : "Request not completed"}</h2>
        {presentation.failure.code ? (
          <code>{presentation.failure.code}</code>
        ) : null}
      </div>
      <p>{presentation.failure.message}</p>
      <div className="v2-run-error-actions">
        {recoverable && onRetry ? (
          <UiV2Button onClick={onRetry}>Retry</UiV2Button>
        ) : null}
        {!recoverable && onSelectModel ? (
          <UiV2Button onClick={onSelectModel}>Choose model…</UiV2Button>
        ) : null}
        {!recoverable && onRegenerate ? (
          <UiV2Button onClick={onRegenerate}>Regenerate</UiV2Button>
        ) : null}
      </div>
    </section>
  );
}

export type RunAnswerV2Props = Readonly<{
  actions?: ConversationMessageActionsV2;
  actionsSlot?: ReactNode;
  anchorId?: string;
  content: string;
  onRefresh?(): MaybePromise;
  onRegenerate?(): void;
  onRetry?(): void;
  onSelectModel?(): void;
  presentation: RunPresentationV2;
}>;

export function RunAnswerV2({
  actions,
  actionsSlot,
  anchorId,
  content,
  onRefresh,
  onRegenerate,
  onRetry,
  onSelectModel,
  presentation
}: RunAnswerV2Props) {
  const beforeContent = presentation.kind === "activity"
    ? <RunActivityLineV2 presentation={presentation} />
    : null;
  const afterContent = (
    <>
      {presentation.kind === "connection_lost" ? (
        <RunConnectionLossV2 onRefresh={onRefresh} />
      ) : null}
      {presentation.kind === "cancelled" ? (
        <RunCancelledV2 onRegenerate={onRegenerate} />
      ) : null}
      <RunErrorV2
        onRegenerate={onRegenerate}
        onRetry={onRetry}
        onSelectModel={onSelectModel}
        presentation={presentation}
      />
      {actionsSlot}
    </>
  );

  return (
    <ConversationTurnV2
      actions={actions}
      afterContent={afterContent}
      anchorId={anchorId}
      beforeContent={beforeContent}
      className={`v2-run-answer v2-run-answer-${presentation.kind}`}
      content={content}
      hideEmptyContent={!content.trim() && presentation.kind !== "idle"}
      role="assistant"
      streaming={presentation.kind === "streaming"}
    />
  );
}

export type RunComposerActionV2Props = Readonly<{
  active: boolean;
  onSend?(): void;
  onStop?(runId: string): void;
  runId: string | null;
  sendDisabled?: boolean;
  sendDisabledReason?: string | null;
  stopping?: boolean;
}>;

export function RunComposerActionV2({
  active,
  onSend,
  onStop,
  runId,
  sendDisabled = false,
  sendDisabledReason = null,
  stopping = false
}: RunComposerActionV2Props) {
  const unavailableDescriptionId = useId();

  if (!active) {
    return (
      <>
        <UiV2IconButton
          icon="arrow-up"
          label="Send message"
          title={sendDisabled && sendDisabledReason ? sendDisabledReason : "Send message"}
          disabled={sendDisabled || !onSend}
          aria-describedby={sendDisabled && sendDisabledReason ? unavailableDescriptionId : undefined}
          onClick={onSend}
          round
        />
        {sendDisabled && sendDisabledReason ? (
          <span className="v2-sr-only" id={unavailableDescriptionId}>
            {sendDisabledReason}
          </span>
        ) : null}
      </>
    );
  }

  const unavailable = !runId || !onStop;
  const unavailableReason = !runId
    ? "The run is not yet acknowledged by the server."
    : "Stopping this run is unavailable.";
  return (
    <>
      <UiV2IconButton
        icon="stop"
        label="Stop answer"
        title={unavailable ? unavailableReason : "Stop answer"}
        disabled={unavailable || stopping}
        aria-busy={stopping || undefined}
        aria-describedby={unavailable ? unavailableDescriptionId : undefined}
        onClick={() => {
          if (runId) onStop?.(runId);
        }}
        round
      />
      {unavailable ? (
        <span className="v2-sr-only" id={unavailableDescriptionId}>
          {unavailableReason}
        </span>
      ) : null}
    </>
  );
}

function announcementFor(presentation: RunPresentationV2): string {
  switch (presentation.kind) {
    case "activity":
      return presentation.activity?.label ?? "";
    case "streaming":
      return "Writing answer…";
    case "connection_lost":
      return "Connection lost. Refresh the run state.";
    case "complete":
      return "Answer ready. The message field is available.";
    case "cancelled":
      return "Run stopped. The message field is available.";
    case "recoverable_error":
    case "terminal_error":
      return "Run failed. The message field is available.";
    case "idle":
      return "";
  }
}

export function RunLifecycleAnnouncerV2({
  activeChatId,
  presentation,
  sourceChatId
}: {
  activeChatId: string | null;
  presentation: RunPresentationV2;
  sourceChatId: string;
}) {
  const [announcement, setAnnouncement] = useState("");
  const previousRef = useRef<{
    activeChatId: string | null;
    selected: boolean;
    signature: string;
    sourceChatId: string;
  } | null>(null);
  const selected = activeChatId === sourceChatId;
  const signature = `${presentation.kind}:${presentation.activity?.label ?? ""}`;

  useEffect(() => {
    const previous = previousRef.current;
    const continuouslySelected = Boolean(
      selected &&
      previous?.selected &&
      previous.activeChatId === activeChatId &&
      previous.sourceChatId === sourceChatId
    );

    if (!selected || (settledRunPresentationV2(presentation) && !continuouslySelected)) {
      setAnnouncement("");
    } else if (!previous || previous.signature !== signature || !previous.selected) {
      setAnnouncement(announcementFor(presentation));
    }

    previousRef.current = { activeChatId, selected, signature, sourceChatId };
  }, [activeChatId, presentation, selected, signature, sourceChatId]);

  return (
    <p
      className="v2-sr-only"
      data-testid="run-lifecycle-announcer"
      aria-atomic="true"
      aria-live="polite"
    >
      {announcement}
    </p>
  );
}
