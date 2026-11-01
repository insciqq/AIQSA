import { randomUUID } from "node:crypto";
import {
  decodeResearchDraft,
  decodeResearchPlan,
  START_RESEARCH_TOOL_NAME,
  SUBMIT_RESEARCH_DRAFT_TOOL_NAME,
  type DecodedResearch,
  type ResearchDraft,
  type ResearchPlan
} from "../../contracts/research";
import { CALL_SUBAGENT_TOOL_NAME } from "../../contracts/subagents";
import type { ThreadWorkspaceActivityEntry } from "../../contracts/workspace";
import type { LoopToolChoice } from "../engine/loop";
import type { PrepareRunSubagentsInput } from "../engine/subagents/runSubagents";
import type { EngineTool, EngineToolExecution } from "../engine/toolRegistry";
import type { SavedToolResultReader } from "../engine/toolResults";
import type { TranscriptItem, TranscriptUserItem } from "../engine/transcript";
import type { SubagentStopReason } from "../subagents/ports";
import { planActivityEntry } from "../tools/harnessActivity";
import { harnessToolError } from "../tools/harnessTool";
import { researchDraftReservedInstruction, startResearchTool, submitResearchDraftTool } from "../tools/research";
import type { ModelToolCall, ToolExecutionResult } from "../tools/types";
import { RESEARCH_GATES, runResearchGates, type ResearchAttempt, type ResearchGate } from "./gates";
import { researcherBrief, researchMethodText, researchPlanUpdate } from "./method";
import { researchAnswerText, researchNote, type ResearchNoteKey } from "./notes";
import { createResearchSources } from "./sources";
import { createResearchTurns } from "./turns";
import type { ResearchVerifierRole } from "./verifierRole";

/**
 * Research of one run (operator decisions 2026-11-01): a thin state over the
 * ordinary loop, which ends in an ordinary answer, never a parallel process.
 *
 * A run is researching from the completed response that holds its
 * `start_research` call, before any of that response's calls is dispatched: calls
 * of one batch run at once, so a researcher beside it never starts outside the
 * method. A start the batch then refused gives that back. The call is the record:
 * an approval continuation finds it in the turn's items, and any other later turn
 * is an ordinary one, so nothing is ever replayed after a restart.
 *
 * How the server sees a draft, and how it reaches the user. The model hands the
 * report in through a reserved call, whose arguments are never streamed, so the
 * draft stays out of the answer until the gates end. An accepted report is
 * published as it is with no further model call: rewriting it would cost a second
 * full output and would show text the gates never saw. A correction is the one
 * paid rewrite, since a gate changed something. While researching, the text of
 * every round is held back as it streams (whatever a provider emits before or
 * beside its calls), so a model that writes its report as a message shows nothing
 * either: it is asked once for the call, and after that its text is the draft.
 *
 * The call is reserved outside the budgets while research runs, so past the tool
 * time the loop offers it alone, once. A draft in hand means no paid round is
 * spent on tool-free text: the turn ends with that draft and a note. Whatever ends
 * the run, what it held reaches the answer (Answer first): the report as soon as the
 * response that holds it completed, before any record of it, and with no report the
 * text of the provider's last attempt. A delivered follow-up makes the report in hand
 * no longer the answer until the model has read it, and it stays only for recovery.
 */
export type ResearchEngineDeps = Readonly<{
  /** The named gates; absent, the ones the product ships (`RESEARCH_GATES`). */
  gates?: readonly ResearchGate[];
  verifier?: ResearchVerifierRole;
}>;

/** Research is offered only with Search, in an interactive web run that has sub-agents. Telegram and scheduled runs are out. */
export function researchOffered(input: Readonly<{ monitoring: boolean; scheduled: boolean; searchOptions: number; subagents: boolean;
  telegram: boolean }>): boolean {
  return input.searchOptions > 0 && input.subagents && !input.scheduled && !input.telegram && !input.monitoring;
}

