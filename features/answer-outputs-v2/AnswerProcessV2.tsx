"use client";

import { MarkdownMessage } from "@/components/chat/MarkdownMessage";
import { UiV2Icon } from "@/components/ui-v2";
import type { ThreadToolActivity } from "@/lib/contracts/chats";
import type { MemoryAnswerSource } from "@/lib/contracts/memoryClient";
import {
  answerProcessLabelV2,
  describeToolCallV2
} from "@/features/run-lifecycle-v2/runPresentation";
import { useId } from "react";
import { MemorySourceRowV2 } from "./AnswerOutputsV2";

type ToolCallV2 = ThreadToolActivity["calls"][number];

function toolDuration(durationMs: number | undefined): string | null {
  if (durationMs === undefined) return null;
  return durationMs < 1_000
    ? `${durationMs} ms`
    : `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)} s`;
}

/* Meta reads "0.8 s · round 2"; only a non-complete state adds a word. */
function toolMeta(call: ToolCallV2): string {
  const parts: string[] = [];
  const duration = toolDuration(call.durationMs);
  if (call.status === "error") parts.push("Failed");
  else if (call.status === "cancelled") parts.push("Stopped");
  if (duration) parts.push(duration);
  parts.push(`round ${call.round}`);
  return parts.join(" · ");
}

function ToolCallMarkV2({ status }: { status: ToolCallV2["status"] }) {
  if (status === "running") {
    return <span className="v2-answer-process-mark v2-spinner" data-status={status} aria-hidden="true" />;
  }
  return (
    <span className="v2-answer-process-mark" data-status={status} aria-hidden="true">
      {status === "complete" ? <UiV2Icon name="check" /> : null}
      {status === "error" ? <UiV2Icon name="alert" /> : null}
    </span>
  );
}

export type AnswerProcessV2Props = Readonly<{
  /** Live status while the run works; it occupies the settled line's place. */
  liveLabel?: string | null;
  memorySources?: readonly MemoryAnswerSource[];
  reasoningTexts?: readonly string[];
  toolActivity?: ThreadToolActivity | null;
  /** Send → first answer token; null when the run recorded none. */
  workDurationMs?: number | null;
}>;

/**
 * The one disclosure above an answer. While the run works it is the live
 * status ("Thinking…", "Searching the web…") in the same 28px slot; settled
 * it folds Thinking → Steps → Memory under a human label ("Worked for 8s ·
 * Used 2 memories"). A reached tool limit stays visible outside the fold.
 */
export function AnswerProcessV2({
  liveLabel = null,
  memorySources = [],
  reasoningTexts = [],
  toolActivity = null,
  workDurationMs = null
}: AnswerProcessV2Props) {
  const memoryHeadingId = `answer-memory-sources-heading-${useId()}`;
  const reasoning = reasoningTexts.map((text) => text.trim()).filter(Boolean).join("\n\n");
  const calls = toolActivity?.calls ?? [];
  const warning = toolActivity?.warning ? (
    <div className="v2-tool-budget-warning" data-kind={toolActivity.warning.kind} role="status">
      Tool {toolActivity.warning.kind === "calls" ? "call" : "round"} limit ({toolActivity.warning.limit}) stopped further tool use.
    </div>
  ) : null;

  if (liveLabel) {
    return (
      <div className="v2-answer-process" data-live="true" data-testid="run-status-line">
        <span className="v2-answer-process-slot" aria-hidden="true">
          <span className="v2-answer-process-spinner v2-spinner" />
        </span>
        <span className="v2-run-shimmer">{liveLabel}</span>
      </div>
    );
  }

  const label = answerProcessLabelV2({
    hasReasoning: reasoning.length > 0,
    memoryCount: memorySources.length,
    stepCount: calls.length,
    workDurationMs
  });
  if (!label) return warning;

  return (
    <>
      <details className="v2-answer-process" data-testid="tool-activity-disclosure">
        <summary className="v2-focusable">
          <span className="v2-answer-process-slot" aria-hidden="true">
            <span className="v2-answer-process-chevron" />
          </span>
          <span className="v2-answer-process-label">{label}</span>
        </summary>
        <div className="v2-answer-process-body">
          {reasoning ? (
            <section className="v2-answer-process-section" data-testid="answer-reasoning">
              <h3>Thinking</h3>
              <div className="v2-answer-process-reasoning">
                <MarkdownMessage content={reasoning} />
              </div>
            </section>
          ) : null}
          {calls.length > 0 ? (
            <section className="v2-answer-process-section">
              <h3>Steps</h3>
              <ol className="v2-answer-process-steps">
                {calls.map((call, index) => (
                  <li key={`${call.round}:${index}:${call.toolName}`} data-status={call.status}>
                    <ToolCallMarkV2 status={call.status} />
                    <span className="v2-answer-process-step">
                      <span className="v2-answer-process-step-name">
                        {describeToolCallV2(call, call.status === "running" ? "running" : "settled")}
                      </span>
                      <span className="v2-answer-process-step-meta">{toolMeta(call)}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
          {memorySources.length > 0 ? (
            <section
              aria-labelledby={memoryHeadingId}
              className="v2-answer-process-section v2-memory-sources"
              data-testid="answer-memory-sources"
            >
              <h3 id={memoryHeadingId}>Memory</h3>
              <div className="v2-memory-source-list">
                {memorySources.map((source, index) => (
                  <MemorySourceRowV2
                    key={source.sourceAvailable
                      ? `memory-source-${source.memoryRef}`
                      : `memory-source-${source.sourceType}-${source.date}-${index}`}
                    source={source}
                  />
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </details>
      {warning}
    </>
  );
}
