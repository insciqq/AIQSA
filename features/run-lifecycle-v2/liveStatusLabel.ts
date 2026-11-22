import type { ThreadToolActivityCall } from "@/lib/contracts/chats";
import type { ThreadWorkspaceActivity } from "@/lib/contracts/workspace";
import {
  liveRunningCallLabelV2,
  liveRunningCallV2,
  type LiveRunningCallV2,
  type RunActivityKindV2
} from "./runPresentation";
import { workspaceActiveLabelV2, workspaceLiveLabelV2 } from "./workspaceActivityPresentation";

/** Server phases that began after any tool call still shown as running: they supersede its label and the generic Workspace one. */
const LIVE_PHASE_KINDS: ReadonlySet<RunActivityKindV2> = new Set(["files", "provider_retrying", "provider_slow", "results"]);

export type LiveStatusInputV2 = Readonly<{
  /** The neutral line when no work can be named: a run's or turn's waiting phrase, or a row's "Working…". */
  idle: string;
  /** The run's current server phase (`RunPresentationV2.activity`); sub-agents have none. */
  phase?: Readonly<{ kind: RunActivityKindV2; label: string; reasoningHeading?: string }> | null;
  /** The answer's tool calls, oldest first; only running ones can name the line. */
  toolCalls?: readonly (LiveRunningCallV2 & Readonly<{ status: ThreadToolActivityCall["status"] }>)[];
  workspaceActivity?: ThreadWorkspaceActivity | null;
}>;

/**
 * The live status line of an answer or a sub-agent's turn (FRONTEND: it names
 * only real work). In order: a final synthesis or compaction; a running
 * Workspace step; a later server phase (the model's reasoning heading replacing
 * its waiting label); the generic Workspace label once Workspace worked; the
 * newest running call of the agent's own, or the neutral sub-agent wait when
 * only sub-agents work; the phase's own label; the idle line.
 */
export function liveStatusLabelV2(input: LiveStatusInputV2): string {
  const { phase = null, workspaceActivity = null } = input;
  if (phase?.kind === "synthesis" || phase?.kind === "compaction") return phase.label;
  // The model's own heading replaces only the waiting label. It is a one-line
  // status, shown whatever the Reasoning blocks setting (operator decision 2026-10-20).
  const phaseLabel = phase ? phase.reasoningHeading || phase.label : null;
  const call = liveRunningCallV2((input.toolCalls ?? []).filter((candidate) => candidate.status === "running"));
  return workspaceActiveLabelV2(workspaceActivity) ??
    (phase && LIVE_PHASE_KINDS.has(phase.kind) ? phaseLabel : null) ??
    workspaceLiveLabelV2(workspaceActivity) ??
    (call ? liveRunningCallLabelV2(call) : null) ??
    phaseLabel ?? input.idle;
}