const researchActivity = (toolName: string) => () => ({ origin: "tool" as const, serverName: "Research", toolName });

const TEXT_DRAFT_CALL = "research_text_draft_";

const SUBMIT_FIRST = `Your message was not shown to the user: while research runs, only a report handed in reaches them. Call ` +
  `${SUBMIT_RESEARCH_DRAFT_TOOL_NAME} with the whole report, its findings and what could not be reached.`;

const resultOf = (call: ModelToolCall, value: { [key: string]: string }): ToolExecutionResult =>
  ({ callId: call.id, content: [{ type: "json", value }], name: call.name, status: "complete" });

export type RunResearchInput = Readonly<{
  chatId: string;
  deps: ResearchEngineDeps;
  /** When the gates must have ended, so publication keeps its reserve. */
  gatesEndAt: number;
  items(): readonly TranscriptItem[];
  now(): number;
  onPlan(entry: ThreadWorkspaceActivityEntry): Promise<void>;
  /** Gives the reserved call back after a draft was not accepted (`ToolBatchState.reservedCalled`). */
  rearmReservedCall(): void;
  runId: string;
  savedResults: SavedToolResultReader;
  subagentInput: PrepareRunSubagentsInput;
  threads: NonNullable<PrepareRunSubagentsInput["engine"]["subagentThreads"]>;
  toolTimeLeft(): boolean;
  userId: string;
  userMessage: string;
}>;

export type RunResearch = ReturnType<typeof createRunResearch>;

