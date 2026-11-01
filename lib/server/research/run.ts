import { randomUUID } from "node:crypto";
import {
  decodeResearchDraft,
  decodeResearchPlan,
  RESEARCH_TIME_MS,
  START_RESEARCH_TOOL_NAME,
  SUBMIT_RESEARCH_DRAFT_TOOL_NAME,
  type DecodedResearch,
  type ResearchDraft,
  type ResearchPlan
} from "../../contracts/research";
import { CALL_SUBAGENT_TOOL_NAME, SUBAGENT_END_REASONS } from "../../contracts/subagents";
import type { ThreadWorkspaceActivityEntry } from "../../contracts/workspace";
import type { LoopToolChoice } from "../engine/loop";
import type { PrepareRunSubagentsInput } from "../engine/subagents/runSubagents";
import type { EngineTool, EngineToolExecution } from "../engine/toolRegistry";
import type { SavedToolResultReader } from "../engine/toolResults";
import type { TranscriptItem, TranscriptUserItem } from "../engine/transcript";
import { logEvent } from "../observability";
import type { SubagentStopReason } from "../subagents/ports";
import { planActivityEntry } from "../tools/harnessActivity";
import { harnessToolError } from "../tools/harnessTool";
import { researchDraftReservedInstruction, startResearchTool, submitResearchDraftTool } from "../tools/research";
import type { ModelToolCall, ToolExecutionResult } from "../tools/types";
import { RESEARCH_GATES, researchCarriedNotes, runResearchGates, untilAborted, type ResearchAttempt, type ResearchGate } from "./gates";
import { researcherBrief, researchMethodText, researchPlanUpdate } from "./method";
import { researchAnswerText, researchNote, type ResearchNoteKey } from "./notes";
import { researchPorts, type ResearchPortFactories, type ResearchReportEnding, type ResearchRunScope } from "./ports";
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
 * is an ordinary one, so nothing is ever replayed after a restart. Its result names
 * the research run, since an approval continuation is a new run that must work on
 * the rows of the run that started the research (`researchRunOf`).
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
 *
 * What the research system adds sits behind ports, one set per run (`ports.ts`): absent, each is a no-op and a run goes as
 * described here.
 */
export type ResearchEngineDeps = Readonly<{
  /** The named gates; absent, the ones the product ships (`RESEARCH_GATES`). */
  gates?: readonly ResearchGate[];
  /** The parts of the research system; a port left out is its no-op. */
  ports?: ResearchPortFactories;
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

/** Around what the gates said, in the call's result: an approval continuation reads it back from there (`researchOfTurn`). */
const SENT_BACK_START = "Not shown to the user yet. ";
const SENT_BACK_END = ` Then call ${SUBMIT_RESEARCH_DRAFT_TOOL_NAME} again with the whole report.`;

/** The research run a start call's result names. It is the result's first field, read by its place: a long result is stored as an excerpt, which no JSON parser reads. */
const STARTED_RESEARCH_RUN = /^\{"research_run":"([^"\\]{1,64})"/u;

const resultOf = (call: ModelToolCall, value: { [key: string]: string }): ToolExecutionResult =>
  ({ callId: call.id, content: [{ type: "json", value }], name: call.name, status: "complete" });

/** Beside what a researcher left when its time ended it, so the main agent reads a planned end and goes on, never a failure to retry. */
export const RESEARCHER_TIME_ENDED = "Its research time ended, so it was stopped. What it recorded stays, and the report above is what it had so far. Go on with what you have.";

export type RunResearchInput = Readonly<{
  chatId: string;
  deps: ResearchEngineDeps;
  /** Moves the turn's deadline for this run (`ResearchRunScope`); absent, a turn keeps its own. */
  extendTurn?(endsAt: number): void;
  /** When the gates must have ended, so publication keeps its reserve. */
  gatesEndAt: number;
  items(): readonly TranscriptItem[];
  now(): number;
  onPlan(entry: ThreadWorkspaceActivityEntry): Promise<void>;
  /** Gives the reserved call back after a draft was not accepted (`ToolBatchState.reservedCalled`). */
  rearmReservedCall(): void;
  /** The run this one works on (`researchRunOf`), fixed before the ports are made; absent, its own. */
  researchRunId?: string;
  runId: string;
  savedResults: SavedToolResultReader;
  subagentInput: PrepareRunSubagentsInput;
  threads: NonNullable<PrepareRunSubagentsInput["engine"]["subagentThreads"]>;
  toolTimeLeft(): boolean;
  userId: string;
  userMessage: string;
}>;

