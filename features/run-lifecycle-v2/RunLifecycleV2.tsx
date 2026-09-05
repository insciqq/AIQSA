"use client";

import { CHAT_PDF_LOCAL_TEXT_MULTIPLE_NOTICE, CHAT_PDF_LOCAL_TEXT_NOTICE, CHAT_PDF_LONG_DOCUMENT_NOTICE,
  type ChatPdfPreparationWire } from "@/lib/contracts/chatPdfPreparation";
import { UiV2Button, UiV2Icon, UiV2IconButton } from "@/components/ui-v2";
import { MCP_AUTO_DISCOVERY_UNAVAILABLE_CODE } from "@/lib/contracts/runs";
import type { ThreadArtifactSummary, ThreadToolActivity } from "@/lib/contracts/chats";
import type { MarkdownCitationRenderer, MarkdownHrefResolver } from "@/components/chat/MarkdownMessage";
import type { ThreadWorkspaceActivity } from "@/lib/contracts/workspace";
import { workspaceLiveLabelV2 } from "./workspaceActivityPresentation";
import { AnswerProcessV2 } from "@/features/answer-outputs-v2/AnswerProcessV2";
import { useAnswerSourcesV2 } from "@/features/answer-outputs-v2/AnswerOutputsV2";
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
  describeToolCallV2,
  settledRunPresentationV2,
  stepDurationSumV2,
  type RunPresentationV2
} from "./runPresentation";

type MaybePromise = Promise<unknown> | unknown;

type ToolCallV2 = ThreadToolActivity["calls"][number];

function runningToolLabel(activity: ThreadToolActivity): string | null {
  let call: ToolCallV2 | undefined;
  for (let index = activity.calls.length - 1; index >= 0; index -= 1) {
    if (activity.calls[index]?.status === "running") {
      call = activity.calls[index];
      break;
    }
  }
  if (!call) return null;
  return `${describeToolCallV2(call, "running")}…`;
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
  onUseLoadAll,
  pdfPreparation,
  presentation
}: {
  onRegenerate?(): void;
  onRetry?(): void;
  onSelectModel?(): void;
  onUseLoadAll?(): void;
  pdfPreparation?: readonly ChatPdfPreparationWire[];
  presentation: RunPresentationV2;
}) {
  if (
    (presentation.kind !== "recoverable_error" && presentation.kind !== "terminal_error") ||
    !presentation.failure
  ) {
    return null;
  }

  const recoverable = presentation.kind === "recoverable_error";
  const pdfFailed = pdfPreparation?.some((item) => item.phase === "failed");
  const autoDiscoveryUnavailable =
    presentation.failure.code === MCP_AUTO_DISCOVERY_UNAVAILABLE_CODE;
  // The card is a neutral surface: an alert glyph plus a plain-language
  // heading and explanation; the primary recovery action comes first and the
  // safe error code sits quietly on the right as the support reference.
  return (
    <section
      className="v2-run-error-card"
      data-kind={presentation.kind}
      aria-label={autoDiscoveryUnavailable
        ? "Automatic tool discovery is unavailable"
        : recoverable ? "Answer interrupted by an error" : "Run failed"}
    >
      <div className="v2-run-error-heading">
        <UiV2Icon name="alert" />
        <h2>{autoDiscoveryUnavailable
          ? "Automatic tool discovery is unavailable"
          : pdfFailed ? "Document preparation stopped" : recoverable ? "Answer interrupted by a provider error" : "Request not completed"}</h2>
      </div>
      <p>{presentation.failure.message}</p>
      <div className="v2-run-error-actions">
        {autoDiscoveryUnavailable && onRetry ? (
          <UiV2Button icon="regenerate" tone="primary" onClick={onRetry}>Retry</UiV2Button>
        ) : null}
        {autoDiscoveryUnavailable && onUseLoadAll ? (
          <UiV2Button onClick={onUseLoadAll}>Use Load all</UiV2Button>
        ) : null}
        {!autoDiscoveryUnavailable && recoverable && onRetry ? (
          <UiV2Button icon="regenerate" tone="primary" onClick={onRetry}>Retry</UiV2Button>
        ) : null}
        {!autoDiscoveryUnavailable && !recoverable && onRegenerate ? (
          <UiV2Button icon="regenerate" tone="primary" onClick={onRegenerate}>Regenerate</UiV2Button>
        ) : null}
        {!pdfFailed && !autoDiscoveryUnavailable && !recoverable && onSelectModel ? (
          <UiV2Button onClick={onSelectModel}>Choose model…</UiV2Button>
        ) : null}
        {presentation.failure.code ? (
          <span className="v2-run-error-reference">
            Support reference <code>{presentation.failure.code}</code>
          </span>
        ) : null}
      </div>
    </section>
  );
}

