"use client";

import { MarkdownMessage } from "@/components/chat/MarkdownMessage";
import { useDisclosurePreference } from "@/components/app-shell/disclosurePreferences";
import { useState } from "react";
import { UiV2Button, UiV2Icon } from "@/components/ui-v2";
import type { ThreadToolActivity } from "@/lib/contracts/chats";
import type { MemoryAnswerSource } from "@/lib/contracts/memoryClient";
import type { ThreadWorkspaceActivity } from "@/lib/contracts/workspace";
import type { ContextCompactionStatus } from "@/lib/contracts/contextCompaction";
import {
  answerProcessLabelV2,
  contextCompactionCopyV2,
  describeToolCallV2,
  toolActivityOriginV2
} from "@/features/run-lifecycle-v2/runPresentation";
import { WorkspaceActivityTimelineV2 } from "@/features/run-lifecycle-v2/WorkspaceActivityTimelineV2";
import {
  workspaceActivityOutcomeV2,
  workspaceProcessLabelV2
} from "@/features/run-lifecycle-v2/workspaceActivityPresentation";
import { MemorySourcesV2 } from "./MemorySourcesV2";
import { presentMemorySourcesV2 } from "./memorySourcePresentation";

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

function SkillPinV2({ skillId, pinned, onPin }: Readonly<{ skillId: string; pinned: boolean; onPin(skillId: string): Promise<void> }>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <span className="v2-answer-skill-pin">
    <UiV2Button disabled={pending || pinned} aria-label={pinned ? "Skill pinned for next turn" : "Pin Skill for next turn"}
      onClick={() => { setPending(true); setError(null); void onPin(skillId).catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "Could not pin this Skill. Try again.");
      }).finally(() => setPending(false)); }}>{pinned ? "Pinned" : pending ? "Pinning…" : "Pin"}</UiV2Button>
    {error ? <span role="alert">{error}</span> : null}
  </span>;
}

export type AnswerProcessV2Props = Readonly<{
  /** The live feed was lost: an unsettled compaction cycle reads as lost, not active. */
  connectionLost?: boolean;
  contextCompaction?: ContextCompactionStatus;
  /** Failed cycles a later cycle superseded, oldest first; listed before the latest one. */
  contextCompactionFailures?: readonly ContextCompactionStatus[];
  disclosureId?: string;
  /** Live status while the run works; it occupies the settled line's place. */
  liveLabel?: string | null;
  onPinSkill?(skillId: string): Promise<void>;
  pinnedSkillIds?: readonly string[];
  memorySources?: readonly MemoryAnswerSource[];
  reasoningTexts?: readonly string[];
  toolActivity?: ThreadToolActivity | null;
  /** Send → first answer token; null when the run recorded none. */
  workDurationMs?: number | null;
  /** Workspace timeline; when present it owns the Workspace steps and the fold's label. */
  workspaceActivity?: ThreadWorkspaceActivity | null;
}>;

/**
 * The one disclosure above an answer. While the run works it is the live
 * status ("Thinking…", "Searching the web…") in the same 28px slot; settled
 * it folds Thinking → Steps and independent Past chats/Memory disclosures
 * under a factual label ("Worked for 8s · Past chats · 2"). A reached tool limit stays visible outside the fold.
 */
