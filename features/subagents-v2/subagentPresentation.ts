import type { UiV2IconName } from "@/components/ui-v2";
import {
  MAIN_AGENT_NAME,
  SUBAGENT_BLOCKED_REASONS,
  SUBAGENT_END_REASONS,
  SUBAGENT_WAIT_REASONS,
  isActiveSubagentState,
  type SubagentOutcome,
  type SubagentThreadState
} from "@/lib/contracts/subagents";
import type { SubagentChatThreads, SubagentThreadSummary, SubagentTurnMessage } from "@/lib/contracts/subagentViews";
import { describeToolCallV2, planCallHiddenV2 } from "@/features/run-lifecycle-v2/runPresentation";

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

/** A sub-agent waiting for the main agent's answer: nothing the user must act on, so it never takes the warn tone. */
export function subagentWaitsForAgent(thread: Readonly<{ reason: string | null; state: SubagentThreadState }>): boolean {
  return thread.state === "waiting" && thread.reason === SUBAGENT_WAIT_REASONS.answer;
}

/** A sub-agent the user has to act for (a browser handoff). */
export function subagentWaitsForUser(thread: Readonly<{ reason: string | null; state: SubagentThreadState }>): boolean {
  return thread.state === "waiting" && !subagentWaitsForAgent(thread);
}

