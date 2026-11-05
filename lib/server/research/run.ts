import { randomUUID } from "node:crypto";
import {
  DEEP_RESEARCH_REFUSALS,
  decodeResearchDraft,
  decodeResearchDraftReferences,
  decodeResearchPlan,
  decodeResearchPlanAnswer,
  decodeResearchPlanEdit,
  decodeResearchPlanProposal,
  decodeResearchStart,
  PROPOSE_RESEARCH_PLAN_TOOL_NAME,
  RESEARCH_TIME_MS,
  researchDraftText,
  researchPlanFromProposal,
  researchPlanProposalDocument,
  START_RESEARCH_TOOL_NAME,
  SUBMIT_RESEARCH_DRAFT_TOOL_NAME,
  type DecodedResearch,
  type ResearchDraft,
  type ResearchEvidenceRecord,
  type ResearchPlan,
  type ResearchPlanAnswer,
  type ResearchPlanEdit,
  type ResearchPlanProposal,
  type ResearchPlanRelease
} from "../../contracts/research";
import { CONTINUE_TURN_TEXT } from "../../contracts/runs";
import { CALL_SUBAGENT_TOOL_NAME, normalizeSubagentName, STOP_SUBAGENT_TOOL_NAME, SUBAGENT_END_REASONS } from "../../contracts/subagents";
import type { ThreadWorkspaceActivityEntry } from "../../contracts/workspace";
import type { LoopToolChoice } from "../engine/loop";
import type { PrepareRunSubagentsInput } from "../engine/subagents/runSubagents";
import type { EngineTool, EngineToolExecution, ToolRegistry } from "../engine/toolRegistry";
import type { SavedToolResultReader } from "../engine/toolResults";
import type { TranscriptItem, TranscriptUserItem } from "../engine/transcript";
import { logEvent } from "../observability";
import type { SubagentStopReason } from "../subagents/ports";
import { isBotCheckPage } from "../tools/botCheckPage";
import { planActivityEntry } from "../tools/harnessActivity";
import { harnessToolError } from "../tools/harnessTool";
import { proposeResearchPlanTool, researchDraftReservedInstruction, researchScopingInstructions, researchScopingOverMessage, startResearchTool, submitResearchDraftTool } from "../tools/research";
import type { ModelToolCall, ToolExecutionResult } from "../tools/types";
import type { PlanUpdate } from "../tools/updatePlan";
import { researchCandidatesLine } from "./candidates";
import { RESEARCH_GATES, researchCarriedNotes, runResearchGates, untilAborted, type ResearchAttempt, type ResearchGate } from "./gates";
import { createResearchRounds, researchFilledCells, researchKeySpecs, researchLeadingRows, researchMatrix, researchProgressCells, researchUnconfirmedKeyCells } from "./matrix";
import { researchCoverageLine, researcherBrief, researcherMatrixBrief, researchMethodText, researchNoNewCellMessage, researchPlanUpdate, researchReadHost,
  researchUnreachableSites } from "./method";
import { researchAnswerText, researchNote } from "./notes";
import { researchPorts, type ResearchPortFactories, type ResearchReportEnding, type ResearchResumeState, type ResearchRunScope } from "./ports";
import { PICKED_UP_RECORD_LIST_CHARACTERS, researchDraftWithRecords, researchRecordList } from "./reportAssembly";
import { researchDraftWithLinkedRecords } from "./reportCheck";
import { createResearchSources } from "./sources";
import { researchSiteHost } from "./sourceQuality";
import { createResearchTurns } from "./turns";
import type { ResearchVerifierRole } from "./verifierRole";

/**
 * Research of one run (operator decisions 2026-11-01): a thin state over the
 * ordinary loop, which ends in an ordinary answer, never a parallel process.
 *
 * A run has three states. Not started. Started: from the completed response that holds its `start_research` call, before any of that
 * response's calls is dispatched (calls of one batch run at once, so a researcher beside it never starts outside the method), the
 * model scopes and its text is held back; a start the batch then refused gives that back. Plan standing: only when the plan window
 * closed, which is what starts the time phases and what researchers and the reserved draft wait for. The calls are the record: an
 * approval continuation finds them in the turn's items, and any other later turn is an ordinary one, so nothing is ever replayed
 * after a restart. The start's result names the research run, since an approval continuation is a new run that must work on the rows
 * of the run that started the research (`researchRunOf`).
 *
 * Only the user starts research, by choosing Deep research for a message (operator decision 2026-11-05), and no words in a chat do: a run
 * offers research only on that message's request (`researchRequestOf`). Such a run's first step is certain. Until `start_research` started,
 * every other tool reads as one the run has not got, as past scoping's limit below, and its text is held back; a response without the start is
 * sent back once, and a turn that ends without it fails visibly (`startMissed`), never with an ordinary answer passing for research.
 *
 * The one later turn that may pick research up is the user's Continue on an interrupted run, and it comes through the same door: the model
 * calls `start_research` again and the start asks the store (`resume.ts`). What the store gives back stands at once, with no scoping and no
 * window, under this run's own row and bindings and a fresh clock, and the result says what is filled. With nothing given back it is a start like
 * any other. A researcher's call or a message before that door is sent to it, and its result is what a later approval or Continue finds.
 * Typing the word after a research that ended is no Continue of it: the run offers research only once the store says that turn was
 * interrupted (`continues`).
 *
 * Scoping ends by the server's clock, not by a prompt. Past `RESEARCH_TIME_MS.scoping` only `propose_research_plan` still runs:
 * every other new call is refused as one the run has not got, with what to do instead, so a call already running finishes and a model
 * that ignores the refusal gets the loop's bounded corrections and then a tool-free round. The reserved call would not do: it is
 * offered only with tools closed, once a turn and under one name, and would cost the draft its own reservation. A model that never
 * proposes is asked once for the plan when it writes a message; after that its text is the answer, with the note that nothing checked it.
 *
 * A person edits the plan's words, not its questions, so a changed plan owes questions: its result says so, and researchers are
 * refused until the model calls `propose_research_plan` again with questions rebuilt from the user's words, which stay as the user
 * left them whatever that call carries. No window opens for it. A chat message during the window may change the plan the same way.
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
 * response that holds it completed, before any record of it, and with no report what the
 * server builds from the records. The text of the provider's last attempt stands in only
 * with nothing recorded, or at report length: nearly every run has a line of narration by
 * then, which must not take the place of what research found. A delivered follow-up makes the
 * report in hand no longer the answer until the model has read it, and it stays only for recovery.
 *
 * What ends the going round is the matrix and the gates' own cap (`matrix.ts`, `gates.ts`): a round's researchers read its empty cells, the
 * main agent reads them after each report, and rounds that fill no new cell end research. An approval continuation starts that count
 * afresh, as it does the clock; what a gate sent back it counts across approvals, from the stored results (`researchOfTurn`). A run with no
 * frame, such as one stored before the matrix, has nothing to count and goes on as it always did.
 *
 * What the research system adds sits behind ports, one set per run (`ports.ts`): absent, each is a no-op and a run goes as
 * described here.
 */
export type ResearchEngineDeps = Readonly<{
  /** The named gates; absent, the ones the product ships (`RESEARCH_GATES`). */
  gates?: readonly ResearchGate[];
  /** The parts of the research system; a port left out is its no-op. */
  ports?: ResearchPortFactories;
  researcher?: ResearchVerifierRole;
  verifier?: ResearchVerifierRole;
}>;

/**
 * Why a run may research (operator decision 2026-11-05): the user chose Deep research for its message, or it goes on with a research that
 * such a message started, as an approval continuation of that turn or the user's Continue of it.
 */
export type ResearchRequest = "approval" | "chosen" | "continue";

/** What decides whether a run can research at all: Search, sub-agents, and an interactive web run. */
export type ResearchAvailability = Readonly<{ monitoring: boolean; scheduled: boolean; searchOptions: number; subagents: boolean; telegram: boolean }>;

/**
 * Why a run cannot research, or null when it can: Telegram turns, scheduled occurrences, monitoring checks and a run without sub-agents never
 * research, and with them out what is missing is Search, which the user can turn on. Admission refuses a message sent with Deep research on it.
 */
