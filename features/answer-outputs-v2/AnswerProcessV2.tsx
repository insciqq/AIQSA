"use client";

import { MarkdownMessage } from "@/components/chat/MarkdownMessage";
import { useDisclosurePreference } from "@/components/app-shell/disclosurePreferences";
import { useState } from "react";
import { UiV2Button, UiV2Icon } from "@/components/ui-v2";
import type { ThreadMcpUnavailableServer, ThreadToolActivity } from "@/lib/contracts/chats";
import { mcpUnavailableServerCopy } from "@/lib/contracts/mcp";
import { runningSearchEngineCalls, unknownSearchEngineCalls,
  type ThreadSearchEngineActivity } from "@/lib/contracts/searchActivity";
import type { MemoryAnswerSource } from "@/lib/contracts/memoryClient";
import type { ThreadWorkspaceActivity, ThreadWorkspaceActivityEntry } from "@/lib/contracts/workspace";
import type { ContextCompactionStatus } from "@/lib/contracts/contextCompaction";
import {
  answerProcessLabelV2,
  contextCompactionCopyV2,
  describeToolCallV2,
  fetchCallSkippedV2,
  memorySearchCallHiddenV2,
  planCallHiddenV2,
  toolActivityOriginV2
} from "@/features/run-lifecycle-v2/runPresentation";
import { WorkspaceActivityTimelineV2 } from "@/features/run-lifecycle-v2/WorkspaceActivityTimelineV2";
import {
  visibleWorkspaceActivityV2,
  workspaceActivityOutcomeV2,
  workspaceOutputStatusCopyV2,
  workspacePlanSummaryV2,
  workspacePlanV2,
  workspaceProcessLabelV2
} from "@/features/run-lifecycle-v2/workspaceActivityPresentation";
import { MemorySourcesV2 } from "./MemorySourcesV2";
import { presentMemorySourcesV2 } from "./memorySourcePresentation";
import { McpCallDetailsV2 } from "./McpCallDetailsV2";

type ToolCallV2 = ThreadToolActivity["calls"][number];

function toolDuration(durationMs: number | undefined): string | null {
  if (durationMs === undefined) return null;
  return durationMs < 1_000
    ? `${durationMs} ms`
    : `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)} s`;
}

/* Meta reads "0.8 s"; only a non-complete state adds a word. A skipped page
   read already says so in its label. */
function toolMeta(call: ToolCallV2): string {
  const parts: string[] = [];
  const duration = toolDuration(call.durationMs);
  if (call.approvalRequired) parts.push("Not sent · needs approval");
  else if (call.status === "error" && !fetchCallSkippedV2(call)) parts.push("Failed");
  else if (call.status === "cancelled") parts.push("Stopped");
  if (duration) parts.push(duration);
  return parts.join(" · ");
}

type ToolCallStateV2 = Parameters<typeof describeToolCallV2>[1];

function toolCallState(call: ToolCallV2): ToolCallStateV2 {
  return call.status === "running" ? "running"
    : call.status === "error" ? "failed" : call.status === "cancelled" ? "cancelled" : "settled";
}

function hasMcpDetails(call: ToolCallV2, runId: string | null): boolean {
  return call.origin === "mcp" && Boolean(call.details) && Boolean(runId);
}

function toolCallKey(call: ToolCallV2, index: number, runId: string | null): string {
  return hasMcpDetails(call, runId) && call.details
    ? `${runId}:${call.details.roundIndex}:${call.details.ordinal}` : `${call.round}:${index}:${call.toolName}`;
}

type ToolCallGroupV2 = { calls: { call: ToolCallV2; index: number }[]; label: string };

/** A call that carries its own control or notice keeps its own row. */
function standsAloneV2(call: ToolCallV2): boolean {
  return call.status === "running" || Boolean(call.approvalRequired) || fetchCallSkippedV2(call) ||
    (call.origin === "skill" && call.toolName === "load_skill") || (call.origin === "discovery" && Boolean(call.mcpUnavailable?.length));
}

/** Consecutive finished calls with the same description and outcome read as one row ("Used GitLab: list commits ×14"). */
function groupToolCallsV2(calls: readonly ToolCallV2[]): ToolCallGroupV2[] {
  const groups: ToolCallGroupV2[] = [];
  calls.forEach((call, index) => {
    const label = describeToolCallV2(call, toolCallState(call));
    const previous = groups.at(-1);
    const head = previous?.calls[0]?.call;
    if (previous && head && previous.label === label && head.status === call.status && !standsAloneV2(call) && !standsAloneV2(head)) {
      previous.calls.push({ call, index });
    } else {
      groups.push({ calls: [{ call, index }], label });
    }
  });
  return groups;
}