export function createRunResearch(input: RunResearchInput) {
  let plan: ResearchPlan | null = null;
  let accepted: Readonly<{ draft: ResearchDraft; notes: readonly string[] }> | null = null;
  /** The report that stands: the latest one handed in since the last delivered follow-up. */
  let lastDraft: ResearchDraft | null = null;
  /** The report a delivered follow-up superseded: what a run that fails or says nothing more still has to show. */
  let supersededDraft: ResearchDraft | null = null;
  /** What to give back if the batch refuses the start this response established research with. */
  let unconfirmedStart: Readonly<{ draft: ResearchDraft | null }> | null = null;
  let lastHeld = "";
  /** What the provider's current attempt streamed while research runs. */
  let attemptText = "";
  let checking = false;
  let asked = false;
  let textDrafts = 0;
  /** What the last draft's gates said, while it stands. */
  let sentBack: string | null = null;
  const lastWord = () => sentBack;
  /** A text draft's gates cannot send it back when its tools are closed: nothing could act on that. */
  let closedForText = false;
  const isAccepted = () => accepted !== null;
  /** Researchers whose brief already holds the method. */
  const briefed = new Set<string>();
  const attempts: ResearchAttempt[] = [];
  // Frozen now, read at no cost to a run that never researches: the promise settles whatever happens and nothing waits for it.
  const verifierChoice = input.deps.verifier?.frozenChoice() ?? Promise.resolve({ kind: "not_set" as const });
  const turns = createResearchTurns({ subagentInput: input.subagentInput, verifierChoice, ...(input.deps.verifier ? { verifierRole: input.deps.verifier } : {}),
    userMessage: input.userMessage });
  const sources = createResearchSources({ chatId: input.chatId, items: input.items, runId: input.runId, savedResults: input.savedResults,
    threads: input.threads, userId: input.userId });
  const gates = input.deps.gates ?? RESEARCH_GATES;
  const note = (key: ResearchNoteKey, draft: Pick<ResearchDraft, "report">) => researchNote(key, draft.report);

  async function check(draft: ResearchDraft, execution: EngineToolExecution, toolsOpen: boolean): Promise<void> {
    if (!plan) return;
    lastDraft = draft;
    const attempt = attempts.length + 1;
    const outcome = await runResearchGates({ draft, gates, runId: input.runId, context: {
      attempt,
      earlier: [...attempts],
      plan,
      signal: execution.signal,
      sources,
      subagents: { run: (request, signal) => turns.run(request, { attempt, parentToolCallId: execution.persistedToolCallId, signal }) },
      time: { remainingMs: () => input.gatesEndAt - input.now(), sendBackAllowed: () => toolsOpen && input.toolTimeLeft() },
      verifierModel: () => turns.verifierModel()
    } });
    attempts.push({ draft, message: outcome.kind === "sent_back" ? outcome.message : null });
    if (outcome.kind === "accepted") {
      accepted = { draft, notes: [...outcome.notes, ...draft.findings.length === 0 ? [note("no_findings", draft)] : []] };
      sentBack = null;
    } else {
      sentBack = outcome.message;
    }
  }

  const startTool: EngineTool = {
    activity: researchActivity("Started"),
    definition: startResearchTool,
    effects: "local",
    observationSource: "workspace",
    execute: async ({ call, persistedToolCallId }) => {
      const decoded = decodeResearchPlan(call.arguments);
      if (!decoded.ok) return harnessToolError(call, "research_plan_invalid", decoded.message);
      plan = decoded.value;
      unconfirmedStart = null;
      const entry = planActivityEntry({ callId: persistedToolCallId, runId: input.runId, update: researchPlanUpdate(plan) });
      if (entry) await input.onPlan(entry);
      return resultOf(call, { method: researchMethodText(plan), status: "started" });
    }
  };

  const submitTool: EngineTool = {
    activity: researchActivity("Checking the report"),
    definition: submitResearchDraftTool,
    effects: "local",
    observationSource: "workspace",
    execute: async (execution) => {
      const { call } = execution;
      const refused = (code: string, message: string) => {
        input.rearmReservedCall();
        return harnessToolError(call, code, message);
      };
      if (!plan) return refused("research_not_started", `Nothing was checked: call ${START_RESEARCH_TOOL_NAME} first, or answer the user directly if this needs no research.`);
      if (checking) return refused("research_check_running", "Another report is being checked; wait for its result.");
      const fromText = call.id.startsWith(TEXT_DRAFT_CALL);
      const decoded: DecodedResearch<ResearchDraft> = decodeResearchDraft(call.arguments);
      if (!decoded.ok) return refused("research_draft_invalid", decoded.message);
      checking = true;
      try {
        await check(fromText ? { ...decoded.value, origin: "plain_text" } : decoded.value, execution, !closedForText);
      } finally {
        checking = false;
      }
      if (isAccepted()) return resultOf(call, { message: "The report is shown to the user exactly as you wrote it. Your answer is complete.", status: "accepted" });
      input.rearmReservedCall();
      return resultOf(call, { message: `Not shown to the user yet. ${lastWord() ?? ""} Then call ${SUBMIT_RESEARCH_DRAFT_TOOL_NAME} again with the whole report.`.trim(),
        status: "sent_back" });
    }
  };

  return {
    reservedCall: { instruction: researchDraftReservedInstruction(), name: SUBMIT_RESEARCH_DRAFT_TOOL_NAME },
    tools: [startTool, submitTool] as readonly EngineTool[],

    /** While research runs the reserved draft is owed; an accepted one, or one being checked, is not. */
    outstanding: () => plan !== null && accepted === null && !checking,
    /** The round's text stays out of the answer. */
    holding: () => plan !== null,
    heldToken(delta: string): void {
      attemptText += delta;
    },
    /** The provider's attempt failed and is sent again, so what it streamed is no one's. */
    discardAttempt(): void {
      attemptText = "";
    },
    roundText(text: string): void {
      attemptText = "";
      if (plan !== null && text.trim()) lastHeld = text;
    },

    /**
     * A provider response completed, before any record of it is written or any of its calls sent: research starts here
     * for all of them at once, and a report it holds is the run's whatever happens next. `calls` are all it made, `runnable`
     * those that may run: a call in a round closed to it starts nothing, but its report is still the provider's complete text.
     */
    responseCompleted(response: Readonly<{ calls: readonly ModelToolCall[]; runnable: readonly ModelToolCall[] }>): void {
      if (!plan) {
        for (const call of response.runnable) {
          if (call.name !== START_RESEARCH_TOOL_NAME) continue;
          const decoded = decodeResearchPlan(call.arguments);
          if (!decoded.ok) continue;
          unconfirmedStart = { draft: lastDraft };
          plan = decoded.value;
          break;
        }
      }
      if (!plan) return;
      for (const call of response.calls) {
        if (call.name !== SUBMIT_RESEARCH_DRAFT_TOOL_NAME) continue;
        const decoded = decodeResearchDraft(call.arguments);
        if (decoded.ok) lastDraft = decoded.value;
      }
    },
    /** The batch ended: a start it refused before running (out of tool time, a spent budget) never started research. */
    batchEnded(): void {
      if (!unconfirmedStart) return;
      lastDraft = unconfirmedStart.draft;
      unconfirmedStart = null;
      plan = null;
    },

    /**
     * While research runs, the server owns what a researcher gets: its first brief ends with the method and its source
     * classes, and it runs in the foreground, because Stop spares background sub-agents and must end all research.
     */
    withResearcherBriefs(tools: readonly EngineTool[]): readonly EngineTool[] {
      return tools.map((tool): EngineTool => tool.definition.name !== CALL_SUBAGENT_TOOL_NAME ? tool : { ...tool, execute: async (execution) => {
        const { call } = execution;
        if (!plan) return tool.execute(execution);
        const { background: _background, ...foreground } = call.arguments;
        void _background;
        const { message, name } = foreground;
        if (typeof message !== "string" || typeof name !== "string" || briefed.has(name)) {
          return tool.execute({ ...execution, call: { ...call, arguments: foreground } });
        }
        const brief = researcherBrief(message, plan);
        if (brief === null) return harnessToolError(call, "research_brief_too_long", "Nothing started: this brief leaves no room for the research method. Shorten it and call again.");
        briefed.add(name);
        return tool.execute({ ...execution, call: { ...call, arguments: { ...foreground, message: brief } } });
      } });
    },

    /** The loop asks before each round whether the turn's answer is already taken, so no paid round follows. */
    answerTaken(input_: Readonly<{ toolChoice: LoopToolChoice }>): boolean {
      if (accepted) return true;
      if (input_.toolChoice !== "none" || !plan || !lastDraft) return false;
      // Tools closed with a draft in hand: tool-free text could only repeat it. It goes out as it stands.
      accepted = { draft: lastDraft, notes: [note(input.toolTimeLeft() ? "unresolved" : "time_out", lastDraft)] };
      return true;
    },

    /**
     * A response without calls while research runs. It is asked once for the call while tools are open; after that the
     * report it handed in stands, or with none its text goes through the gates as the draft. The message goes back to the
     * model when the gates send it back.
     */
    async responseEnded(ended: Readonly<{ round: number; runDraftCall(call: ModelToolCall, round: number): Promise<unknown>; text: string; toolsClosed: boolean }>):
      Promise<TranscriptUserItem | null> {
      if (!plan || accepted || !ended.text.trim()) return null;
      const server = (text: string): TranscriptUserItem => ({ id: randomUUID(), kind: "user", text });
      const toolsOpen = !ended.toolsClosed && input.toolTimeLeft();
      if (toolsOpen && !asked) {
        asked = true;
        return server(SUBMIT_FIRST);
      }
      // A report handed in stays the report: a message never replaces it, whatever it says.
      if (lastDraft) {
        accepted = { draft: lastDraft, notes: [note(toolsOpen ? "unresolved" : "time_out", lastDraft)] };
        return null;
      }
      textDrafts += 1;
      closedForText = ended.toolsClosed;
      sentBack = null;
      try {
        await ended.runDraftCall({ arguments: { findings: [], report: ended.text, unreachable: [] }, id: `${TEXT_DRAFT_CALL}${textDrafts}`,
          name: SUBMIT_RESEARCH_DRAFT_TOOL_NAME }, ended.round);
      } finally {
        closedForText = false;
      }
      const word = lastWord();
      return !isAccepted() && word ? server(`${word} Then call ${SUBMIT_RESEARCH_DRAFT_TOOL_NAME} with the whole report.`) : null;
    },

    /**
     * A follow-up that arrived reopens the answer: the model reads it, and what it hands in next is checked again. The
     * report so far stops being the answer, or tools closed by time would publish it unread, and the draft call is owed
     * again. Each delivery buys one response at most, follow-ups are bounded and the turn's deadline still ends it.
     */
    followupDelivered(): void {
      supersededDraft = accepted?.draft ?? lastDraft ?? supersededDraft;
      accepted = null;
      lastDraft = null;
      input.rearmReservedCall();
    },

    /**
     * The answer's text when the turn ended, or null when research did not run or a call waits for the user (the
     * continuation goes on with it). What was held goes out rather than being lost.
     */
    finish(waiting: boolean): string | null {
      if (accepted) return researchAnswerText(accepted.draft.report, accepted.notes);
      if (!plan || waiting) return null;
      if (lastDraft) return researchAnswerText(lastDraft.report, [note("unresolved", lastDraft)]);
      if (supersededDraft) return researchAnswerText(supersededDraft.report, [note("followup_not_applied", supersededDraft)]);
      return lastHeld ? researchAnswerText(lastHeld, [researchNote("not_submitted", lastHeld)]) : null;
    },

    /** What the answer keeps when the run stops or fails with a report in hand; a stopped run shows only a report, never narration. */
    afterEnding(reason: "failed" | "stopped" | "timed_out"): string | null {
      if (accepted) return researchAnswerText(accepted.draft.report, accepted.notes);
      const report = lastDraft ?? supersededDraft;
      if (report) {
        return researchAnswerText(report.report, [note(reason === "stopped" ? "stopped" : reason === "timed_out" ? "time_out" : "run_failed", report),
          ...lastDraft ? [] : [note("followup_not_applied", report)]]);
      }
      if (reason === "stopped") return null;
      // The longer text says more: narration after a whole report written as a message must not replace it.
      if (attemptText.trim() && attemptText.length >= lastHeld.length) return researchAnswerText(attemptText, [researchNote("incomplete", attemptText)]);
      return lastHeld ? researchAnswerText(lastHeld, [researchNote("not_submitted", lastHeld)]) : null;
    },

    /** An approval continuation goes on with the research its turn started; every other later turn is an ordinary one. */
    resume(items: readonly TranscriptItem[]): void {
      const found = researchOfTurn(items);
      if (found.plan) plan = found.plan;
      if (found.draft) lastDraft = found.draft;
    },

    stopAll: (reason: SubagentStopReason) => turns.stopAll(reason)
  };
}

/** The plan and latest draft a turn's items hold: its calls since the last message of the user's or the server's own. */
export function researchOfTurn(items: readonly TranscriptItem[]): Readonly<{ draft: ResearchDraft | null; plan: ResearchPlan | null }> {
  let draft: ResearchDraft | null = null;
  let plan: ResearchPlan | null = null;
  for (let index = items.length - 1; index >= 0 && !plan; index -= 1) {
    const item = items[index]!;
    if (item.kind === "user" && item.id.startsWith("msg-")) break;
    if (item.kind !== "tool_call" || item.name !== START_RESEARCH_TOOL_NAME && item.name !== SUBMIT_RESEARCH_DRAFT_TOOL_NAME) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(item.arguments);
    } catch {
      continue;
    }
    if (item.name === START_RESEARCH_TOOL_NAME) {
      const decoded = decodeResearchPlan(parsed);
      if (decoded.ok) plan = decoded.value;
    } else if (!draft) {
      const decoded = decodeResearchDraft(parsed);
      if (decoded.ok) draft = decoded.value;
    }
  }
  return { draft, plan };
}