export function deepResearchRefusal(input: ResearchAvailability): (typeof DEEP_RESEARCH_REFUSALS)["needsSearch" | "unavailable"] | null {
  if (input.monitoring || input.scheduled || input.telegram || !input.subagents) return DEEP_RESEARCH_REFUSALS.unavailable;
  return input.searchOptions > 0 ? null : DEEP_RESEARCH_REFUSALS.needsSearch;
}

/** Research rides on a run only on a request, and only where it can run. */
export function researchOffered(input: ResearchAvailability & Readonly<{ request: ResearchRequest | null }>): boolean {
  return input.request !== null && deepResearchRefusal(input) === null;
}

/**
 * What a run's own facts ask of research: Deep research frozen with its message's bindings, an approval continuation of a turn whose items hold a
 * research start, or the user's Continue right after such a turn. A start's call is on record before it is sent, so the items show every research
 * that started; a Continue researches only once the store says that turn was interrupted (`RunResearch.continues`). Null for every other run,
 * whatever its message says.
 */
export function researchRequestOf(input: Readonly<{ approval: boolean; chosen: boolean; items: readonly TranscriptItem[] }>): ResearchRequest | null {
  if (input.chosen) return "chosen";
  if (input.approval) return researchOfTurn(input.items).goal === undefined ? null : "approval";
  return continuedTurn(input.items)?.goal === undefined ? null : "continue";
}

const researchActivity = (toolName: string) => () => ({ origin: "tool" as const, serverName: "Research", toolName });

const TEXT_DRAFT_CALL = "research_text_draft_";

/**
 * From this length what the model last wrote is taken for a report written as a message, not narration: a line beside a call is a sentence or two. A report outranks a table
 * of what it drew on (Answer first), and below this the table says more. Length is all the server can tell them by, so a very long narration stands too.
 */
const REPORT_AS_TEXT_CHARACTERS = 2_000;

/** The line the user sees as soon as research starts. Like every word of the interface it is English (operator decision 2026-11-02). */
const PLANNING_LINE = "Making a plan before research starts";
/** The line above the plan of research a Continue picked up. */
const PICKED_UP_LINE = "Continuing from what was recorded";
const pickedUpCells = (filled: number, cells: number) => `${filled} of ${cells} cells filled`;

const SUBMIT_FIRST = `Your message was not shown to the user: while research runs, only a report handed in reaches them. Call ` +
  `${SUBMIT_RESEARCH_DRAFT_TOOL_NAME} with the summary, the whole report, the ids of the records it rests on and what could not be reached.`;

const PROPOSE_FIRST = `Your message was not shown to the user: research has started and the user is waiting for your plan. Call ` +
  `${PROPOSE_RESEARCH_PLAN_TOOL_NAME} with what you have, naming what you lack as assumptions; do not ask the user anything.`;

const RESEARCHERS_AFTER_PLAN = `Nothing started: researchers start after the plan. Call ${PROPOSE_RESEARCH_PLAN_TOOL_NAME} first.`;
const REBUILD_FIRST = `Nothing started: the user changed the plan, so your questions must follow it first. Call ${PROPOSE_RESEARCH_PLAN_TOOL_NAME} again with questions rebuilt from the user's words.`;

/** How long `fetch_url` trusts its last read of the unreachable sites: a researcher's record reaches the others within it. */
const UNREACHABLE_SITES_FRESH_MS = 5_000;

const PICK_UP_FIRST = `The research of the interrupted answer can be picked up from what it recorded. Call ${START_RESEARCH_TOOL_NAME} with its goal now: ` +
  "its plan and records come back with it, and nothing else carries on that research.";

/** What a call before the start of a run whose message the user sent with Deep research returns instead of running. */
const START_FIRST = `Nothing was run: the user chose Deep research for this message, so ${START_RESEARCH_TOOL_NAME} comes first. Call it now with the goal.`;
/** What a response of such a run that did not start research is sent back with, once. */
const START_NOW = `Your message was not shown to the user: they chose Deep research for this message, and only research answers it. ` +
  `Call ${START_RESEARCH_TOOL_NAME} with its goal now.`;
/** How such a run ends when it never started research. */
const NOT_STARTED = Object.freeze({ code: "deep_research_not_started", message: "Deep research did not start for this message. Try again." });
const PICKED_UP = "Research picked up from what was recorded: the plan stands as it was, with no scoping and no window, its time starts afresh, and the records stay. " +
  "Do not research a filled cell again.";
/** What the model reads of the report it handed in before the interruption, by what the checks came to. */
const DRAFT_LEFT = {
  accepted: `The checks passed the report you handed in before the interruption, but it never reached the user. Hand it in again with ${SUBMIT_RESEARCH_DRAFT_TOOL_NAME}, and it is checked afresh.`,
  sent_back: `The checks sent back the report you handed in before the interruption, and what they said of it stands. Answer it, then submit edits or the whole report with ${SUBMIT_RESEARCH_DRAFT_TOOL_NAME}.`,
  unfinished: `The checks never finished on the report you handed in before the interruption, so hand it in again with ${SUBMIT_RESEARCH_DRAFT_TOOL_NAME} once the empty cells are filled or cannot be.`
};
const NOTHING_PICKED_UP = "Nothing of the earlier research could be picked up, so research starts over with the plan. What it found in this conversation still counts, " +
  "and so does anything the user changed in its plan.";

/** Around what the gates said, in the call's result: an approval continuation reads it back from there (`researchOfTurn`). */
const SENT_BACK_START = "Not shown to the user yet. ";
const SENT_BACK_END = ` Then call ${SUBMIT_RESEARCH_DRAFT_TOOL_NAME} again with the whole report.`;
const SENT_BACK_EDITS_END = ` Then call ${SUBMIT_RESEARCH_DRAFT_TOOL_NAME} again with edits or the whole report, and all reference fields in full.`;
/** The gate a send back came from, by its place: the cap counts it even from a result too long to be stored whole. */
const SENT_BACK_BY = /^\{"status":"sent_back","gate":"([^"\\]{1,64})"/u;