export function subagentStatePresentation(
  state: SubagentThreadState,
  outcome: SubagentOutcome | null = null,
  reason: string | null = null,
  /** A child's parent: what it waits for, in place of the main agent. */
  parentName: string | null = null
): SubagentStatePresentation {
  switch (state) {
    case "running":
      // A still ink dot, never an animation: running is a state, not progress.
      return { icon: null, label: "Running", tone: "neutral" };
    case "waiting":
      return subagentWaitsForAgent({ reason, state }) ? { icon: "bot", label: `Waiting for ${parentName ?? "the main agent"}`, tone: "neutral" }
        : { icon: "user", label: "Waiting for you", tone: "warn" };
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
  [SUBAGENT_BLOCKED_REASONS.needsAnswer]: "Asked the main agent a question",
  [SUBAGENT_END_REASONS.stoppedByAgent]: "Stopped by the main agent",
  [SUBAGENT_END_REASONS.stoppedByUser]: "Stopped by you",
  [SUBAGENT_END_REASONS.stoppedAll]: "Stopped with Stop all",
  [SUBAGENT_END_REASONS.parentStopped]: "Stopped with its answer",
  [SUBAGENT_END_REASONS.deadline]: "Ran out of time",
  [SUBAGENT_END_REASONS.chatDeleted]: "The chat was deleted",
  [SUBAGENT_END_REASONS.restart]: "Interrupted by a restart",
  [SUBAGENT_END_REASONS.workspaceStopUnproven]: "Interrupted by a restart; its Workspace work may not have stopped"
};

/** What differs for a child: its parent, not the main agent, did these. */
function childReasonText(reason: string, parentName: string): string | null {
  switch (reason) {
    case SUBAGENT_BLOCKED_REASONS.needsAnswer: return `Asked ${parentName} a question`;
    case SUBAGENT_END_REASONS.stoppedByAgent: return `Stopped by ${parentName}`;
    case SUBAGENT_END_REASONS.parentStopped: return `Stopped with ${parentName}`;
    default: return null;
  }
}

/** Words for a known reason code; an unknown code shows nothing rather than an identifier. */
export function subagentReasonText(reason: string | null, parentName: string | null = null): string | null {
  if (!reason) return null;
  return (parentName ? childReasonText(reason, parentName) : null) ?? REASON_TEXT[reason] ?? null;
}

/**
 * What a sub-agent is doing or how it ended, in the client's words: the
 * server's current step while it runs, or something neutral without one
 * (never an invented step); then the outcome, with its reason when that says more.
 */
export function subagentDetailText(thread: Pick<SubagentThreadSummary, "currentStep" | "outcome" | "reason" | "state"> &
  Partial<Pick<SubagentThreadSummary, "parent">>): string {
  if (thread.state === "running") {
    const step = thread.currentStep;
    return step && !planCallHiddenV2(step) ? `${describeToolCallV2(step, "running")}…` : "Working…";
  }
  const parentName = thread.parent?.name ?? null;
  const { label } = subagentStatePresentation(thread.state, thread.outcome, thread.reason, parentName);
  return thread.state === "waiting" ? label : subagentReasonText(thread.reason, parentName) ?? label;
}

const AGENT_MESSAGE_DELIVERY: Readonly<Record<SubagentTurnMessage["delivery"], string>> = {
  accepted: "Sent",
  delivered: "Read by the sub-agent",
  undelivered: "Not delivered"
};

const agentName = (name: string | undefined) => !name || name === MAIN_AGENT_NAME ? "the main agent" : name;

/** The label of a thread's message row: who wrote it or who it went to, and how far it got. */
export function subagentMessageLabel(message: SubagentTurnMessage): string {
  if (message.to) return `${message.question ? "Question" : "Message"} to ${agentName(message.to)}`;
  return `${message.question ? "Question" : "Message"} from ${agentName(message.from)} · ${AGENT_MESSAGE_DELIVERY[message.delivery]}`;
}

/** The model a sub-agent's latest turn ran on, with its effort; null when the row does not know it. */
export function subagentModelText(model: SubagentThreadSummary["model"]): string | null {
  return model ? `${model.displayName}${model.effort ? ` · ${model.effort}` : ""}` : null;
}

const COUNT_ORDER = ["Done", "Partly done", "Blocked", "Running", "Waiting for you", "Waiting for the main agent", "Stopped", "Failed", "Interrupted"];

/**
 * The collapsed row of an answer's sub-agents: "5 sub-agents · 3 done, 2
 * running". `known` are those whose state the chat's projection has; the rest
 * count in the total only, so no state is claimed for them.
 */
export function subagentCountsPhrase(total: number, known: readonly Pick<SubagentThreadSummary, "outcome" | "reason" | "state">[]): string {
  const counts = new Map<string, number>();
  for (const thread of known) {
    const { label } = subagentStatePresentation(thread.state, thread.outcome, thread.reason);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const parts = COUNT_ORDER.flatMap((label) => {
    const count = counts.get(label);
    return count ? [`${count} ${label.toLowerCase()}`] : [];
  });
  const whole = `${total} sub-agent${total === 1 ? "" : "s"}`;
  return parts.length > 0 ? `${whole} · ${parts.join(", ")}` : whole;
}

/**
 * The background sub-agents of a chat that wait for the user now (only a `browser_handoff` makes one wait for them), as
 * a stable key for the live browser panel: it changes when another starts waiting, so the panel opens once for each.
 * Null when none waits.
 */
export function subagentWaitingKeyV2(threads: readonly Pick<SubagentThreadSummary, "id" | "reason" | "state">[]): string | null {
  const waiting = threads.filter(subagentWaitsForUser).map((thread) => thread.id).sort();
  return waiting.length > 0 ? waiting.join(",") : null;
}

/**
 * The live phase of a set of sub-agents, from the server's states only: how many work, how many wait for the user and
 * how many for the main agent. Null when none is active.
 */
export function subagentWorkingPhrase(threads: readonly Pick<SubagentThreadSummary, "reason" | "state">[]): string | null {
  const running = threads.filter((thread) => thread.state === "running").length;
  const forUser = threads.filter(subagentWaitsForUser).length;
  const forAgent = threads.filter(subagentWaitsForAgent).length;
  if (running === 0 && forUser === 0 && forAgent === 0) return null;
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} sub-agent${running === 1 ? "" : "s"} working`);
  const waitingPart = (count: number, what: string) => parts.push(parts.length > 0 ? `${count} waiting for ${what}` :
    `${count} sub-agent${count === 1 ? "" : "s"} waiting for ${what}`);
  if (forUser > 0) waitingPart(forUser, "you");
  if (forAgent > 0) waitingPart(forAgent, "the main agent");
  return parts.join(" · ");
}

/** Active threads first, then the server's order (most recently updated first). */
export function orderedSubagentThreads(chat: SubagentChatThreads): SubagentThreadSummary[] {
  const active = chat.threads.filter((thread) => isActiveSubagentState(thread.state));
  const ended = chat.threads.filter((thread) => !isActiveSubagentState(thread.state));
  return [...active, ...ended];
}

/** One row of the tree: `depth` 1 is a child, under its parent's row. */
export type SubagentTreeRow = Readonly<{ depth: 0 | 1; thread: SubagentThreadSummary }>;

/**
 * The chat's threads as the tree shows them, in `orderedSubagentThreads`' order with each child right under its parent.
 * A child whose parent the list left out stands on its own, so no row is lost.
 */
export function subagentTreeRows(chat: SubagentChatThreads): SubagentTreeRow[] {
  const ordered = orderedSubagentThreads(chat);
  const listed = new Set(ordered.map((thread) => thread.id));
  return ordered.flatMap((thread): SubagentTreeRow[] => {
    if (thread.parent && listed.has(thread.parent.id)) return [];
    return [{ depth: 0, thread }, ...ordered.filter((child) => child.parent?.id === thread.id).map((child): SubagentTreeRow => ({ depth: 1, thread: child }))];
  });
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
