import {
  CitationBlock,
  ContextTruncationBlock,
  ReasoningBlock,
  SearchSummaryBlock,
  ToolActivityBlock
} from "@/components/app-shell/ThreadArtifacts";
import { RunReceipt } from "@/components/app-shell/RunReceipt";
import {
  deriveRunReceipt,
  type RunReceiptSegmentKind
} from "@/components/app-shell/runReceipt";
import { runActivityLabel, type PipelineSnapshot } from "@/components/app-shell/runState";
import {
  attachmentBlocksFromThreadContent,
  textFromThreadContent
} from "@/components/app-shell/threadContent";
import type {
  PersistedRun,
  ThreadArtifactSummary,
  ThreadMessage
} from "@/components/app-shell/types";
import { MarkdownMessage } from "@/components/chat/MarkdownMessage";
import {
  CircleAlert,
  Copy,
  FileText,
  GitBranch,
  Image as ImageIcon,
  Pencil,
  RefreshCw,
  Square,
  Trash2
} from "lucide-react";
import { memo, type ReactNode, useState } from "react";

const ghostActionClass =
  "grid size-11 place-items-center rounded-control text-ink-muted outline-none hover:bg-control-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-proof/45 disabled:cursor-not-allowed disabled:text-ink-disabled disabled:opacity-50 sm:size-9 [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11";

// Reserved-height strip; reveal is opacity-only so hover never shifts layout.
const actionStripClass =
  "flex min-h-11 items-center gap-0.5 opacity-0 transition-opacity duration-100 focus-within:opacity-100 group-hover/turn:opacity-100 [@media(hover:none)]:!min-h-11 [@media(hover:none)]:opacity-100 [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:opacity-100 sm:min-h-9";

type InlineReceiptDisclosure = "citations" | "reasoning" | "search" | "tools";

function ThreadRunActivity({ pipeline }: { pipeline: PipelineSnapshot }) {
  const label = runActivityLabel(pipeline);
  const error = pipeline.phase === "error";

  return (
    <div
      className={`pipeline-indicator mb-4 inline-flex min-h-5 items-center gap-2 text-xs font-medium ${error ? "text-critical" : "text-ink-secondary"}`}
      data-phase={pipeline.phase}
      data-testid="thread-run-activity"
      role="status"
      aria-label={`Run status: ${label}`}
    >
      {error ? (
        <CircleAlert className="size-3.5 shrink-0" aria-hidden="true" />
      ) : (
        <span className="size-2 shrink-0 rounded-full bg-proof" data-run-activity aria-hidden="true" />
      )}
      <span>
        {label}
        {error ? "" : "…"}
      </span>
    </div>
  );
}

function turnActionDescription(message: ThreadMessage): string {
  const role = message.role === "user" ? "Question" : "Answer";
  const content = textFromThreadContent(message.content).replace(/\s+/g, " ").trim();
  const attachments =
    message.role === "user" ? attachmentBlocksFromThreadContent(message.content) : [];
  const fallback =
    attachments.length > 0
      ? `${attachments.length} ${attachments.length === 1 ? "attachment" : "attachments"}`
      : "No text";
  const summary = content || fallback;
  const preview = summary.length > 72 ? `${summary.slice(0, 69).trimEnd()}…` : summary;

  return `${role}: ${preview}`;
}

