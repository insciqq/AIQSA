import type { ResearchPlanRelease } from "@/lib/contracts/research";

/**
 * Every word the plan card says itself, in the language of the answer's other cards. The start button is the operator's own
 * wording and stays exactly so (decision 2026-11-01). The plan's text is the model's, in the user's language, and never passes here.
 */
export const RESEARCH_PLAN_COPY = Object.freeze({
  addAssumption: "Add assumption",
  addStep: "Add step",
  announceClosing: "The time is up.",
  announceHeld: "The timer is held while the plan is edited.",
  announceOpen: "Research starts by itself in about a minute unless you change the plan.",
  announceTen: "Research starts in 10 seconds.",
  announceThirty: "Research starts in 30 seconds.",
  answerLive: "The plan stands. Research is starting.",
  answerSettled: "The plan stood.",
  assumptions: "Assumptions",
  cancel: "Cancel",
  closedHeading: "Your changes did not reach the plan",
  closing: "The time is up. Waiting for research to start…",
  copied: "Copied.",
  copy: "Copy my text",
  copyFailed: "Could not copy. Select the text and copy it yourself.",
  dismiss: "Dismiss",
  edit: "Edit",
  gone: "This plan ended before research started: the answer was stopped, or the server restarted.",
  held: "Timer held while you edit",
  heldElsewhere: "Timer held by an edit",
  holdFailed: "The timer could not be held and is still running. Trying again.",
  invalid: "Write how the task was understood and at least one step.",
  loading: "Loading the plan…",
  loadFailed: "Could not load the plan.",
  mine: "Your text",
  refreshFailed: "Could not refresh the time left.",
  resume: "Resume timer",
  resumeFailed: "The timer could not be resumed. Try again.",
  retry: "Try again",
  saveFailed: "Your changes were not saved and are still here. Press Start research to try again.",
  saveRefused: "The server refused this text. It is still here: shorten it and press Start research again.",
  sendAsMessage: "Put in a message",
  start: "Start research",
  startFailed: "Research could not be started. Try again.",
  startLanguage: "ru",
  steps: "Steps",
  title: "Research plan",
  understood: "How I understood the task"
});

/** How a window closed under a person's edit. `stopped`: the run ended, by Stop or a restart. */
export const RESEARCH_PLAN_CLOSED_COPY: Readonly<Record<ResearchPlanRelease | "stopped", string>> = Object.freeze({
  abandoned_edit: "The edit was left too long, so research started with the last saved plan.",
  chat_message: "A message in the chat closed the plan.",
  saved_edit: "Another edit of this plan was saved first.",
  start_button: "Research was started from another tab.",
  stopped: "The answer was stopped, or the server restarted, so research did not start.",
  timer: "The time ran out, so research started with the proposed plan."
});

export function researchPlanTime(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export const researchPlanStartsIn = (time: string) => `Research starts in ${time}`;
export const researchPlanHeldLeft = (time: string) => `${RESEARCH_PLAN_COPY.held}: ${time} left to edit`;
export const researchPlanHeldElsewhereLeft = (time: string) => `${RESEARCH_PLAN_COPY.heldElsewhere}, up to ${time}`;
export const researchPlanStepLabel = (index: number) => `Step ${index + 1}`;
export const researchPlanAssumptionLabel = (index: number) => `Assumption ${index + 1}`;
export const researchPlanDeleteLabel = (label: string) => `Delete ${label.toLowerCase()}`;

/** The person's edit as one text, for the clipboard or the composer. */
export function researchPlanEditText(edit: Readonly<{ assumptions: readonly string[]; steps: readonly string[]; understood: string }>): string {
  return [
    edit.understood,
    ...edit.assumptions.length > 0 ? [`${RESEARCH_PLAN_COPY.assumptions}:\n${edit.assumptions.map((entry) => `- ${entry}`).join("\n")}`] : [],
    `${RESEARCH_PLAN_COPY.steps}:\n${edit.steps.map((entry, index) => `${index + 1}. ${entry}`).join("\n")}`
  ].filter(Boolean).join("\n\n");
}