export function AnswerProcessV2({
  connectionLost = false,
  contextCompaction,
  contextCompactionFailures = [],
  disclosureId,
  liveLabel = null,
  onPinSkill,
  pinnedSkillIds = [],
  memorySources = [],
  reasoningTexts = [],
  toolActivity = null,
  workDurationMs = null,
  workspaceActivity = null
}: AnswerProcessV2Props) {
  const [open, setOpen] = useDisclosurePreference(disclosureId ? `workspace:${disclosureId}` : null);
  const { memories, pastChats } = presentMemorySourcesV2(memorySources);
  const reasoning = reasoningTexts.map((text) => text.trim()).filter(Boolean).join("\n\n");
  // Workspace steps are rendered by the timeline; the generic list keeps only
  // other tools so no raw sandbox identifier can reach the thread.
  const calls = (toolActivity?.calls ?? []).filter((call) => toolActivityOriginV2(call) !== "workspace");
  const timeline = workspaceActivity && (workspaceActivity.entries.length > 0 || workspaceActivity.outputStatus) ? workspaceActivity : null;
  const workspaceOutcome = workspaceActivityOutcomeV2(timeline);
  const warning = toolActivity?.warning ? (
    <div className="v2-tool-budget-warning" data-kind={toolActivity.warning.kind} role="status">
      Tool {toolActivity.warning.kind === "calls" ? "call" : "round"} limit ({toolActivity.warning.limit}) stopped further tool use.
    </div>
  ) : null;

  const compaction = contextCompaction ? contextCompactionCopyV2(contextCompaction, { connectionLost }) : null;
  const earlierCompactionFailures = contextCompactionFailures.map((status) => ({
    cycle: status.cycle, label: contextCompactionCopyV2(status).label
  }));
  const compactionLabel = compaction?.label ?? earlierCompactionFailures.at(-1)?.label ?? null;

  if (liveLabel && !timeline && !contextCompaction && earlierCompactionFailures.length === 0) {
    return (
      <div className="v2-answer-process" data-live="true" data-testid="run-status-line">
        <span className="v2-answer-process-slot" aria-hidden="true">
          <span className="v2-answer-process-spinner v2-spinner" />
        </span>
        <span className="v2-run-shimmer">{liveLabel}</span>
      </div>
    );
  }

  const live = Boolean(liveLabel);
  const label = timeline
    ? workspaceProcessLabelV2({ live, workDurationMs })
    : answerProcessLabelV2({
        hasReasoning: reasoning.length > 0,
        memoryCount: memories.length,
        pastChatCount: pastChats.length,
        stepCount: calls.length,
        workDurationMs
      });
  const displayLabel = [label, compactionLabel].filter((value): value is string => Boolean(value)).join(" · ");
  if (!displayLabel) return warning;

  return (
    <>
      <details
        className="v2-answer-process"
        data-live={live || undefined}
        data-testid="tool-activity-disclosure"
        data-workspace={timeline ? "true" : undefined}
        open={open}
        onToggle={event => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open); }}
      >
        <summary className="v2-focusable">
          <span className="v2-answer-process-slot" aria-hidden="true">
            {live ? <span className="v2-answer-process-spinner v2-spinner" /> : <span className="v2-answer-process-chevron" />}
          </span>
          <span className={live ? "v2-run-shimmer v2-answer-process-label" : "v2-answer-process-label"}>
            {live && liveLabel ? liveLabel : workspaceOutcome ? `${displayLabel} · ${workspaceOutcome}` : displayLabel}
          </span>
        </summary>
        <div className="v2-answer-process-body">
          {compactionLabel ? (
            <section className="v2-answer-process-section" data-testid="context-compaction-status"
              data-state={!contextCompaction ? "failed"
                : contextCompaction.state === "running" && connectionLost ? "connection_lost" : contextCompaction.state}>
              <h3>Context</h3>
              {earlierCompactionFailures.map((failure) => (
                <p data-state="failed" data-testid="context-compaction-earlier-failure" key={failure.cycle}>{failure.label}</p>
              ))}
              {compaction ? <p>{compaction.label}</p> : null}
              {compaction?.detail ? <p className="v2-answer-process-step-meta">{compaction.detail}</p> : null}
            </section>
          ) : null}
          {timeline ? (
            <section className="v2-answer-process-section" data-testid="workspace-activity-section">
              <h3>Workspace</h3>
              <WorkspaceActivityTimelineV2 activity={timeline} />
            </section>
          ) : null}
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
                        {describeToolCallV2(
                          call,
                          call.status === "running"
                            ? "running"
                            : call.status === "error" ? "failed"
                            : call.status === "cancelled" ? "cancelled" : "settled"
                        )}
                      </span>
                      <span className="v2-answer-process-step-meta">{toolMeta(call)}</span>
                      {onPinSkill && call.origin === "skill" && call.toolName === "load_skill" && call.status === "complete" && call.skillId
                        ? <SkillPinV2 skillId={call.skillId} pinned={pinnedSkillIds.includes(call.skillId)} onPin={onPinSkill} /> : null}
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
          {memorySources.length > 0 ? (
            <MemorySourcesV2 memories={memories} pastChats={pastChats} />
          ) : null}
        </div>
      </details>
      {warning}
    </>
  );
}