function searchEngineOutcome(engine: ThreadSearchEngineActivity): string {
  const parts: string[] = [];
  if (engine.complete > 0) parts.push(`×${engine.complete}`);
  if (engine.error > 0) parts.push(`${engine.error} unsuccessful`);
  const running = runningSearchEngineCalls(engine);
  if (running > 0) parts.push(`${running} in progress`);
  if (engine.skipped > 0) parts.push(`${engine.skipped} skipped`);
  const unknown = unknownSearchEngineCalls(engine);
  if (unknown > 0) parts.push(`${unknown} outcome unavailable`);
  return `${engine.name} ${parts.join(" · ")}`;
}

function searchActivitySummary(engines: readonly ThreadSearchEngineActivity[]): string | null {
  return engines.length > 0 ? `Web search · ${engines.map(searchEngineOutcome).join(" · ")}` : null;
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

type PlanStepState = "active" | "complete" | "pending";

/** A plan step's mark: done is checked, the current step spins while the answer runs, the rest wait. */
function PlanMarkV2({ live, state }: Readonly<{ live: boolean; state: PlanStepState }>) {
  if (state === "active" && live) {
    return <span className="v2-answer-process-mark v2-spinner" data-status="running" aria-hidden="true" />;
  }
  return (
    <span className="v2-answer-process-mark" data-status={state} aria-hidden="true">
      {state === "complete" ? <UiV2Icon name="check" /> : null}
    </span>
  );
}

const PLAN_STEP_STATE_COPY: Readonly<Record<PlanStepState, string>> = { active: "In progress", complete: "Done", pending: "Not started" };

/** The agent's plan as its steps, each with its state in words for assistive technology. */
function PlanV2({ live, plan }: Readonly<{ live: boolean; plan: ThreadWorkspaceActivityEntry }>) {
  return (
    <section className="v2-answer-process-section" data-testid="answer-plan">
      <h3>Plan</h3>
      <ol className="v2-answer-process-steps v2-answer-plan" aria-label="Plan steps">
        {(plan.items ?? []).map((item, index) => {
          const state: PlanStepState = item.completed ? "complete" : item.active ? "active" : "pending";
          return (
            <li data-state={state} key={`${index}:${item.text}`}>
              <PlanMarkV2 live={live} state={state} />
              <span className="v2-answer-process-step-name">{item.text}</span>
              <span className="v2-sr-only">{PLAN_STEP_STATE_COPY[state]}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** Servers a tool search could not load: each with its reason and the user's way to recover. */
function McpUnavailableServersV2({ servers }: Readonly<{ servers: readonly ThreadMcpUnavailableServer[] }>) {
  return (
    <div className="v2-answer-process-unavailable" data-testid="mcp-unavailable-servers">
      <span className="v2-answer-process-step-meta">Unavailable now</span>
      <ul>
        {servers.map((server, index) => {
          const copy = mcpUnavailableServerCopy(server.reason);
          return (
            <li data-reason={server.reason} key={`${index}:${server.name}`}>
              <span className="v2-answer-process-step-name">{server.name} · {copy.label}</span>{" "}
              <span className="v2-answer-process-step-meta">{copy.action}</span>
            </li>
          );
        })}
      </ul>
    </div>
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

/** One step: its outcome mark, label and meta, with MCP request and response details for the run's initiator. */
function ToolCallRowV2({ call, label, onPinSkill, pinnedSkillIds, runId }: Readonly<{
  call: ToolCallV2;
  label: string;
  onPinSkill?(skillId: string): Promise<void>;
  pinnedSkillIds: readonly string[];
  runId: string | null;
}>) {
  return (
    <li className={hasMcpDetails(call, runId) ? "v2-mcp-call-row" : undefined} data-status={call.status}>
      {/* A call waiting for approval or a skipped page read did not fail: it was never sent. */}
      <ToolCallMarkV2 status={call.approvalRequired || fetchCallSkippedV2(call) ? "cancelled" : call.status} />
      {hasMcpDetails(call, runId) && call.details && runId ? (
        <McpCallDetailsV2 runId={runId} reference={call.details} status={call.status} label={label} meta={toolMeta(call)} />
      ) : (
        <span className="v2-answer-process-step">
          <span className="v2-answer-process-step-name">{label}</span>
          <span className="v2-answer-process-step-meta">{toolMeta(call)}</span>
          {onPinSkill && call.origin === "skill" && call.toolName === "load_skill" && call.status === "complete" && call.skillId
            ? <SkillPinV2 skillId={call.skillId} pinned={pinnedSkillIds.includes(call.skillId)} onPin={onPinSkill} /> : null}
          {call.origin === "discovery" && call.mcpUnavailable?.length
            ? <McpUnavailableServersV2 servers={call.mcpUnavailable} /> : null}
        </span>
      )}
    </li>
  );
}

export type AnswerProcessV2Props = Readonly<{
  /** The live feed was lost: an unsettled compaction cycle reads as lost, not active. */
  connectionLost?: boolean;
  contextCompaction?: ContextCompactionStatus;
  /** Failed cycles a later cycle superseded, oldest first; listed before the latest one. */
  contextCompactionFailures?: readonly ContextCompactionStatus[];
  disclosureId?: string;
  /** Settled, downloadable Workspace outputs from this answer. */
  generatedFileCount?: number;
  /** Live status while the run works; it occupies the settled line's place. */
  liveLabel?: string | null;
  onPinSkill?(skillId: string): Promise<void>;
  pinnedSkillIds?: readonly string[];
  memorySources?: readonly MemoryAnswerSource[];
  /** The run streamed thinking whose text arrives with the settled answer: the line keeps its slot meanwhile. */
  reasoningPending?: boolean;
  reasoningTexts?: readonly string[];
  /** Part of the thinking was too long to keep or show; the fold says so. */
  reasoningTruncated?: boolean;
  runId?: string | null;
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
  generatedFileCount = 0,
  liveLabel = null,
  onPinSkill,
  pinnedSkillIds = [],
  memorySources = [],
  reasoningPending = false,
  reasoningTexts = [],
  reasoningTruncated = false,
  runId = null,
  toolActivity = null,
  workDurationMs = null,
  workspaceActivity = null
}: AnswerProcessV2Props) {
  const [open, setOpen] = useDisclosurePreference(disclosureId ? `workspace:${disclosureId}` : null);
  // Unavailable and forgotten sources are not listed, so counts describe only
  // the rows a user can still read.
  const [forgottenRefs, setForgottenRefs] = useState<ReadonlySet<string>>(() => new Set());
  const listedMemorySources = memorySources.filter((source) =>
    source.sourceAvailable && !forgottenRefs.has(source.memoryRef));
  const { memories, pastChats } = presentMemorySourcesV2(listedMemorySources);
  const reasoning = reasoningTexts.map((text) => text.trim()).filter(Boolean).join("\n\n");
  // Workspace steps are rendered by the timeline; the generic list keeps only
  // other tools so no raw sandbox identifier can reach the thread.
  // A failed Memory search leaves no step: the answer continues without it.
  // The plan tool's calls show as the plan itself.
  const calls = (toolActivity?.calls ?? []).filter((call) =>
    toolActivityOriginV2(call) !== "workspace" && !memorySearchCallHiddenV2(call) && !planCallHiddenV2(call));
  const searchEngines = toolActivity?.searchEngines ?? [];
  const searchSummary = searchActivitySummary(searchEngines);
  const plan = workspacePlanV2(workspaceActivity);
  const planSummary = plan ? workspacePlanSummaryV2(plan) : null;
  const timeline = visibleWorkspaceActivityV2(workspaceActivity, generatedFileCount);
  const outputOnlyCount = generatedFileCount > 0 && !timeline?.entries.some(entry =>
    entry.kind === "outputs_export" && (entry.count ?? 0) > 0
  ) ? generatedFileCount : 0;
  const emptyWorkspaceStatus = timeline?.entries.length === 0
    ? workspaceOutputStatusCopyV2(timeline.outputStatus, generatedFileCount) : null;
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

  if (liveLabel && !timeline && !plan && !searchSummary && !calls.some(call =>
    (call.origin === "memory" && call.toolName === "memory_search") || (call.origin === "mcp" && call.details && runId)
  ) && !contextCompaction && earlierCompactionFailures.length === 0) {
    return (
      <div className="v2-answer-process" data-live="true" data-testid="run-status-line">
        <span className="v2-answer-process-slot" aria-hidden="true">
          <span className="v2-answer-process-spinner v2-spinner" />
        </span>
        <span className="v2-answer-process-label">{liveLabel}</span>
      </div>
    );
  }

  const live = Boolean(liveLabel);
  const label = timeline
    ? workspaceProcessLabelV2({ live, workDurationMs })
    : answerProcessLabelV2({
        hasReasoning: reasoning.length > 0 || reasoningPending,
        memoryCount: memories.length,
        pastChatCount: pastChats.length,
        stepCount: calls.length,
        workDurationMs
      });
  const displayLabel = [searchSummary, label, planSummary, compactionLabel].filter((value): value is string => Boolean(value)).join(" · ");
  if (!displayLabel) return warning;
  // Nothing to unfold yet (the thinking arrives with the settled answer): the
  // same row as plain text, so the line neither disappears nor moves.
  if (!live && !compactionLabel && !timeline && !plan && !reasoning && searchEngines.length === 0 && calls.length === 0 &&
    listedMemorySources.length === 0) {
    return (
      <>
        <div className="v2-answer-process" data-pending="true" data-testid="answer-process-pending">
          <span className="v2-answer-process-slot" aria-hidden="true" />
          <span className="v2-answer-process-label">{displayLabel}</span>
        </div>
        {warning}
      </>
    );
  }

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
          <span className="v2-answer-process-label">
            {live && liveLabel ? [liveLabel, searchSummary, planSummary].filter(Boolean).join(" · ")
              : workspaceOutcome ? `${displayLabel} · ${workspaceOutcome}` : displayLabel}
          </span>
          {live ? (
            <span className="v2-answer-process-slot" aria-hidden="true" data-testid="answer-process-live-chevron">
              <span className="v2-answer-process-chevron" />
            </span>
          ) : null}
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
          {plan ? <PlanV2 live={live} plan={plan} /> : null}
          {timeline ? (
            <section className="v2-answer-process-section" data-testid="workspace-activity-section">
              <h3>Workspace</h3>
              <WorkspaceActivityTimelineV2 activity={timeline} />
              {emptyWorkspaceStatus ? <p className="v2-answer-process-step-meta">{emptyWorkspaceStatus}</p> : null}
              {outputOnlyCount > 0 ? (
                <p className="v2-answer-process-step-meta">
                  {outputOnlyCount} {outputOnlyCount === 1 ? "file" : "files"} available for download
                </p>
              ) : null}
            </section>
          ) : null}
          {reasoning ? (
            <section className="v2-answer-process-section" data-testid="answer-reasoning">
              <h3>Thinking</h3>
              <div className="v2-answer-process-reasoning">
                <MarkdownMessage content={reasoning} />
              </div>
              {reasoningTruncated ? (
                <p className="v2-answer-process-step-meta" data-testid="answer-reasoning-truncated">
                  Thinking is too long to show in full.
                </p>
              ) : null}
            </section>
          ) : null}
          {searchEngines.length > 0 ? (
            <section className="v2-answer-process-section" data-testid="search-engine-activity">
              <h3>Web search</h3>
              <p className="v2-answer-process-step-meta">
                ×N counts successful calls by this answer to each selected search engine. Provider-internal searches and HTTP retries are excluded.
              </p>
              <ul>
                {searchEngines.map(engine => <li className="v2-answer-process-step-name" key={engine.engine}>{searchEngineOutcome(engine)}</li>)}
              </ul>
            </section>
          ) : null}
          {calls.length > 0 ? (
            <section className="v2-answer-process-section">
              <h3>Steps</h3>
              <ol className="v2-answer-process-steps">
                {groupToolCallsV2(calls).map((group) => {
                  const [first] = group.calls;
                  if (group.calls.length === 1) {
                    return <ToolCallRowV2 call={first.call} key={toolCallKey(first.call, first.index, runId)} label={group.label}
                      onPinSkill={onPinSkill} pinnedSkillIds={pinnedSkillIds} runId={runId} />;
                  }
                  const total = group.calls.reduce((sum, { call }) => sum + (call.durationMs ?? 0), 0);
                  const status = first.call.status;
                  return (
                    <li className="v2-answer-process-call-group-row" data-status={status}
                      key={`group:${toolCallKey(first.call, first.index, runId)}`}>
                      <details className="v2-answer-process-call-group" data-testid="tool-call-group">
                        <summary className="v2-focusable">
                          <ToolCallMarkV2 status={status} />
                          <span className="v2-answer-process-step-name">{group.label} ×{group.calls.length}</span>
                          <span className="v2-answer-process-step-meta">
                            {[status === "error" ? "Failed" : status === "cancelled" ? "Stopped" : null,
                              total > 0 ? toolDuration(total) : null].filter(Boolean).join(" · ")}
                          </span>
                          <span className="v2-answer-process-call-group-chevron" aria-hidden="true" />
                        </summary>
                        <ol className="v2-answer-process-steps">
                          {group.calls.map(({ call, index }, position) => (
                            <ToolCallRowV2 call={call} key={toolCallKey(call, index, runId)} label={`Call ${position + 1}`}
                              onPinSkill={onPinSkill} pinnedSkillIds={pinnedSkillIds} runId={runId} />
                          ))}
                        </ol>
                      </details>
                    </li>
                  );
                })}
              </ol>
            </section>
          ) : null}
          {listedMemorySources.length > 0 ? (
            <MemorySourcesV2 memories={memories} pastChats={pastChats}
              onForgotten={(memoryRef) => setForgottenRefs((current) => new Set(current).add(memoryRef))} />
          ) : null}
        </div>
      </details>
      {warning}
    </>
  );
}