export type RunResearch = ReturnType<typeof createRunResearch>;

/** A report and what the answer says of it, always together: a note belongs to the draft whose gates wrote it. */
type HeldDraft = Readonly<{ draft: ResearchDraft; notes: readonly string[] }>;

export function createRunResearch(input: RunResearchInput) {
  let plan: ResearchPlan | null = null;
  let accepted: HeldDraft | null = null;
  /** The report that stands: the latest one handed in since the last delivered follow-up, with its gates' notes once they ended. */
  let held: HeldDraft | null = null;
  /** The report a delivered follow-up superseded: what a run that fails or says nothing more still has to show. */
  let superseded: HeldDraft | null = null;
  /** What to give back if the batch refuses the start this response established research with. */
  let unconfirmedStart: Readonly<{ held: HeldDraft | null }> | null = null;
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
  /** The researcher calls running now, one entry each: a second call of a name in one batch is refused, and must not take the first off. */
  const running = new Set<Readonly<{ name: string }>>();
  const attempts: ResearchAttempt[] = [];
  // Frozen now, read at no cost to a run that never researches: the promise settles whatever happens and nothing waits for it.
  const verifierChoice = input.deps.verifier?.frozenChoice() ?? Promise.resolve({ kind: "not_set" as const });
  const turns = createResearchTurns({ subagentInput: input.subagentInput, verifierChoice, ...(input.deps.verifier ? { verifierRole: input.deps.verifier } : {}),
    userMessage: input.userMessage });
  const sources = createResearchSources({ chatId: input.chatId, items: input.items, runId: input.runId, savedResults: input.savedResults,
    threads: input.threads, userId: input.userId });
  const researchRunId = input.researchRunId ?? input.runId;
  const messaging = input.subagentInput.ports?.messaging;
  /**
   * How the clock finds running researchers: the agents on the branch, narrowed to this run's calls still running. A gate's
   * turn is no researcher, and a timer that outlives its run must find nobody, not a later run's agent of the same name.
   */
  const mailbox: ResearchRunScope["mailbox"] = messaging && {
    agents: async (scope) => {
      const listing = await messaging.agents(scope);
      return listing && { ...listing, agents: listing.agents.filter((agent) => [...running].some(({ name }) => name === agent.name)) };
    },
    send: (message) => messaging.send(message)
  };
  const ports = researchPorts(input.deps.ports, { branchRunIds: input.subagentInput.branchRunIds, chatId: input.chatId,
    extendTurn: (endsAt) => input.extendTurn?.(endsAt), mailbox,
    now: input.now, researchRunId, runId: input.runId, sources, userFollowups: () => input.subagentInput.userFollowups(), userId: input.userId,
    userMessage: input.userMessage });
  const gates = [...ports.report.gates, ...input.deps.gates ?? RESEARCH_GATES];
  /** What building the answer from the records came to: a run composes once, however many of its ends ask. */
  let composing: Promise<string | null> | null = null;
  const note = (key: ResearchNoteKey, draft: Pick<ResearchDraft, "report">) => researchNote(key, draft.report);
  /** A draft no gate has finished on: an earlier draft's counts are not its own, and only what the gates carry holds for it. */
  const unchecked = (draft: ResearchDraft): HeldDraft => ({ draft, notes: researchCarriedNotes(gates, draft, attempts) });
  /** The plan stands: research proper starts, and its phases count from here. */
  const planStands = (standing: ResearchPlan) => {
    plan = standing;
    ports.time.planReleased();
  };

  /**
   * Answer first: the port gets `RESEARCH_TIME_MS.composeReport` and Stop, and the run stops waiting at either, so a port that ignores its
   * signal cannot hold the run's end. Its failure costs what it would have built, never that end.
   */
  async function compose(ended: ResearchReportEnding, stop: AbortSignal): Promise<string | null> {
    const own = new AbortController();
    const timer = setTimeout(() => own.abort(new Error("research_report_timed_out")), RESEARCH_TIME_MS.composeReport);
    (timer as { unref?: () => void }).unref?.();
    const signal = AbortSignal.any([stop, own.signal]);
    try {
      return await untilAborted(Promise.resolve().then(() => {
        signal.throwIfAborted();
        return ports.report.compose({ ended, signal });
      }), signal);
    } catch (error) {
      if (!stop.aborted) logEvent("run_execution", { code: "research_report_failed", error, outcome: "failed", run_id: input.runId, stage: "execution" });
      return null;
    } finally {
      clearTimeout(timer);
      // A port given up on stops what it started; one that finished has nothing left to stop.
      own.abort();
    }
  }

  async function check(draft: ResearchDraft, execution: EngineToolExecution, toolsOpen: boolean): Promise<void> {
    if (!plan) return;
    held = unchecked(draft);
    const attempt = attempts.length + 1;
    const outcome = await runResearchGates({ draft, gates, runId: input.runId, context: {
      attempt,
      coverage: ports.coverage,
      earlier: [...attempts],
      evidence: ports.evidence,
      plan,
      signal: execution.signal,
      sources,
      subagents: { run: (request, signal) => turns.run(request, { attempt, round: execution.round, signal }) },
      time: { remainingMs: () => ports.time.gatesEndAt(input.gatesEndAt) - input.now(), sendBackAllowed: () => toolsOpen && input.toolTimeLeft() },
      verifierModel: () => turns.verifierModel()
    } });
    attempts.push({ draft, message: outcome.kind === "sent_back" ? outcome.message : null });
    held = { draft, notes: outcome.notes ?? [] };
    if (outcome.kind === "accepted") {
      accepted = { draft, notes: [...outcome.notes, ...draft.findings.length === 0 ? [note("no_findings", draft)] : []] };
      sentBack = null;
    } else {
      sentBack = outcome.message;
    }
  }

  /**
   * What a researcher left when its time ended it, as a result of its call. A wait for the turn ends with the turn's signal,
   * before the turn has settled, so its end is asked for here: the control waits a bounded time for the report and steps, and
   * the turn ends on its own whatever comes back. A thread that settled is what lets the main agent continue it by name.
   */
  async function researcherEnded(execution: EngineToolExecution, call: ModelToolCall, name: string): Promise<ToolExecutionResult> {
    const stopped = await input.subagentInput.ports?.background?.stop({ chatId: input.chatId, name, parentRunId: input.runId,
      parentToolCallId: execution.persistedToolCallId, userId: input.userId }).catch(() => null);
    const ended = stopped?.kind === "stopped" ? stopped.result : null;
    if (ended?.state === "done") return { callId: call.id, content: [{ type: "json", value: ended }], name: call.name, status: "complete" };
    const value = ended ? { ...ended, reason: SUBAGENT_END_REASONS.deadline } : { kind: "ended", name, reason: SUBAGENT_END_REASONS.deadline, report: "", state: "stopped" };
    return { callId: call.id, content: [{ type: "json", value }, { text: RESEARCHER_TIME_ENDED, type: "text" }], name: call.name, status: "complete" };
  }

  /**
   * A researcher's call under its time: its own limit, and the end of the research's. Time ends the researcher and not the
   * run, so that is a result to go on from. Thrown, it would read as a failed call whose effect is unknown, and an equivalent
   * call would wait for the user. Stop and the turn's deadline stay what they are.
   */
  async function underTime(tool: EngineTool, execution: EngineToolExecution, call: ModelToolCall): Promise<ToolExecutionResult> {
    const signal = ports.time.researcherSignal(execution.signal);
    const researcher = { name: typeof call.arguments.name === "string" ? call.arguments.name : "" };
    running.add(researcher);
    try {
      return await tool.execute({ ...execution, call, signal });
    } catch (error) {
      if (execution.signal.aborted || !signal.aborted) throw error;
      return await researcherEnded(execution, call, researcher.name);
    } finally {
      running.delete(researcher);
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
      const started = decoded.value;
      planStands(started);
      unconfirmedStart = null;
      const entry = planActivityEntry({ callId: persistedToolCallId, runId: input.runId, update: researchPlanUpdate(started) });
      if (entry) await input.onPlan(entry);
      // The server's field, first so a long method's excerpt keeps it: an approval continuation reads it back (`researchRunOf`).
      return resultOf(call, { research_run: researchRunId, method: researchMethodText(started), status: "started" });
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
      return resultOf(call, { message: `${SENT_BACK_START}${lastWord() ?? ""}${SENT_BACK_END}`.trim(), status: "sent_back" });
    }
  };

  return {
    /** This run's ports, for what the engine wires beside the run (a sub-agent's `record_evidence` writes through `ports.evidence`). */
    ports,
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
          unconfirmedStart = { held };
          plan = decoded.value;
          break;
        }
      }
      if (!plan) return;
      for (const call of response.calls) {
        if (call.name !== SUBMIT_RESEARCH_DRAFT_TOOL_NAME) continue;
        const decoded = decodeResearchDraft(call.arguments);
        if (decoded.ok) held = unchecked(decoded.value);
      }
    },
    /** The batch ended: a start it refused before running (out of tool time, a spent budget) never started research. */
    batchEnded(): void {
      if (!unconfirmedStart) return;
      held = unconfirmedStart.held;
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
        const closed = ports.time.researcherRefusal();
        if (closed !== null) return harnessToolError(call, "research_researchers_closed", closed);
        const { background: _background, ...foreground } = call.arguments;
        void _background;
        const { message, name } = foreground;
        if (typeof message !== "string" || typeof name !== "string" || briefed.has(name)) {
          return underTime(tool, execution, { ...call, arguments: foreground });
        }
        const brief = researcherBrief(message, plan);
        if (brief === null) return harnessToolError(call, "research_brief_too_long", "Nothing started: this brief leaves no room for the research method. Shorten it and call again.");
        briefed.add(name);
        return underTime(tool, execution, { ...call, arguments: { ...foreground, message: brief } });
      } });
    },

    /** The loop asks before each round whether the turn's answer is already taken, so no paid round follows. */
    answerTaken(input_: Readonly<{ toolChoice: LoopToolChoice }>): boolean {
      if (accepted) return true;
      if (input_.toolChoice !== "none" || !plan || !held) return false;
      // Tools closed with a draft in hand: tool-free text could only repeat it. It goes out as it stands.
      accepted = { draft: held.draft, notes: [...held.notes, note(input.toolTimeLeft() ? "unresolved" : "time_out", held.draft)] };
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
      if (held) {
        accepted = { draft: held.draft, notes: [...held.notes, note(toolsOpen ? "unresolved" : "time_out", held.draft)] };
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
      superseded = accepted ?? held ?? superseded;
      accepted = null;
      held = null;
      input.rearmReservedCall();
    },

    /**
     * The answer's text when the turn ended, or null when research did not run or a call waits for the user (the
     * continuation goes on with it). What was held goes out rather than being lost.
     */
    finish(waiting: boolean): string | null {
      if (accepted) return researchAnswerText(accepted.draft.report, accepted.notes);
      if (!plan || waiting) return null;
      if (held) return researchAnswerText(held.draft.report, [...held.notes, note("unresolved", held.draft)]);
      if (superseded) return researchAnswerText(superseded.draft.report, [...superseded.notes, note("followup_not_applied", superseded.draft)]);
      return lastHeld ? researchAnswerText(lastHeld, [researchNote("not_submitted", lastHeld)]) : null;
    },

    /** What the answer keeps when the run stops or fails with a report in hand; a stopped run shows only a report, never narration. */
    afterEnding(reason: "failed" | "stopped" | "timed_out"): string | null {
      if (accepted) return researchAnswerText(accepted.draft.report, accepted.notes);
      const report = held ?? superseded;
      if (report) {
        return researchAnswerText(report.draft.report, [...report.notes,
          note(reason === "stopped" ? "stopped" : reason === "timed_out" ? "time_out" : "run_failed", report.draft),
          ...held ? [] : [note("followup_not_applied", report.draft)]]);
      }
      if (reason === "stopped") return null;
      // The longer text says more: narration after a whole report written as a message must not replace it.
      if (attemptText.trim() && attemptText.length >= lastHeld.length) return researchAnswerText(attemptText, [researchNote("incomplete", attemptText)]);
      return lastHeld ? researchAnswerText(lastHeld, [researchNote("not_submitted", lastHeld)]) : null;
    },

    /**
     * The answer the server builds from the records when `finish` or `afterEnding` had none, never for a stopped run or one
     * waiting for the user. Apart from them because it reads a store, and they answer at once. `stop` is what ends the run's Stop,
     * not its deadline: the deadline may be what ended it. A second end, such as a failure to publish, gets the first one's result.
     */
    composed(ended: ResearchReportEnding, stop: AbortSignal): Promise<string | null> {
      if (!plan) return Promise.resolve(null);
      composing ??= compose(ended, stop);
      return composing;
    },

    /** An approval continuation goes on with the research its turn started; every other later turn is an ordinary one. */
    resume(items: readonly TranscriptItem[]): void {
      const found = researchOfTurn(items);
      if (found.plan) planStands(found.plan);
      // Before the draft: what the gates carry for it comes from these.
      attempts.push(...found.attempts);
      if (found.draft) held = unchecked(found.draft);
    },

    stopAll: (reason: SubagentStopReason) => turns.stopAll(reason)
  };
}