function TurnActions({
  disabledDescriptionId,
  editPending,
  editPendingDescriptionId,
  message,
  onBranchFromMessage,
  onCopyMessage,
  onDeleteMessage,
  onEditMessage,
  onRegenerateMessage,
  streaming,
  targetDescriptionId
}: {
  disabledDescriptionId: string;
  editPending: boolean;
  editPendingDescriptionId: string;
  message: ThreadMessage;
  onBranchFromMessage(messageId: string): void;
  onCopyMessage(message: ThreadMessage): void;
  onDeleteMessage(messageId: string): void;
  onEditMessage(message: ThreadMessage): void;
  onRegenerateMessage(messageId: string): void;
  streaming: boolean;
  targetDescriptionId: string;
}): ReactNode {
  const mutableActionDescriptionIds = streaming
    ? `${targetDescriptionId} ${disabledDescriptionId}`
    : targetDescriptionId;
  const editActionDescriptionIds = editPending
    ? `${mutableActionDescriptionIds} ${editPendingDescriptionId}`
    : mutableActionDescriptionIds;

  return (
    <>
      {message.role === "assistant" ? (
        <button
          aria-label="Regenerate message"
          aria-describedby={mutableActionDescriptionIds}
          className={`${ghostActionClass} hover:text-proof`}
          disabled={streaming}
          title={streaming ? "Regenerate is disabled while a response is streaming" : "Regenerate message"}
          type="button"
          onClick={() => onRegenerateMessage(message.id)}
        >
          <RefreshCw className="size-3.5" aria-hidden="true" />
        </button>
      ) : null}
      {message.role === "user" || message.role === "assistant" ? (
        <button
          aria-label="Edit message"
          aria-describedby={editActionDescriptionIds}
          className={`${ghostActionClass} hover:text-proof`}
          disabled={streaming || editPending}
          title={
            streaming
              ? "Edit is disabled while a response is streaming"
              : editPending
                ? "Edit is disabled while another edited branch is saving"
                : "Edit message"
          }
          type="button"
          onClick={() => onEditMessage(message)}
        >
          <Pencil className="size-3.5" aria-hidden="true" />
        </button>
      ) : null}
      <button
        aria-label="Copy message"
        aria-describedby={targetDescriptionId}
        className={`${ghostActionClass} hover:text-proof`}
        title="Copy message"
        type="button"
        onClick={() => onCopyMessage(message)}
      >
        <Copy className="size-3.5" aria-hidden="true" />
      </button>
      <button
        aria-label="Delete message"
        aria-describedby={mutableActionDescriptionIds}
        className={`${ghostActionClass} hover:text-critical`}
        disabled={streaming}
        title={streaming ? "Delete is disabled while a response is streaming" : "Delete message"}
        type="button"
        onClick={() => onDeleteMessage(message.id)}
      >
        <Trash2 className="size-3.5" aria-hidden="true" />
      </button>
      <button
        aria-label="Branch from here"
        aria-describedby={mutableActionDescriptionIds}
        className={`${ghostActionClass} hover:text-proof`}
        disabled={streaming}
        title={streaming ? "Branching is disabled while a response is streaming" : "Branch from here"}
        type="button"
        onClick={() => onBranchFromMessage(message.id)}
      >
        <GitBranch className="size-3.5" aria-hidden="true" />
      </button>
    </>
  );
}

