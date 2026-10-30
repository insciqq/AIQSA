import type { UiV2IconName } from "@/components/ui-v2";
import {
  SUBAGENT_BLOCKED_REASONS,
  SUBAGENT_END_REASONS,
  isActiveSubagentState,
  type SubagentOutcome,
  type SubagentThreadState
} from "@/lib/contracts/subagents";
import type { SubagentChatThreads, SubagentThreadSummary } from "@/lib/contracts/subagentViews";

/**
 * How a sub-agent's state reads: an icon, a tone (colour means state only:
 * ok, warn, danger, or none for running and stopped) and its words, which
 * are also the screen-reader text beside the icon.
 */
export type SubagentStatePresentation = Readonly<{
  icon: UiV2IconName | null;
  label: string;
  tone: "danger" | "neutral" | "ok" | "warn";
}>;

const OUTCOME_PRESENTATION: Readonly<Record<SubagentOutcome, SubagentStatePresentation>> = {
  blocked: { icon: "alert", label: "Blocked", tone: "warn" },
  done: { icon: "check", label: "Done", tone: "ok" },
  partial: { icon: "check", label: "Partly done", tone: "warn" }
};

export function subagentStatePresentation(
  state: SubagentThreadState,
  outcome: SubagentOutcome | null = null
): SubagentStatePresentation {
  switch (state) {
    case "running":
      // A still ink dot, never an animation: running is a state, not progress.
      return { icon: null, label: "Running", tone: "neutral" };
    case "waiting":
      return { icon: "user", label: "Waiting for you", tone: "warn" };
    case "done":
      return outcome ? OUTCOME_PRESENTATION[outcome] : OUTCOME_PRESENTATION.done;
    case "stopped":
      return { icon: "stop", label: "Stopped", tone: "neutral" };
    case "failed":
      return { icon: "alert", label: "Failed", tone: "danger" };
    case "interrupted":
      return { icon: "alert", label: "Interrupted", tone: "warn" };
  }
}

const REASON_TEXT: Readonly<Record<string, string>> = {
  [SUBAGENT_BLOCKED_REASONS.needsApproval]: "Needs your approval",
  [SUBAGENT_BLOCKED_REASONS.signInRequired]: "Needs a sign-in",
  [SUBAGENT_BLOCKED_REASONS.botWall]: "The website blocked it",
  [SUBAGENT_BLOCKED_REASONS.userCancelled]: "You cancelled its browser request",
  [SUBAGENT_BLOCKED_REASONS.browserBusy]: "The browser was busy",
  [SUBAGENT_BLOCKED_REASONS.browserMemoryLow]: "The browser ran low on memory",
  [SUBAGENT_BLOCKED_REASONS.browserUnavailable]: "This Workspace cannot give it a browser",
  [SUBAGENT_BLOCKED_REASONS.actionNotAuthorized]: "Needs your go-ahead for that action",
  [SUBAGENT_END_REASONS.stoppedByAgent]: "Stopped by the main agent",
  [SUBAGENT_END_REASONS.stoppedByUser]: "Stopped by you",
  [SUBAGENT_END_REASONS.stoppedAll]: "Stopped with Stop all",
  [SUBAGENT_END_REASONS.parentStopped]: "Stopped with its answer",
  [SUBAGENT_END_REASONS.deadline]: "Ran out of time",
  [SUBAGENT_END_REASONS.chatDeleted]: "The chat was deleted",
  [SUBAGENT_END_REASONS.restart]: "Interrupted by a restart",
  [SUBAGENT_END_REASONS.workspaceStopUnproven]: "Interrupted by a restart; its Workspace work may not have stopped"
};

/** Words for a known reason code; an unknown code shows nothing rather than an identifier. */
export function subagentReasonText(reason: string | null): string | null {
  return reason ? REASON_TEXT[reason] ?? null : null;
}

/**
 * The chat's live sub-agent phase, from the server's states only: how many
 * work and how many wait for the user. Null when none is active.
 */
/**
 * The background sub-agents of a chat that wait for the user now (only a `browser_handoff` makes one wait), as a stable
 * key for the live browser panel: it changes when another starts waiting, so the panel opens once for each. Null when
 * none waits.
 */
export function subagentWaitingKeyV2(threads: readonly Pick<SubagentThreadSummary, "id" | "state">[]): string | null {
  const waiting = threads.filter((thread) => thread.state === "waiting").map((thread) => thread.id).sort();
  return waiting.length > 0 ? waiting.join(",") : null;
}

export function subagentWorkingPhrase(threads: readonly Pick<SubagentThreadSummary, "state">[]): string | null {
  const running = threads.filter((thread) => thread.state === "running").length;
  const waiting = threads.filter((thread) => thread.state === "waiting").length;
  if (running === 0 && waiting === 0) return null;
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} sub-agent${running === 1 ? "" : "s"} working`);
  if (waiting > 0) parts.push(running > 0 ? `${waiting} waiting for you` : `${waiting} sub-agent${waiting === 1 ? "" : "s"} waiting for you`);
  return parts.join(" · ");
}

/** Active threads first, then the server's order (most recently updated first). */
export function orderedSubagentThreads(chat: SubagentChatThreads): SubagentThreadSummary[] {
  const active = chat.threads.filter((thread) => isActiveSubagentState(thread.state));
  const ended = chat.threads.filter((thread) => !isActiveSubagentState(thread.state));
  return [...active, ...ended];
}

/** Names beyond this many are counted, not listed, in the wake-up label. */
export const SUBAGENT_CALLBACK_LABEL_NAMES = 20;

/**
 * The one-line label of a wake-up answer (`subagent_callback`): the
 * sub-agents its callbacks report on, from the turn's own projection. An
 * older turn without the list names nobody.
 */
export function subagentCallbackLabel(names: readonly string[]): string {
  if (names.length === 0) return "Sub-agent results";
  const listed = names.slice(0, SUBAGENT_CALLBACK_LABEL_NAMES).join(", ");
  const more = names.length - SUBAGENT_CALLBACK_LABEL_NAMES;
  return `Sub-agent results: ${listed}${more > 0 ? ` and ${more} more` : ""}`;
}