/** What the gates said of a draft, from its call's stored result; null when they accepted it, and undefined when they never ended on it. */
function gatesWord(result: Extract<TranscriptItem, { kind: "tool_result" }> | undefined): string | null | undefined {
  if (result?.outcome !== "complete") return undefined;
  let parsed: unknown;
  try {
    // A repeat note may follow the JSON (`repeatIdenticalNote`).
    parsed = JSON.parse(result.output.slice(0, result.output.lastIndexOf("}") + 1));
  } catch {
    return undefined;
  }
  const { message, status } = (parsed ?? {}) as { message?: unknown; status?: unknown };
  if (status === "accepted") return null;
  if (status !== "sent_back" || typeof message !== "string") return undefined;
  const start = message.startsWith(SENT_BACK_START) ? SENT_BACK_START.length : 0;
  return message.slice(start, message.endsWith(SENT_BACK_END) ? -SENT_BACK_END.length : undefined);
}

/**
 * What a turn's items hold of its research: its calls since the last message of the user's or the server's own. `attempts` are
 * the drafts the gates ended on with what they said, rebuilt with new objects for an approval continuation: what a gate keeps
 * by object identity is gone, so a gate that must remember reads these (`verifier.ts`). `researchRun` is what the start call's
 * stored result names, there only when it names one, as no older result does; a stored value, so it means nothing until
 * `researchRunOf` has checked it.
 */