function ThreadMessageRowComponent({
  answerModelLabel,
  artifactSummary,
  editPending = false,
  justCompleted = false,
  message,
  onBranchFromMessage,
  onCopyMessage,
  onDeleteMessage,
  onEditMessage,
  onOpenRunDetails,
  onRegenerateMessage,
  persistedRun = null,
  runActivity = null,
  runWarnings = [],
  showCitations,
  showReasoningBlocks,
  showToolActivity,
  streaming
}: {
  answerModelLabel: string | null;
  artifactSummary?: ThreadArtifactSummary | null;
  editPending?: boolean;
  justCompleted?: boolean;
  message: ThreadMessage;
  onBranchFromMessage(messageId: string): void;
  onCopyMessage(message: ThreadMessage): void;
  onDeleteMessage(messageId: string): void;
  onEditMessage(message: ThreadMessage): void;
  onOpenRunDetails(): void;
  onRegenerateMessage(messageId: string): void;
  persistedRun?: PersistedRun | null;
  runActivity?: PipelineSnapshot | null;
  runWarnings?: string[];
  showCitations: boolean;
  showReasoningBlocks: boolean;
  showToolActivity: boolean;
  streaming: boolean;
}) {
  const disabledDescriptionId = `message-actions-disabled-${message.id}`;
  const editPendingDescriptionId = `message-edit-pending-${message.id}`;
  const targetDescriptionId = `message-actions-target-${message.id}`;
  const [expandedDisclosures, setExpandedDisclosures] = useState<ReadonlySet<InlineReceiptDisclosure>>(
    () => new Set()
  );
  const hasInlineSearch = Boolean(artifactSummary?.searchCount) && runActivity?.search !== "active";
  const hasInlineTools = showToolActivity && Boolean(artifactSummary?.toolCalls.length);
  const hasInlineCitations = showCitations && Boolean(artifactSummary?.citationCount);
  const hasInlineReasoning = showReasoningBlocks && Boolean(artifactSummary?.reasoningCount);
  const hasExactRunEvents = Boolean(
    message.runId &&
    persistedRun?.id === message.runId &&
    persistedRun.events.length > 0
  );
  function changeDisclosure(kind: InlineReceiptDisclosure, expanded: boolean) {
    setExpandedDisclosures((current) => {
      const next = new Set(current);
      if (expanded) {
        next.add(kind);
      } else {
        next.delete(kind);
      }
      return next;
    });
  }
  function activateReceiptSegment(kind: RunReceiptSegmentKind) {
    if (kind === "search" && hasInlineSearch) {
      changeDisclosure("search", true);
      return;
    }
    if (kind === "tools" && hasInlineTools) {
      changeDisclosure("tools", true);
      return;
    }
    if (kind === "citations" && hasInlineCitations) {
      changeDisclosure("citations", true);
      return;
    }
    if (kind === "reasoning" && hasInlineReasoning) {
      changeDisclosure("reasoning", true);
      return;
    }
    if (hasExactRunEvents) {
      onOpenRunDetails();
    }
  }
  const actionTargetDescription = turnActionDescription(message);
  const actions = (
    <TurnActions
      disabledDescriptionId={disabledDescriptionId}
      editPending={editPending}
      editPendingDescriptionId={editPendingDescriptionId}
      message={message}
      streaming={streaming}
      onBranchFromMessage={onBranchFromMessage}
      onCopyMessage={onCopyMessage}
      onDeleteMessage={onDeleteMessage}
      onEditMessage={onEditMessage}
      onRegenerateMessage={onRegenerateMessage}
      targetDescriptionId={targetDescriptionId}
    />
  );
  const contentText = textFromThreadContent(message.content);
  const attachmentBlocks = message.role === "user" ? attachmentBlocksFromThreadContent(message.content) : [];
  const disabledDescription = streaming ? (
    <span className="sr-only" id={disabledDescriptionId}>
      Editing, deleting, branching, and regenerating are unavailable while a response is streaming.
    </span>
  ) : null;
  const editPendingDescription = editPending ? (
    <span className="sr-only" id={editPendingDescriptionId}>
      Another edited branch is saving. Wait for it to finish before editing a message.
    </span>
  ) : null;

  if (message.role === "user") {
    return (
      <article
        className="group/turn px-4 pb-2 pt-8 sm:px-6"
        data-message-id={message.id}
        data-role="user"
        data-status={message.status}
        aria-label="Question"
      >
        <div className="mx-auto w-full max-w-reading">
          <div
            className="ml-auto w-fit max-w-[min(36rem,88%)] break-words rounded-panel bg-control-surface px-4 py-3 text-[15px] leading-6 text-ink [overflow-wrap:anywhere]"
            data-thread-message-content="true"
          >
            {contentText ? <MarkdownMessage content={contentText} /> : null}
            {attachmentBlocks.length > 0 ? (
              <ul
                className={contentText ? "mt-3 flex flex-wrap gap-1.5" : "flex flex-wrap gap-1.5"}
                aria-label="Message attachments"
              >
                {attachmentBlocks.map((attachment) => (
                  <li
                    className="inline-flex min-h-control-sm max-w-[min(15rem,100%)] items-center gap-1.5 rounded-control bg-control-pressed px-2 text-xs leading-4 text-ink-secondary"
                    key={`${attachment.type}-${attachment.attachmentId}`}
                    title={attachment.label}
                  >
                    {attachment.type === "image" ? (
                      <ImageIcon className="size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
                    ) : (
                      <FileText className="size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
                    )}
                    <span className="truncate">{attachment.label}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <div
            className={`ml-auto w-fit justify-end ${actionStripClass}`}
            data-testid="message-actions"
            role="toolbar"
            aria-label="User message actions"
            aria-describedby={targetDescriptionId}
          >
            <span className="sr-only" id={targetDescriptionId}>
              {actionTargetDescription}
            </span>
            {disabledDescription}
            {editPendingDescription}
            {actions}
          </div>
        </div>
      </article>
    );
  }

  const receipt = deriveRunReceipt({
    artifactSummary,
    messageStatus: message.status,
    messageRunId: message.runId,
    modelLabel: answerModelLabel,
    persistedRun,
    runActivity,
    warningCount: runWarnings.length
  });
  const actionableReceiptSegments = new Set<RunReceiptSegmentKind>();
  if (hasExactRunEvents) {
    actionableReceiptSegments.add("status");
    for (const fact of receipt.facts) {
      actionableReceiptSegments.add(fact.kind);
    }
  }
  if (hasInlineSearch) actionableReceiptSegments.add("search");
  if (hasInlineTools) actionableReceiptSegments.add("tools");
  if (hasInlineCitations) actionableReceiptSegments.add("citations");
  if (hasInlineReasoning) actionableReceiptSegments.add("reasoning");

  return (
    <article
      className="group/turn px-4 pb-8 pt-2 sm:px-6"
      data-message-id={message.id}
      data-role="assistant"
      data-status={message.status}
      aria-label="Answer"
      aria-busy={message.status === "streaming" || undefined}
    >
      <div className="mx-auto w-full max-w-reading">
        {message.status === "streaming" && answerModelLabel ? (
          <div
            className="mb-3 truncate text-xs leading-5 text-ink-muted"
            title={answerModelLabel}
          >
            {answerModelLabel}
          </div>
        ) : null}
        {runActivity ? <ThreadRunActivity pipeline={runActivity} /> : null}
        <div
          className="min-w-0 text-[16px] leading-[1.68] text-ink sm:text-[17px]"
          data-thread-message-content="true"
          data-testid="assistant-message-content"
        >
          {artifactSummary?.contextTruncation ? <ContextTruncationBlock summary={artifactSummary} /> : null}

          {message.status === "error" ? (
            <div
              className="border-l-2 border-critical/45 bg-critical/[0.05] px-4 py-3 text-sm leading-6 text-ink-secondary"
              data-testid="assistant-error-state"
              role="alert"
            >
              <div className="mb-1 flex items-center gap-2 font-semibold text-critical">
                <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
                Response failed
              </div>
              <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                {contentText || "The provider did not return an answer."}
              </p>
            </div>
          ) : (
            <>
              {contentText && !(message.status === "cancelled" && contentText === "Stopped.") ? (
                <MarkdownMessage content={contentText} streaming={message.status === "streaming"} />
              ) : null}
              {message.status === "streaming" && !contentText && !runActivity ? (
                <div
                  className="flex min-h-12 items-center gap-2 text-sm text-ink-secondary"
                  data-testid="assistant-pending-state"
                  role="status"
                >
                  <span className="size-2 animate-pulse rounded-full bg-proof" aria-hidden="true" />
                  Working…
                </div>
              ) : null}
              {message.status === "streaming" && contentText ? (
                <>
                  <span className="sr-only" role="status">Answer streaming</span>
                  <span
                    className="ml-1 inline-block h-4 w-1 animate-pulse bg-proof align-[-2px]"
                    data-testid="streaming-cursor"
                    aria-hidden="true"
                  />
                </>
              ) : null}
              {message.status === "cancelled" ? (
                <div
                  className={[
                    "flex items-center gap-2 text-xs text-ink-muted",
                    contentText && contentText !== "Stopped." ? "mt-3" : ""
                  ].join(" ")}
                  data-testid="assistant-cancelled-state"
                  role="status"
                >
                  <Square className="size-3 fill-current" aria-hidden="true" />
                  Response stopped
                </div>
              ) : null}
              {message.status === "complete" && !contentText ? (
                <p className="text-sm italic text-ink-muted" data-testid="assistant-empty-state">
                  No answer text was returned.
                </p>
              ) : null}
            </>
          )}

          {artifactSummary?.searchCount && runActivity?.search !== "active" ? (
            <div className={contentText || message.status !== "streaming" ? "mt-5" : undefined}>
              <SearchSummaryBlock
                expanded={expandedDisclosures.has("search")}
                summary={artifactSummary}
                onExpandedChange={(expanded) => changeDisclosure("search", expanded)}
              />
            </div>
          ) : null}
          {showToolActivity && artifactSummary?.toolCallCount ? (
            <div className="mt-5">
              <ToolActivityBlock
                expanded={expandedDisclosures.has("tools")}
                summary={artifactSummary}
                onExpandedChange={(expanded) => changeDisclosure("tools", expanded)}
              />
            </div>
          ) : null}
          {showCitations && artifactSummary?.citationCount ? (
            <div className="mt-5">
              <CitationBlock
                expanded={expandedDisclosures.has("citations")}
                summary={artifactSummary}
                onExpandedChange={(expanded) => changeDisclosure("citations", expanded)}
              />
            </div>
          ) : null}
          {showReasoningBlocks && artifactSummary?.reasoningCount ? (
            <div className="mt-5">
              <ReasoningBlock
                expanded={expandedDisclosures.has("reasoning")}
                summary={artifactSummary}
                onExpandedChange={(expanded) => changeDisclosure("reasoning", expanded)}
              />
            </div>
          ) : null}
          {runWarnings.length > 0 ? (
            <aside
              className="mt-5 border-l-2 border-caution/45 bg-caution/[0.05] px-4 py-3 text-xs leading-5 text-ink-secondary"
              data-testid="thread-run-warnings"
              aria-label="Run warnings"
            >
              <div className="flex items-center gap-2 font-semibold text-caution">
                <CircleAlert className="size-3.5 shrink-0" aria-hidden="true" />
                Run {runWarnings.length === 1 ? "warning" : "warnings"}
              </div>
              <ul className="mt-1 space-y-1 pl-5">
                {runWarnings.map((warning, index) => (
                  <li className="list-disc break-words [overflow-wrap:anywhere]" key={`${warning}-${index}`}>
                    {warning}
                  </li>
                ))}
              </ul>
            </aside>
          ) : null}
        </div>
        {message.status !== "streaming" ? (
          <RunReceipt
            actionableSegments={actionableReceiptSegments}
            receipt={receipt}
            settled={justCompleted}
            onActivate={activateReceiptSegment}
          />
        ) : null}
        <div
          className={actionStripClass}
          data-testid="message-actions"
          role="toolbar"
          aria-label="Assistant message actions"
          aria-describedby={targetDescriptionId}
        >
          <span className="sr-only" id={targetDescriptionId}>
            {actionTargetDescription}
          </span>
          {disabledDescription}
          {editPendingDescription}
          {actions}
        </div>
      </div>
    </article>
  );
}

export const ThreadMessageRow = memo(ThreadMessageRowComponent);