export type RunAnswerV2Props = Readonly<{
  pdfPreparation?: readonly ChatPdfPreparationWire[];
  onStop?(): void;
  actions?: ConversationMessageActionsV2;
  /** Quiet status lines between the body and the actions row. */
  actionsSlot?: ReactNode;
  anchorId?: string;
  /** Settled answer outputs: Sources chip + list and the process fold's memory rows. */
  artifact?: ThreadArtifactSummary | null;
  content: string;
  knowledgeReference?: Readonly<{ messageId: string; runId: string }>;
  /** Identity, rendered above the process line. */
  leadingSlot?: ReactNode;
  /** The memory-saved notice, rendered under the process line and above the text. */
  noticeSlot?: ReactNode;
  onRefresh?(): MaybePromise;
  onRegenerate?(): void;
  onRetry?(): void;
  onSelectModel?(): void;
  onUseLoadAll?(): void;
  presentation: RunPresentationV2;
  renderCitation?: MarkdownCitationRenderer;
  /** Resolves model-written Workspace output links to authorized downloads or inert text. */
  resolveHref?: MarkdownHrefResolver;
  showReasoning?: boolean;
  /** Leading toolbar controls (the branch pager) placed before the Sources chip. */
  toolbarLeading?: ReactNode;
  toolActivity?: ThreadToolActivity | null;
  /** Send → first answer token; the live value while streaming, the persisted one once settled. */
  workDurationMs?: number | null;
  workspaceActivity?: ThreadWorkspaceActivity | null;
}>;

export function RunAnswerV2({
  actions,
  actionsSlot,
  anchorId,
  artifact = null,
  content,
  knowledgeReference,
  leadingSlot = null,
  noticeSlot = null,
  onRefresh,
  onRegenerate,
  onRetry,
  onSelectModel,
  onUseLoadAll,
  presentation,
  pdfPreparation,
  onStop,
  renderCitation,
  resolveHref,
  showReasoning = true,
  toolbarLeading = null,
  toolActivity = null,
  workDurationMs = null,
  workspaceActivity = null
}: RunAnswerV2Props) {
  const settled = settledRunPresentationV2(presentation);
  const sources = useAnswerSourcesV2({
    artifact: settled ? artifact : null,
    knowledgeReference
  });
  // The live status occupies the process line's slot until the first answer
  // token; from then on the same line is the fold with whatever settled facts
  // exist (steps, then reasoning and memory once the artifact summary lands).
  const liveLabel = presentation.kind === "activity"
    ? workspaceLiveLabelV2(workspaceActivity) ??
      (toolActivity ? runningToolLabel(toolActivity) : null) ??
      presentation.activity?.label ?? "Thinking…"
    : null;
  const process = (
    <AnswerProcessV2
      liveLabel={liveLabel}
      memorySources={settled ? artifact?.memorySources ?? [] : []}
      reasoningTexts={settled && showReasoning ? artifact?.reasoningText ?? [] : []}
      toolActivity={toolActivity}
      workDurationMs={workDurationMs ?? artifact?.workDurationMs ?? stepDurationSumV2(toolActivity)}
      workspaceActivity={workspaceActivity}
    />
  );
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
        onUseLoadAll={onUseLoadAll}
        presentation={presentation}
        pdfPreparation={pdfPreparation}
      />
      {actionsSlot}
    </>
  );

  return (
    <ConversationTurnV2
      actions={actions}
      afterActions={sources.list}
      afterContent={afterContent}
      anchorId={anchorId}
      beforeContent={(
        <>
          {leadingSlot}
          {process}
          {pdfPreparation?.length ? (
            <div className="v2-pdf-preparation" data-testid="pdf-preparation-notices">
              {presentation.kind === "activity" && presentation.activity?.kind === "preparing" && onStop ? (
                <UiV2Button icon="stop" onClick={onStop}>Stop</UiV2Button>
              ) : null}
              {pdfPreparation.some((item) => item.longDocument) ? <p>{CHAT_PDF_LONG_DOCUMENT_NOTICE}</p> : null}
              {pdfPreparation.some((item) => item.limitedReadingQuality) ? <p>{pdfPreparation.length === 1
                ? CHAT_PDF_LOCAL_TEXT_NOTICE : CHAT_PDF_LOCAL_TEXT_MULTIPLE_NOTICE}</p> : null}
            </div>
          ) : null}
          {noticeSlot}
        </>
      )}
      className={`v2-run-answer v2-run-answer-${presentation.kind}`}
      content={content}
      hideEmptyContent={!content.trim() && presentation.kind !== "idle"}
      role="assistant"
      renderCitation={renderCitation}
      resolveHref={resolveHref}
      streaming={presentation.kind === "streaming"}
      toolbarLeading={toolbarLeading || sources.chip ? (
        <>
          {toolbarLeading}
          {sources.chip}
        </>
      ) : null}
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
      return "Answering…";
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