/** The research run a start call's result names. It is the result's first field, read by its place: a long result is stored as an excerpt, which no JSON parser reads. */
const STARTED_RESEARCH_RUN = /^\{"research_run":"([^"\\]{1,64})"/u;
/** A start that opened scoping, whatever its arguments held: an older start, which held the whole plan, has no such result. */
const SCOPING_STARTED = /^\{"research_run":"[^"\\]{1,64}","status":"scoping"/u;
/** A start that picked research up, whose plan is in its result: its turn has no plan call to read one from. */
const PICKED_UP_START = /^\{"research_run":"[^"\\]{1,64}","status":"resumed"/u;
/** What a plan call's result says of the plan, by place for the same reason: its first fields, then the user's words. */
const PLAN_RESULT = /^\{"status":"(released|rebuilt)","changed":(true|false),"released_by":"([a-z_]{1,32})"/u;
/** Where the user's words end: a quote inside a JSON string is escaped, so this text cannot be part of them. */
const PLAN_RESULT_WORDS_END = ',"instructions":';

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null;

const resultOf = (call: ModelToolCall, value: Readonly<Record<string, unknown>>): ToolExecutionResult =>
  ({ callId: call.id, content: [{ type: "json", value }], name: call.name, status: "complete" });

/** A `call_subagent` result of a turn that was admitted and ran, whatever it came to. An admission's refusal and a message left in a running turn's mailbox are neither. */
const turnRan = ({ content }: ToolExecutionResult) => content.some((part) => part.type === "json" && typeof part.value === "object" && part.value !== null &&
  "kind" in part.value && part.value.kind === "ended");

/** Beside what a researcher left when its time ended it, so the main agent reads a planned end and goes on, never a failure to retry. */
export const RESEARCHER_TIME_ENDED = "Its research time ended, so it was stopped. What it recorded stays, and the report above is what it had so far. Go on with what you have.";

/** The fields a person edits, as a plan row shows them before questions follow. */
const wordsOf = ({ assumptions, steps, understood }: ResearchPlanEdit): ResearchPlanEdit => ({ assumptions, steps, understood });
const stepsUpdate = (plan: ResearchPlanEdit): PlanUpdate => ({ plan: plan.steps.map((step) => ({ status: "pending" as const, step })) });

/** What a plan row shows: the line while scoping, the card, the user's words until the questions follow, and the plan that stands. */
type PlanRowState = "scoping" | "stands" | "window" | "words";

/** What the window's answer left for a further plan call. `words` are the user's, null where a stored result was cut before them. */
type StandingPlan = Readonly<{ changed: boolean; releasedBy: ResearchPlanRelease; words: ResearchPlanEdit | null }>;

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
  /** Why this run may research (`researchRequestOf`); absent, as a run of research's own tests, nothing makes the start certain. */
  request?: ResearchRequest;
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
  /** The goal of `start_research`: research started. */
  let goal: string | null = null;
  let scopingEndsAt = Infinity;
  /** The plan stands: the window closed. */
  let plan: ResearchPlan | null = null;
  /** The answer the plan stands on, while the model may still rebuild its questions. */
  let standing: StandingPlan | null = null;
  /** The user changed the plan and its questions have not followed. */
  let rebuildOwed = false;
  let windowOpen = false;
  /** The model was sent back once for its plan. */
  let askedToPropose = false;
  let accepted: HeldDraft | null = null;
  /** The report that stands: the latest one handed in since the last delivered follow-up, with its gates' notes once they ended. */
  let held: HeldDraft | null = null;
  /** The latest draft sent back, whose report and summary an edit-only submission can reuse. */
  let editableDraft: ResearchDraft | null = null;
  /** The report a delivered follow-up superseded: what a run that fails or says nothing more still has to show. */
  let superseded: HeldDraft | null = null;
  /** What to give back if the batch refuses the start this response opened scoping with. */
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
  /** The gate that said it. */
  let sentBackBy: string | null = null;
  /** A text draft's gates cannot send it back when its tools are closed: nothing could act on that. */
  let closedForText = false;
  const isAccepted = () => accepted !== null;
  /** Researchers whose brief already holds the method, by the name their thread has (`normalizeSubagentName`). */
  const briefed = new Set<string>();
  /** The unreachable sites `fetch_url` last read, so a run's hundreds of page reads do not each read every record. */
  let unreachable: Readonly<{ at: number; sites: ReadonlyMap<string, string> }> | null = null;
  /** Whether each stored page that would open a closed host is a bot check or cannot be found, read once: a stored page never changes. */
  const blockPages = new Map<string, boolean>();
  /**
   * The researcher calls running now, by the name their thread has, which is what the store lists and stops, one entry each: a
   * second call of a name in one batch is refused, and must not take the first off.
   */
  const running = new Set<Readonly<{ name: string }>>();
  const attempts: ResearchAttempt[] = [];
  // Frozen now, read at no cost to a run that never researches: the promise settles whatever happens and nothing waits for it.
  const verifierChoice = input.deps.verifier?.frozenChoice() ?? Promise.resolve({ kind: "not_set" as const });
  const researcherChoice = input.deps.researcher?.frozenChoice() ?? Promise.resolve({ kind: "not_set" as const });
  const turns = createResearchTurns({ subagentInput: input.subagentInput, verifierChoice, ...(input.deps.verifier ? { verifierRole: input.deps.verifier } : {}),
    researcherChoice, ...(input.deps.researcher ? { researcherRole: input.deps.researcher } : {}),
    userMessage: input.userMessage });
  const researchRunId = input.researchRunId ?? input.runId;
  /** The turn this run's Continue answers, whatever it held; null for any other message. */
  const continued = continuedTurn(input.items());
  /** What the store says that Continue can pick up, asked once. It only reads. */
  let pickUp: Promise<ResearchResumeState | null> | null = null;
  /** Whether this run's row was written for it, once: only a start writes it, as a run that never starts ran no research. */
  let linking: Promise<boolean> | null = null;
  let askedToPickUp = false;
  /** Where what agents opened starts: at this research's first run, which a Continue moves back past its own. */
  let openedFrom = researchRunId;
  const sources = createResearchSources({ chatId: input.chatId, items: input.items,
    run: { branchRunIds: input.subagentInput.branchRunIds, get researchRunId() { return openedFrom; }, runId: input.runId },
    savedResults: input.savedResults, threads: input.threads, userId: input.userId });
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
    now: input.now, researchRunId, runId: input.runId, sources, turnEndsAt: () => input.subagentInput.deadlineAt, userFollowups: () => input.subagentInput.userFollowups(), userId: input.userId,
    userMessage: input.userMessage });
  const gates = [...ports.report.gates, ...input.deps.gates ?? RESEARCH_GATES];
  const rounds = createResearchRounds(async (signal) => {
    const matrix = await researchMatrix(ports.coverage, signal);
    // A confirmation the last draft's options needed counts as a new cell; only a frame with key specifications reads the records for it.
    const confirming = matrix !== null && researchKeySpecs(matrix.frame).length > 0 && researchLeadingRows(attempts.at(-1)?.draft).length > 0;
    if (!matrix || !confirming) return matrix && researchFilledCells(matrix.coverage);
    // Records that could not be read leave nothing to compare, as a matrix that could not be: the round counts neither way.
    const records = await liveRecords(signal);
    return records && researchProgressCells(matrix, records, attempts.at(-1)?.draft);
  });
  /** What building the answer from the records came to: a run composes once, however many of its ends ask. */
  let composing: Promise<string | null> | null = null;
  /** The records the main agent has been given the ids of (`researchRecordList`). */
  const listedRecords = new Set<string>();
  /** What the model last wrote without handing it in. The longer text says more: narration after a whole report written as a message must not replace it. */
  const lastWords = () => {
    if (attemptText.trim() && attemptText.length >= lastHeld.length) return researchAnswerText(attemptText, [researchNote(plan ? "incomplete" : "before_plan")]);
    return lastHeld ? researchAnswerText(lastHeld, [researchNote("not_submitted")]) : null;
  };
  /** A report going out on how the run ended: that note says it is not fully checked and why, so the plain word that a check did not finish goes. */
  const endedWith = (notes: readonly string[], ending: "run_failed" | "stopped" | "time_out") => [...notes.filter((note) => note !== researchNote("gate_failed")), researchNote(ending)];
  const wroteReport = () => Math.max(attemptText.trim().length, lastHeld.trim().length) >= REPORT_AS_TEXT_CHARACTERS;
  /** A draft no gate has finished on: an earlier draft's notes are not its own, only what the gates carry holds for it, and it is not fully checked. */
  const unchecked = (draft: ResearchDraft): HeldDraft => ({ draft, notes: [...researchCarriedNotes(gates, draft, attempts), researchNote("gate_failed")] });
  /** The plan stands: research proper starts, and its phases count from here. */
  const planStands = (stands: ResearchPlan) => {
    plan = stands;
    ports.time.planReleased();
  };
  /**
   * The research a Continue may pick up: the run its turn's start names, or, with that call's record lost (a transcript write is bookkeeping), the turn's own run.
   * A store that fails costs the pick-up, never the run; only Stop goes on as what it is.
   */
  function pickedUp(): Promise<ResearchResumeState | null> {
    const from = continued && (continued.researchRun ?? input.subagentInput.branchRunIds.at(-1));
    if (!from) return Promise.resolve(null);
    const { signal } = input.subagentInput;
    pickUp ??= ports.resume.load(from, signal).catch((error: unknown) => {
      if (signal.aborted) throw error;
      logEvent("service_operation", { action: "degrade", code: "research_resume_failed", error, outcome: "degraded", run_id: input.runId, stage: "read", subsystem: "database" });
      return null;
    });
    return pickUp;
  }
  /** A row that cannot be written costs the pick-up, never the run: that start is a start over. */
  function linked(state: ResearchResumeState): Promise<boolean> {
    const { signal } = input.subagentInput;
    linking ??= ports.resume.link(state, signal).then(() => true, (error: unknown) => {
      if (signal.aborted) throw error;
      logEvent("service_operation", { action: "degrade", code: "research_resume_failed", error, outcome: "degraded", run_id: input.runId, stage: "write", subsystem: "database" });
      return false;
    });
    return linking;
  }
  const researching = () => goal !== null;
  /** The user chose Deep research for this message and research has not started: nothing else runs, and nothing written shows. */
  const startOwed = () => input.request === "chosen" && !researching();
  /** The run was sent back once for the start. */
  let askedToStart = false;
  /** The code of the role that refused the last start, until a start passes. */
  let startRefused: string | null = null;
  const startResearching = (started: string) => {
    goal = started;
    scopingEndsAt = input.now() + RESEARCH_TIME_MS.scoping;
  };
  /**
   * The plan row of this run: every update replaces it (`planActivityEntry`), so a reload and a second tab show the latest. One call may
   * show several states, and each is an update of its own: the run's event store takes an update id once, so a state sharing the
   * call's id with the one before would be refused and the row would stay as it was.
   */
  const showPlan = async (callId: string, state: PlanRowState, update: PlanUpdate) => {
    const entry = planActivityEntry({ callId: `${callId}:${state}`, runId: input.runId, update });
    if (entry) await input.onPlan({ ...entry, ...state === "scoping" || state === "window" ? { researchPlan: { runId: researchRunId, state } } : {} });
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

  /** A store that cannot be read costs a draft its findings and never the draft: the report check fails on the same read, and the answer says so. */
  async function liveRecords(signal: AbortSignal): Promise<readonly ResearchEvidenceRecord[] | null> {
    try {
      return await ports.evidence.records(signal);
    } catch (error) {
      if (!signal.aborted) logEvent("service_operation", { action: "degrade", code: "research_records_unreadable", error, outcome: "degraded", run_id: input.runId, stage: "read", subsystem: "database" });
      return null;
    }
  }

  /** A transcript keeps only a draft's ids, so a draft an approval rebuilt has no findings until the records fill them. One that has them keeps its object, which a gate's memory hangs on. */
  const awaitsRecords = (draft: ResearchDraft) => draft.findings.length === 0 && (draft.recordIds?.length ?? 0) > 0;
  function fillAttempts(records: readonly ResearchEvidenceRecord[]): void {
    for (const [index, attempt] of attempts.entries()) {
      if (awaitsRecords(attempt.draft)) attempts[index] = { ...attempt, draft: researchDraftWithRecords(attempt.draft, records) };
    }
  }
  /** A research whose earlier turn left no record: what those turns' gates said is gone, so their caps reopen, and the log says so. */
  function historyLost({ historyCut }: Pick<ContinuedTurn, "historyCut">): void {
    if (historyCut) logEvent("service_operation", { action: "degrade", code: "research_history_cut", outcome: "degraded", run_id: input.runId, stage: "read", subsystem: "database" });
  }
  /** The same for what a turn left, and for `rebuilt`, the draft it held, unless a newer one stands by now. */
  function fillFromTurn(records: readonly ResearchEvidenceRecord[], rebuilt: HeldDraft | null): void {
    fillAttempts(records);
    if (rebuilt && held === rebuilt) held = unchecked(researchDraftWithRecords(rebuilt.draft, records));
  }

  async function check(submitted: ResearchDraft, execution: EngineToolExecution, toolsOpen: boolean): Promise<ResearchDraft | null> {
    if (!plan) return null;
    // A linked record can be the draft's first citation, so assembly reads records even when no id was supplied.
    const records = submitted.recordIds !== undefined || attempts.some((earlier) => awaitsRecords(earlier.draft)) ? await liveRecords(execution.signal) : null;
    if (records) fillAttempts(records);
    const draft = records ? researchDraftWithRecords(researchDraftWithLinkedRecords(submitted, records), records) : submitted;
    editableDraft = null;
    held = unchecked(draft);
    const attempt = attempts.length + 1;
    await rounds.settle(execution.signal);
    const outcome = await runResearchGates({ draft, gates, runId: input.runId, context: {
      attempt,
      coverage: ports.coverage,
      earlier: [...attempts],
      evidence: ports.evidence,
      plan,
      researchersClosed: () => rounds.stopped() ? "no_new_cell" : ports.time.researcherRefusal() === null ? null : "time",
      signal: execution.signal,
      sources,
      subagents: { run: (request, signal) => turns.run(request, { attempt, round: execution.round, signal }) },
      time: { remainingMs: () => ports.time.gatesEndAt(input.gatesEndAt) - input.now(), sendBackAllowed: () => toolsOpen && input.toolTimeLeft() },
      verifierModel: () => turns.verifierModel()
    } });
    attempts.push(outcome.kind === "sent_back" ? { draft, gate: outcome.gate, message: outcome.message } : { draft, message: null });
    held = { draft, notes: outcome.notes ?? [] };
    if (outcome.kind === "accepted") {
      accepted = { draft, notes: [...outcome.notes, ...draft.findings.length === 0 ? [researchNote("no_findings")] : []] };
      sentBack = null;
      sentBackBy = null;
    } else {
      sentBack = outcome.message;
      sentBackBy = outcome.gate;
      editableDraft = draft;
    }
    return draft;
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
    // The clock's limit lasts as long as the signal it hangs on, so a call that ends takes its timer and its listener with it.
    const ended = new AbortController();
    const signal = ports.time.researcherSignal(AbortSignal.any([execution.signal, ended.signal]));
    const researcher = { name: normalizeSubagentName(call.arguments.name) ?? "" };
    running.add(researcher);
    try {
      return await turns.researcherCall(tool, { ...execution, call, signal });
    } catch (error) {
      if (execution.signal.aborted || !signal.aborted) throw error;
      return await researcherEnded(execution, call, researcher.name);
    } finally {
      running.delete(researcher);
      ended.abort();
    }
  }

  /**
   * A researcher's call as part of its round. One whose turn ran counts for the round, and its result ends with what is still empty, which is
   * where the main agent reads what to do next. That goes for a failed turn too: failures must not restart until time ends, and what one saved counts.
   */
  async function researcherOfRound(tool: EngineTool, execution: EngineToolExecution, call: ModelToolCall): Promise<ToolExecutionResult> {
    const result = await underTime(tool, execution, call);
    if (!turnRan(result)) return result;
    rounds.ran(execution.round);
    const matrix = await researchMatrix(ports.coverage, execution.signal);
    if (!matrix) return result;
    const records = await liveRecords(execution.signal);
    const line = researchCoverageLine(matrix, await rounds.newCells(researchFilledCells(matrix.coverage)), researchUnconfirmedKeyCells(matrix, records ?? [], attempts.at(-1)?.draft));
    // Beside it, the options agents noted that are neither a row nor set aside: the main agent decides on each before a draft.
    const candidates = researchCandidatesLine(matrix.frame);
    const list = records && researchRecordList(records, listedRecords);
    return { ...result, content: [...result.content, { text: line, type: "text" }, ...candidates ? [{ text: candidates, type: "text" as const }] : [],
      ...list ? [{ text: list, type: "text" as const }] : []] };
  }

  /** A Continue's start: the plan stands as its row keeps it, its phases start afresh, and the model reads what is filled before it plans a round. */
  async function pickUpResearch(call: ModelToolCall, execution: Pick<EngineToolExecution, "persistedToolCallId" | "signal">, turn: ContinuedTurn, state: ResearchResumeState): Promise<ToolExecutionResult> {
    const stands = researchPlanFromProposal(state.goal, state.answer.plan);
    goal = state.goal;
    historyLost(turn);
    // Before the draft: what the gates carry for it comes from these.
    attempts.push(...turn.attempts);
    const rebuilt = turn.draft && unchecked(turn.draft);
    held = rebuilt ?? held;
    editableDraft = turn.draftChecked === "sent_back" ? turn.draft : null;
    if (turn.owedRebuild) {
      rebuildOwed = true;
      standing = turn.owedRebuild;
    }
    planStands(stands);
    const [matrix, records] = await Promise.all([researchMatrix(ports.coverage, execution.signal), liveRecords(execution.signal)]);
    if (records) fillFromTurn(records, rebuilt);
    openedFrom = records?.[0]?.runId ?? state.fromRunId;
    const cells = matrix && pickedUpCells(matrix.coverage.filled, matrix.coverage.cells.length);
    const shown = researchPlanUpdate(stands);
    await showPlan(execution.persistedToolCallId, "stands", { ...shown, plan: [{ status: "completed", step: `${PICKED_UP_LINE}${cells ? `: ${cells}` : ""}` }, ...shown.plan] });
    const { questions, skipped_source_classes } = researchPlanProposalDocument(state.answer.plan);
    // No researcher need follow, so this is where the ids a draft cites come from. It rides behind the server's fields, whatever its length.
    const list = records && researchRecordList(records, listedRecords, PICKED_UP_RECORD_LIST_CHARACTERS);
    const candidates = matrix && researchCandidatesLine(matrix.frame);
    // The server's fields, first and in this order: a later approval or Continue reads them back (`researchOfTurn`).
    const result = resultOf(call, { research_run: researchRunId, status: "resumed", opened_from: openedFrom, plan: { goal: state.goal, questions, skipped_source_classes },
      instructions: [PICKED_UP, ...records ? [`${records.length} records stand.${list ? " The ids a draft cites them by end this result." : ""}`] : [],
        ...matrix ? [researchCoverageLine(matrix, null, researchUnconfirmedKeyCells(matrix, records ?? [], attempts.at(-1)?.draft)), ...candidates ? [candidates] : []] : [],
        ...turn.draft ? [DRAFT_LEFT[turn.draftChecked ?? "unfinished"]] : [], ...rebuildOwed ? [REBUILD_FIRST] : []].join("\n"),
      ...rebuildOwed ? {} : { method: researchMethodText(stands) } });
    return list ? { ...result, content: [...result.content, { text: list, type: "text" }] } : result;
  }

  const startTool: EngineTool = {
    activity: researchActivity("Started"),
    definition: startResearchTool,
    effects: "local",
    observationSource: "workspace",
    execute: async ({ call, persistedToolCallId, signal }) => {
      const decoded = decodeResearchStart(call.arguments);
      if (!decoded.ok) return harnessToolError(call, "research_goal_invalid", decoded.message);
      // Before `unconfirmedStart` clears: a role nobody can use gives the start back, so the run stays an ordinary one, or one the user's choice fails.
      const refused = await turns.startRefusal();
      startRefused = refused?.code ?? null;
      if (refused) return harnessToolError(call, refused.code, refused.message);
      if (!researching()) startResearching(decoded.value.goal);
      unconfirmedStart = null;
      const state = await pickedUp();
      const written = state !== null && await linked(state);
      if (plan) return harnessToolError(call, "research_plan_stands", "Research already runs and its plan stands: go on with it.");
      if (continued && state && written) return pickUpResearch(call, { persistedToolCallId, signal }, continued, state);
      await showPlan(persistedToolCallId, "scoping", { plan: [{ status: "in_progress", step: PLANNING_LINE }] });
      // The server's fields, first so an excerpt would keep them: an approval continuation reads them back (`researchRunOf`).
      return resultOf(call, { research_run: researchRunId, status: "scoping",
        instructions: [...continued?.goal === undefined ? [] : [NOTHING_PICKED_UP], researchScopingInstructions()].join("\n") });
    }
  };

  /** Why a plan call cannot run now, or null when it can. */
  function planRefusal(call: ModelToolCall): ToolExecutionResult | null {
    if (!researching()) return harnessToolError(call, "research_not_started", `Nothing was shown: call ${START_RESEARCH_TOOL_NAME} first, or answer the user directly if this needs no research.`);
    if (windowOpen) return harnessToolError(call, "research_plan_window_open", "Your plan is with the user; wait for its result.");
    if (plan && !standing) return harnessToolError(call, "research_plan_stands", "The plan stands, so nothing was changed.");
    return null;
  }

  /** A rebuilt plan: the model's questions and criteria under the words the user left, whatever the call says of those. */
  function rebuiltProposal(call: ModelToolCall, on: StandingPlan): DecodedResearch<ResearchPlanProposal> {
    const decoded = decodeResearchPlanAnswer({ changed: on.changed, plan: { ...call.arguments, ...on.words ?? {} }, released_by: on.releasedBy });
    return decoded.ok ? { ok: true, value: decoded.value.plan } : decoded;
  }

  /** What the model reads when a plan stands. The fields keep this order: `researchOfTurn` reads them back from a stored result, excerpted or not. */
  function planResult(call: ModelToolCall, answer: ResearchPlanAnswer, status: "rebuilt" | "released", instructions: string, method: ResearchPlan | null) {
    return resultOf(call, { status, changed: answer.changed, released_by: answer.releasedBy, user_plan: wordsOf(answer.plan), instructions,
      ...method ? { method: researchMethodText(method) } : {} });
  }

  async function rebuildPlan(call: ModelToolCall, on: StandingPlan, execution: EngineToolExecution, researched: string): Promise<ToolExecutionResult> {
    const decoded = rebuiltProposal(call, on);
    if (!decoded.ok) return harnessToolError(call, "research_plan_invalid", decoded.message);
    await ports.planWindow.open({ goal: researched, proposal: decoded.value, signal: execution.signal });
    const rebuilt = researchPlanFromProposal(researched, decoded.value);
    rebuildOwed = false;
    planStands(rebuilt);
    await showPlan(execution.persistedToolCallId, "stands", researchPlanUpdate(rebuilt));
    return planResult(call, { changed: on.changed, plan: decoded.value, releasedBy: on.releasedBy }, "rebuilt", "The plan stands with your rebuilt questions.", rebuilt);
  }

  const proposeTool: EngineTool = {
    activity: researchActivity("Plan"),
    definition: proposeResearchPlanTool,
    effects: "local",
    observationSource: "workspace",
    execute: async (execution) => {
      const { call, persistedToolCallId, signal } = execution;
      const refusal = planRefusal(call);
      if (refusal) return refusal;
      // A start in the same response may not have been refused yet: no window opens on a role nobody can use.
      const unusable = await turns.startRefusal();
      if (unusable) return harnessToolError(call, unusable.code, unusable.message);
      const researched = goal!;
      if (standing) return rebuildPlan(call, standing, execution, researched);
      const decoded = decodeResearchPlanProposal(call.arguments);
      if (!decoded.ok) return harnessToolError(call, "research_plan_invalid", decoded.message);
      windowOpen = true;
      let answer: ResearchPlanAnswer;
      try {
        // Opened first, so the route finds the window as soon as the card shows it, and Stop may reject it while the card is written.
        const closing = ports.planWindow.open({ goal: researched, proposal: decoded.value, signal });
        closing.catch(() => undefined);
        await showPlan(persistedToolCallId, "window", stepsUpdate(decoded.value));
        answer = await closing;
      } finally {
        windowOpen = false;
      }
      // A Stop during the window's closing write still gets its answer, and a stopped run has no plan to release.
      signal.throwIfAborted();
      const stands = researchPlanFromProposal(researched, answer.plan);
      planStands(stands);
      const fromChat = answer.releasedBy === "chat_message";
      rebuildOwed = answer.changed;
      standing = answer.changed || fromChat ? { changed: answer.changed, releasedBy: answer.releasedBy, words: wordsOf(answer.plan) } : null;
      if (answer.changed) {
        await showPlan(persistedToolCallId, "words", stepsUpdate(answer.plan));
        return planResult(call, answer, "released", `The user changed your plan. user_plan holds the user's own words, and they outrank yours. Call ${PROPOSE_RESEARCH_PLAN_TOOL_NAME} ` +
          "again now with your questions, criteria and rows rebuilt from them; no window opens, and no researcher can start until you do.", null);
      }
      await showPlan(persistedToolCallId, "stands", researchPlanUpdate(stands));
      return planResult(call, answer, "released", fromChat
        ? `The user wrote to you while the plan was on the screen. Their message comes right after this result and counts as their edit of the plan: if it changes the plan, call ${PROPOSE_RESEARCH_PLAN_TOOL_NAME} ` +
          "again with your questions rebuilt from it before you start researchers."
        : "The plan stands as you proposed it.", stands);
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
      if (!plan) {
        return refused("research_not_started", researching() ? `Nothing was checked: the plan comes first. Call ${PROPOSE_RESEARCH_PLAN_TOOL_NAME}.`
          : `Nothing was checked: call ${START_RESEARCH_TOOL_NAME} first, or answer the user directly if this needs no research.`);
      }
      if (checking) return refused("research_check_running", "Another report is being checked; wait for its result.");
      const fromText = call.id.startsWith(TEXT_DRAFT_CALL);
      const decoded: DecodedResearch<ResearchDraft> = decodeResearchDraft(call.arguments, editableDraft);
      if (!decoded.ok) return refused("research_draft_invalid", decoded.message);
      checking = true;
      let checked: ResearchDraft | null;
      try {
        checked = await check(fromText ? { ...decoded.value, origin: "plain_text" } : decoded.value, execution, !closedForText);
      } finally {
        checking = false;
      }
      // Store only the server's additions, before a possibly excerpted message. Replay keeps these even if later records make a URL ambiguous.
      const added = checked?.recordIds?.filter((id) => !decoded.value.recordIds?.includes(id)) ?? [];
      const citations = added.length > 0 ? { auto_cited_record_ids: added } : {};
      if (isAccepted()) return resultOf(call, { status: "accepted", ...citations, message: "The report is shown to the user exactly as you wrote it. Your answer is complete." });
      input.rearmReservedCall();
      // The fields keep this order: `researchOfTurn` reads the gate back by its place.
      return resultOf(call, { status: "sent_back", ...sentBackBy === null ? {} : { gate: sentBackBy }, ...citations, message: `${SENT_BACK_START}${lastWord() ?? ""}${SENT_BACK_EDITS_END}`.trim() });
    }
  };

  return {
    /** This run's ports, for what the engine wires beside the run (a sub-agent's `record_evidence` writes through `ports.evidence`). */
    ports,
    reservedCall: { instruction: researchDraftReservedInstruction(), name: SUBMIT_RESEARCH_DRAFT_TOOL_NAME },
    tools: [startTool, submitTool, proposeTool] as readonly EngineTool[],

    /** Once the plan stands the reserved draft is owed; an accepted one, or one being checked, is not. */
    outstanding: () => plan !== null && accepted === null && !checking,
    /** From `start_research` on, the round's text stays out of the answer, and so does all of it before a start the user's choice owes. */
    holding: () => researching() || startOwed(),

    /**
     * A Continue's research is offered only on the store's word that the turn before was interrupted (`ResearchResumePort.interrupted`): a typed
     * word after a research that ended starts nothing. A store that fails costs the offer, never the run; only Stop goes on as what it is.
     */
    async continues(): Promise<boolean> {
      const { signal } = input.subagentInput;
      try {
        return await ports.resume.interrupted(signal);
      } catch (error) {
        if (signal.aborted) throw error;
        logEvent("service_operation", { action: "degrade", code: "research_resume_failed", error, outcome: "degraded", run_id: input.runId, stage: "read", subsystem: "database" });
        return false;
      }
    },

    /**
     * How the turn fails when the user chose Deep research and it ended without starting it, null for every other turn: under the code of the role that refused
     * its last start (Research, Roles), since a start a store's hiccup refused may succeed when the model calls it again, or as never started.
     */
    startMissed: (): Readonly<{ code: string; message: string }> | null => !startOwed() ? null : startRefused ? { code: startRefused,
      message: "Deep research could not start: a model assigned to research is unavailable. An administrator must check it in Defaults & roles." } : NOT_STARTED,
    /** The matrix may grow: the plan stands and can no longer be rebuilt, which replaces only a frame nobody changed. */
    frameOpen: () => plan !== null && standing === null,
    heldToken(delta: string): void {
      attemptText += delta;
    },
    /** The provider's attempt failed and is sent again, so what it streamed is no one's. */
    discardAttempt(): void {
      attemptText = "";
    },
    roundText(text: string): void {
      attemptText = "";
      if (researching() && text.trim()) lastHeld = text;
    },

    /**
     * A provider response completed, before any record of it is written or any of its calls sent: research starts here
     * for all of them at once, and a report it holds is the run's whatever happens next. `calls` are all it made, `runnable`
     * those that may run: a call in a round closed to it starts nothing, but its report is still the provider's complete text.
     */
    responseCompleted(response: Readonly<{ calls: readonly ModelToolCall[]; runnable: readonly ModelToolCall[] }>): void {
      if (!researching()) {
        for (const call of response.runnable) {
          if (call.name !== START_RESEARCH_TOOL_NAME) continue;
          const decoded = decodeResearchStart(call.arguments);
          if (!decoded.ok) continue;
          unconfirmedStart = { held };
          startResearching(decoded.value.goal);
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
      goal = null;
      scopingEndsAt = Infinity;
    },

    /**
     * What the batch dispatches through: past scoping's limit, between `start_research` and the plan standing, every tool but the plan
     * reads as one the run has not got, so a refusal comes before anything runs, a call already running finishes, and the loop's corrections
     * bound a model that ignores it. So does every tool but the start while a start the user's choice owes has not been made. Any other run,
     * or one past its plan, gets the registry's own answers.
     */
    withScopingLimit<T extends Pick<ToolRegistry, "replacement" | "resolve">>(registry: T): T {
      const first = (name: string) => name !== START_RESEARCH_TOOL_NAME && startOwed();
      const over = (name: string) => name !== PROPOSE_RESEARCH_PLAN_TOOL_NAME && researching() && plan === null && input.now() >= scopingEndsAt;
      return { ...registry,
        replacement: (name: string) => first(name) ? START_FIRST : over(name) ? researchScopingOverMessage() : registry.replacement?.(name),
        resolve: (name: string) => first(name) || over(name) ? undefined : registry.resolve(name) };
    },

    /**
     * While research runs, the server owns what a researcher gets: its first brief ends with the method and its source
     * classes, and it runs in the foreground, because Stop spares background sub-agents and must end all research.
     */
    withResearcherBriefs(tools: readonly EngineTool[]): readonly EngineTool[] {
      return tools.map((tool): EngineTool => tool.definition.name === STOP_SUBAGENT_TOOL_NAME ? { ...tool,
        execute: (execution) => plan ? turns.researcherCall(tool, execution) : tool.execute(execution)
      } : tool.definition.name !== CALL_SUBAGENT_TOOL_NAME ? tool : { ...tool, execute: async (execution) => {
        const { call } = execution;
        if (!researching()) return await pickedUp() ? harnessToolError(call, "research_pick_up_first", PICK_UP_FIRST) : tool.execute(execution);
        // A message to a background sub-agent already running on the branch is no researcher: it goes to its mailbox as written,
        // outside research's rounds, briefs and clock, whose end would otherwise stop that sub-agent.
        // Without `background`, the rare turn that ends between this read and the handler's own continues in the foreground, which Stop ends.
        if (await turns.runningInBackground(execution)) {
          const { background: _background, ...message } = call.arguments;
          void _background;
          return tool.execute({ ...execution, call: { ...call, arguments: message } });
        }
        if (!plan) return harnessToolError(call, "research_plan_first", RESEARCHERS_AFTER_PLAN);
        if (rebuildOwed) return harnessToolError(call, "research_plan_rebuild_first", REBUILD_FIRST);
        const closed = ports.time.researcherRefusal();
        if (closed !== null) return harnessToolError(call, "research_researchers_closed", closed);
        await rounds.enter(execution.round, execution.signal);
        if (rounds.stopped()) return harnessToolError(call, "research_no_new_cell", researchNoNewCellMessage());
        const { background: _background, ...foreground } = call.arguments;
        void _background;
        const { message } = foreground;
        const name = normalizeSubagentName(foreground.name);
        if (typeof message !== "string" || name === null) return researcherOfRound(tool, execution, { ...call, arguments: foreground });
        const matrix = await researchMatrix(ports.coverage, execution.signal);
        const records = await ports.evidence.records(execution.signal);
        if (briefed.has(name)) return researcherOfRound(tool, execution, { ...call, arguments: { ...foreground, message: researcherMatrixBrief(message, matrix, records) } });
        const brief = researcherBrief(message, plan, matrix, records);
        if (brief === null) return harnessToolError(call, "research_brief_too_long", "Nothing started: this brief leaves no room for the research method. Shorten it and call again.");
        briefed.add(name);
        // Researchers work on these questions now, so the plan no longer changes.
        standing = null;
        return researcherOfRound(tool, execution, { ...call, arguments: { ...foreground, message: brief } });
      } });
    },

    /**
     * The hosts this research closed, for `fetch_url` (`researchUnreachableSites`): read again after a few seconds, and a failed read
     * keeps the last list, so a store's hiccup never fails a page read. A read that would open a closed host counts once its stored
     * page is read and is no bot check (`isBotCheckPage`, on the text alone); a page that cannot be found opens nothing.
     */
    async unreachableSites(signal: AbortSignal): Promise<ReadonlyMap<string, string>> {
      const now = input.now();
      if (unreachable && now - unreachable.at < UNREACHABLE_SITES_FRESH_MS) return unreachable.sites;
      try {
        const records = await ports.evidence.records(signal);
        const closed = new Set(records.flatMap((record) => record.kind === "unreachable" ? researchSiteHost(record.target) ?? [] : []));
        for (const record of records) {
          const host = researchReadHost(record);
          if (!host || !closed.has(host) || blockPages.has(record.pageId!)) continue;
          const page = await ports.evidence.page(record.pageId!, signal);
          blockPages.set(record.pageId!, page === null || isBotCheckPage({ kind: "text", text: page.text, title: null, truncated: page.truncated }, new Uint8Array()));
        }
        const sites = researchUnreachableSites(records, (pageId) => blockPages.get(pageId) ?? true);
        unreachable = { at: now, sites };
        return sites;
      } catch (error) {
        if (signal.aborted) throw error;
        return unreachable?.sites ?? new Map();
      }
    },

    /** The loop asks before each round whether the turn's answer is already taken, so no paid round follows. */
    answerTaken(input_: Readonly<{ toolChoice: LoopToolChoice }>): boolean {
      if (accepted) return true;
      if (input_.toolChoice !== "none" || !plan || !held) return false;
      // Tools closed with a draft in hand: tool-free text could only repeat it. It goes out as it stands, with what its gates said, and time is named only when it is why.
      accepted = { draft: held.draft, notes: input.toolTimeLeft() ? held.notes : endedWith(held.notes, "time_out") };
      return true;
    },

    /**
     * A response without calls while research runs. It is asked once for the call while tools are open; after that the
     * report it handed in stands, or with none its text goes through the gates as the draft. The message goes back to the
     * model when the gates send it back. Before the plan there is nothing to check: it is asked once for the plan, and after that the
     * turn ends with its text (`finish`).
     */
    async responseEnded(ended: Readonly<{ round: number; runDraftCall(call: ModelToolCall, round: number): Promise<unknown>; text: string; toolsClosed: boolean }>):
      Promise<TranscriptUserItem | null> {
      const server = (text: string): TranscriptUserItem => ({ id: randomUUID(), kind: "user", text });
      const toolsOpen = !ended.toolsClosed && input.toolTimeLeft();
      // The user chose Deep research and the model answered without starting it: sent back once, and after that the turn fails (`startMissed`).
      if (startOwed()) {
        if (!toolsOpen || askedToStart) return null;
        askedToStart = true;
        return server(START_NOW);
      }
      // Text answering a Continue with research to pick up: it is asked once for the start, and after that its text is the ordinary answer it is.
      if (!researching() && ended.text.trim() && toolsOpen && !askedToPickUp && await pickedUp()) {
        askedToPickUp = true;
        return server(PICK_UP_FIRST);
      }
      if (researching() && !plan && ended.text.trim() && toolsOpen && !askedToPropose) {
        askedToPropose = true;
        return server(PROPOSE_FIRST);
      }
      if (!plan || accepted || !ended.text.trim()) return null;
      if (toolsOpen && !asked) {
        asked = true;
        return server(SUBMIT_FIRST);
      }
      // A report handed in stays the report: a message never replaces it, whatever it says.
      if (held) {
        accepted = { draft: held.draft, notes: toolsOpen ? held.notes : endedWith(held.notes, "time_out") };
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
      if (accepted) return researchAnswerText(researchDraftText(accepted.draft), accepted.notes);
      if (!researching() || waiting) return null;
      if (!plan) return lastHeld ? researchAnswerText(lastHeld, [researchNote("not_submitted")]) : null;
      if (held) return researchAnswerText(researchDraftText(held.draft), held.notes);
      if (superseded) return researchAnswerText(researchDraftText(superseded.draft), [...superseded.notes, researchNote("followup_not_applied")]);
      return null;
    },

    /** What the answer keeps when the run stops or fails with a report in hand; a stopped run shows only a report, never narration. */
    afterEnding(reason: "failed" | "stopped" | "timed_out"): string | null {
      if (accepted) return researchAnswerText(researchDraftText(accepted.draft), accepted.notes);
      const report = held ?? superseded;
      if (report) {
        return researchAnswerText(researchDraftText(report.draft), [...endedWith(report.notes, reason === "stopped" ? "stopped" : reason === "timed_out" ? "time_out" : "run_failed"),
          ...held ? [] : [researchNote("followup_not_applied")]]);
      }
      // What a run wrote before a start the user's choice owed is no research and no answer.
      if (reason === "stopped" || startOwed()) return null;
      return plan ? null : lastWords();
    },

    /**
     * The answer the server builds from the records when `finish` or `afterEnding` had no report, never for a stopped run or one waiting for the user. What the model last
     * wrote takes its place at report length, or with nothing recorded. Apart from them because it reads a store, and they answer at once. `stop` is what ends the
     * run's Stop, not its deadline: the deadline may be what ended it. A second end, such as a failure to publish, gets the first one's result.
     */
    composed(ended: ResearchReportEnding, stop: AbortSignal): Promise<string | null> {
      if (!plan) return Promise.resolve(null);
      if (!stop.aborted && wroteReport()) return Promise.resolve(lastWords());
      composing ??= compose(ended, stop);
      return composing.then((built) => built ?? (stop.aborted ? null : lastWords()));
    },

    /** An approval continuation goes on with the research its turn started; a Continue comes through the start, and every other later turn is an ordinary one. */
    resume(items: readonly TranscriptItem[]): void {
      const found = researchOfTurn(items);
      historyLost(found);
      if (found.goal !== undefined) startResearching(found.goal);
      // A stored value: it counts only on this branch, as in `researchRunOf`.
      if (found.openedFrom !== undefined && input.subagentInput.branchRunIds.includes(found.openedFrom)) openedFrom = found.openedFrom;
      if (found.plan) planStands(found.plan);
      if (found.owedRebuild) {
        rebuildOwed = true;
        standing = found.owedRebuild;
      }
      // Before the draft: what the gates carry for it comes from these.
      attempts.push(...found.attempts);
      if (found.draft) held = unchecked(found.draft);
      editableDraft = found.draftChecked === "sent_back" ? found.draft : null;
      // Resuming answers at once and the records take a read, which is done before the model's first response ends.
      const rebuilt = held;
      if (!attempts.some(({ draft }) => awaitsRecords(draft)) && !(rebuilt && awaitsRecords(rebuilt.draft))) return;
      void liveRecords(AbortSignal.timeout(RESEARCH_TIME_MS.composeReport)).then((records) => {
        if (records) fillFromTurn(records, rebuilt);
      });
    },

    stopAll: (reason: SubagentStopReason) => turns.stopAll(reason)
  };
}

/** What the gates said of a draft and which one said it, from its call's stored result; `message` null when they accepted it, and undefined when they never ended on it. */
function gatesWord(result: Extract<TranscriptItem, { kind: "tool_result" }> | undefined): Pick<ResearchAttempt, "gate" | "message"> | undefined {
  if (result?.outcome !== "complete") return undefined;
  const gate = SENT_BACK_BY.exec(result.output)?.[1];
  const by = gate === undefined ? {} : { gate };
  let parsed: unknown;
  try {
    // A repeat note may follow the JSON (`repeatIdenticalNote`).
    parsed = JSON.parse(result.output.slice(0, result.output.lastIndexOf("}") + 1));
  } catch {
    // An excerpt keeps the gate's name and loses its words, which a cap does not need.
    return gate === undefined ? undefined : { ...by, message: "" };
  }
  const { message, status } = (parsed ?? {}) as { message?: unknown; status?: unknown };
  if (status === "accepted") return { message: null };
  if (status !== "sent_back" || typeof message !== "string") return undefined;
  const start = message.startsWith(SENT_BACK_START) ? SENT_BACK_START.length : 0;
  const ending = [SENT_BACK_END, SENT_BACK_EDITS_END].find((text) => message.endsWith(text));
  return { ...by, message: message.slice(start, ending === undefined ? undefined : -ending.length) };
}

/** Added ids fit in the stored result's head (at most one per report link); never search inside the model's message. */
function citationsOfResult(result: Extract<TranscriptItem, { kind: "tool_result" }> | undefined): readonly string[] {
  if (result?.outcome !== "complete") return [];
  const prefix = result.output.split(',"message":', 1)[0]!;
  const found = /,"auto_cited_record_ids":(\[[^\]]*\])/u.exec(prefix);
  if (!found) return [];
  try {
    const decoded = decodeResearchDraftReferences({ record_ids: JSON.parse(found[1]!) });
    return decoded.ok ? decoded.value.recordIds : [];
  } catch {
    return [];
  }
}

/** What a plan call's stored result says, excerpted or not: null when the call was refused or never returned. */
function planOfResult(result: Extract<TranscriptItem, { kind: "tool_result" }> | undefined): (StandingPlan & Readonly<{ rebuilt: boolean }>) | null {
  if (result?.outcome !== "complete") return null;
  const found = PLAN_RESULT.exec(result.output);
  if (!found) return null;
  const end = result.output.indexOf(PLAN_RESULT_WORDS_END);
  let words: ResearchPlanEdit | null = null;
  try {
    const decoded = decodeResearchPlanEdit((JSON.parse(`${result.output.slice(0, end)}}`) as { user_plan?: unknown }).user_plan);
    words = decoded.ok ? decoded.value : null;
  } catch {
    // Cut before the words ended: what the call's arguments hold still stands.
  }
  return { changed: found[2] === "true", rebuilt: found[1] === "rebuilt", releasedBy: found[3] as ResearchPlanRelease, words };
}

/** What a start that picked research up left in its stored result: where its text was, and its plan, which is no call's arguments. */
function pickedUpOfResult(output: string): Readonly<{ openedFrom?: string; plan?: unknown }> {
  if (!PICKED_UP_START.test(output)) return {};
  try {
    const { opened_from: openedFrom, plan } = JSON.parse(`${output.slice(0, output.indexOf(PLAN_RESULT_WORDS_END))}}`) as { opened_from?: unknown; plan?: unknown };
    return { ...typeof openedFrom === "string" ? { openedFrom } : {}, plan };
  } catch {
    // Cut before the plan ended: a plan call puts one back on the row that stands.
    return {};
  }
}

/**
 * What a turn's items hold of its research: its calls since the last message of the user's or the server's own. `attempts` are
 * the drafts the gates ended on with what they said and which gate sent each back, rebuilt with new objects for an approval continuation:
 * what a gate keeps by object identity is gone, so a gate that must remember reads these (`verifier.ts`), and they are what keeps a
 * gate to its cap across an approval. `goal` is there once research started and
 * `plan` once it stands: a person never edits questions, so they come from the arguments of the last plan call the window answered,
 * which stay whole however its long result was excerpted, and an older start holds its whole plan itself. `owedRebuild` is a changed
 * plan whose questions have not followed. `researchRun` is what the start call's stored result names, there only when it names one,
 * as no older result does; a stored value, so it means nothing until `researchRunOf` has checked it. A start that picked research up has no plan
 * call in its turn, so its plan comes from its result, with `openedFrom`, the run what agents opened starts in, as much a stored value as the other.
 *
 * Such a start is not where its research began, so the reading goes on past the Continue into the turn it picked up, up to the research's first start, and the gates' history,
 * the draft and an owed rebuild add up across the chain: a Continue buys no checks, and rejected claims stay named. Everything else comes from the newest start. These are the
 * branch's own items and they only ever hold a run to more. `items` keep a whole transcript, as a compaction acts where a request is built (`transcript.ts`), so what cuts this short
 * is an earlier turn whose records were lost: `historyCut` says so, what was found stands, and what the lost turn's gates said is gone. `draftChecked` is what the gates came to on `draft`,
 * absent when they never ended on it.
 */
export function researchOfTurn(items: readonly TranscriptItem[]): Readonly<{ attempts: readonly ResearchAttempt[]; draft: ResearchDraft | null; draftChecked?: "accepted" | "sent_back"; goal?: string;
  historyCut?: true; openedFrom?: string;
  owedRebuild?: StandingPlan; plan: ResearchPlan | null; researchRun?: string }> {
  const attempts: ResearchAttempt[] = [];
  const submissions: { parsed: unknown; result: Extract<TranscriptItem, { kind: "tool_result" }> | undefined }[] = [];
  const results = new Map<string, Extract<TranscriptItem, { kind: "tool_result" }>>();
  let draft: ResearchDraft | null = null;
  let draftChecked: "accepted" | "sent_back" | undefined;
  let goal: string | undefined;
  let openedFrom: string | undefined;
  let plan: ResearchPlan | null = null;
  let proposed: Readonly<Record<string, unknown>> | null = null;
  let released: StandingPlan | null = null;
  let rebuilt = false;
  let researchRun: string | undefined;
  const ownCall = (name: string) => name === START_RESEARCH_TOOL_NAME || name === PROPOSE_RESEARCH_PLAN_TOOL_NAME || name === SUBMIT_RESEARCH_DRAFT_TOOL_NAME;
  /** The research's first start was reached. */
  let began = false;
  /** A start that picked research up was reached, and the Continue before it has not been. */
  let pickedUpBehind = false;
  for (let index = items.length - 1; index >= 0 && !began; index -= 1) {
    const item = items[index]!;
    if (item.kind === "user" && item.id.startsWith("msg-")) {
      if (!pickedUpBehind) break;
      pickedUpBehind = false;
      continue;
    }
    if (item.kind === "tool_result" && ownCall(item.name)) results.set(item.callId, item);
    if (item.kind !== "tool_call" || !ownCall(item.name)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(item.arguments);
    } catch {
      continue;
    }
    if (item.name === START_RESEARCH_TOOL_NAME) {
      const started = results.get(item.callId);
      // A start refused, such as a second one under a plan that stands, began nothing.
      if (started?.outcome === "error") continue;
      const output = started?.outcome === "complete" ? started.output : "";
      const older = SCOPING_STARTED.test(output) ? null : decodeResearchPlan(parsed);
      const start = decodeResearchStart(parsed);
      if (!start.ok) continue;
      pickedUpBehind = PICKED_UP_START.test(output);
      began = !pickedUpBehind;
      if (goal !== undefined) continue;
      const picked = pickedUpOfResult(output);
      const pickedPlan = isObject(picked.plan) ? picked.plan : null;
      // A Continue's goal is the row's, whatever words the model's call used.
      goal = typeof pickedPlan?.goal === "string" ? pickedPlan.goal : start.value.goal;
      openedFrom = picked.openedFrom;
      const planned = proposed ?? pickedPlan;
      const stands = older?.ok ? older : planned ? decodeResearchPlan({ ...planned, goal }) : null;
      plan = stands?.ok ? stands.value : null;
      researchRun = STARTED_RESEARCH_RUN.exec(output)?.[1];
    } else if (item.name === PROPOSE_RESEARCH_PLAN_TOOL_NAME) {
      const answered = planOfResult(results.get(item.callId));
      if (!answered) continue;
      proposed ??= parsed as Readonly<Record<string, unknown>>;
      if (answered.rebuilt) rebuilt = true;
      else released ??= { changed: answered.changed, releasedBy: answered.releasedBy, words: answered.words };
    } else {
      submissions.push({ parsed, result: results.get(item.callId) });
    }
  }
  // Walk only this research's submissions forward: every edit uses the last draft sent back, including across Continue boundaries.
  for (const submission of submissions.reverse()) {
    if (submission.result?.outcome === "error") continue;
    const decoded = decodeResearchDraft(submission.parsed, draftChecked === "sent_back" ? draft : null);
    if (!decoded.ok) continue;
    const added = citationsOfResult(submission.result);
    draft = added.length === 0 ? decoded.value : { ...decoded.value, recordIds: [...new Set([...decoded.value.recordIds ?? [], ...added])] };
    const word = gatesWord(submission.result);
    draftChecked = word === undefined ? undefined : word.message === null ? "accepted" : "sent_back";
    if (word !== undefined) attempts.push({ draft, ...word });
  }
  const owed = plan && !rebuilt ? released as StandingPlan | null : null;
  return { attempts, draft, ...draftChecked === undefined ? {} : { draftChecked }, ...goal === undefined ? {} : { goal }, ...goal !== undefined && !began ? { historyCut: true as const } : {},
    ...openedFrom === undefined ? {} : { openedFrom }, ...owed?.changed ? { owedRebuild: owed } : {}, plan,
    ...researchRun === undefined ? {} : { researchRun } };
}

type ContinuedTurn = ReturnType<typeof researchOfTurn>;

/**
 * What the turn before this run's message held, when that message is the user's Continue: the button's exact word, as the user's own message, last in
 * a run that just started. Null otherwise, so any other message, a server's turn and an approval continuation are what they are. It says nothing of
 * whether that turn was interrupted: the store knows, and nothing stored here grants anything (`resume.ts`).
 */
function continuedTurn(items: readonly TranscriptItem[]): ContinuedTurn | null {
  const last = items.at(-1);
  return last?.kind === "user" && last.id.startsWith("msg-") && last.text.trim() === CONTINUE_TURN_TEXT ? researchOfTurn(items.slice(0, -1)) : null;
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