export function researchOfTurn(items: readonly TranscriptItem[]): Readonly<{ attempts: readonly ResearchAttempt[]; draft: ResearchDraft | null; plan: ResearchPlan | null;
  researchRun?: string }> {
  const attempts: ResearchAttempt[] = [];
  const results = new Map<string, Extract<TranscriptItem, { kind: "tool_result" }>>();
  let draft: ResearchDraft | null = null;
  let plan: ResearchPlan | null = null;
  let researchRun: string | undefined;
  for (let index = items.length - 1; index >= 0 && !plan; index -= 1) {
    const item = items[index]!;
    if (item.kind === "user" && item.id.startsWith("msg-")) break;
    if (item.kind === "tool_result" && (item.name === START_RESEARCH_TOOL_NAME || item.name === SUBMIT_RESEARCH_DRAFT_TOOL_NAME)) results.set(item.callId, item);
    if (item.kind !== "tool_call" || item.name !== START_RESEARCH_TOOL_NAME && item.name !== SUBMIT_RESEARCH_DRAFT_TOOL_NAME) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(item.arguments);
    } catch {
      continue;
    }
    if (item.name === START_RESEARCH_TOOL_NAME) {
      const decoded = decodeResearchPlan(parsed);
      if (!decoded.ok) continue;
      plan = decoded.value;
      const started = results.get(item.callId);
      researchRun = started?.outcome === "complete" ? STARTED_RESEARCH_RUN.exec(started.output)?.[1] : undefined;
    } else {
      const decoded = decodeResearchDraft(parsed);
      if (!decoded.ok) continue;
      draft ??= decoded.value;
      const message = gatesWord(results.get(item.callId));
      if (message !== undefined) attempts.unshift({ draft: decoded.value, message });
    }
  }
  return { attempts, draft, plan, ...researchRun === undefined ? {} : { researchRun } };
}

/**
 * The run whose frame, records and pages an approval continuation works on, from the turn's items: the run that started the research,
 * however many approvals ago, because each one finds the same start call. A stored value grants nothing (root rule "The server decides"):
 * it counts only when it names a run of this branch, and otherwise, as with no value, the run keeps its own id.
 */
export function researchRunOf(items: readonly TranscriptItem[], run: Readonly<{ branchRunIds: readonly string[]; runId: string }>): string {
  const { researchRun } = researchOfTurn(items);
  return researchRun !== undefined && run.branchRunIds.includes(researchRun) ? researchRun : run.runId;
}
