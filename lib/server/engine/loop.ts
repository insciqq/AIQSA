import { randomUUID } from "node:crypto";
import { RUN_FOLLOWUP_MAX_COUNT } from "../../contracts/runFollowups";
import type { ProviderRunRequest, ProviderRunResult } from "../providers/types";
import type { ModelToolCall } from "../tools/types";
import type { ToolBatchOutcome } from "./toolBatch";
import type { TranscriptItem, TranscriptToolResultItem, TranscriptUserItem } from "./transcript";

/**
 * The native agent loop (in the shape of pi-agent-core's agent loop, over
 * AIQSA's own adapters): prepare the request from the transcript, stream one
 * model response, take its text into the answer, append its items, run its
 * tool calls as one batch, append their results, take delivered follow-ups,
 * and go again until a response calls no tool. The turn stops at Stop or its
 * deadline (the signal), at an approval point (a call that waits for the
 * user ends the turn), and answers without tools once its tool rounds, call
 * budget or tool time are spent, or once a batch ran nothing; without tool
 * limits (the default) only the tool time closes tools. A batch whose
 * calls were only mistakes the model can correct (an unknown tool name,
 * malformed arguments) keeps tools for a few rounds, since its results say
 * how (issue #54). A tool-free round that still answered only with calls is
 * asked once more for the answer, and an answer that stays empty fails
 * visibly instead of completing (issue #55). The user's own follow-up starts
 * the answer over, and an answer that stays empty after it fails the same way;
 * what an agent sends (a sub-agent's callback or message) adds to the answer
 * and never empties it (operator decision 2026-11-05). A run's one reserved
 * report (a monitoring check's verdict) is offered alone once more when its call
 * budget, tool rounds or tool time ran out before it was made; past tool time
 * that round runs inside the answer reserve, and the turn's deadline still
 * ends it. A turn whose answer is written while that report is still owed,
 * and that was not offered it alone, is offered it alone once more after the
 * answer: the answer stands as written, and the round adds nothing to it. A
 * run that researches (`draft`, `lib/server/research/run.ts`) may take its
 * answer from a checked draft instead of a further model round, and has a
 * response without calls checked like one.
 * Everything the loop knows is the transcript; every effect goes through
 * its ports.
 */
export type LoopToolChoice = "auto" | "none";

export type AgentLoopPorts = Readonly<{
  /**
   * Adds items to the turn's transcript. Their durable record is bookkeeping
   * written behind the answer: it never fails the turn.
   */
  append(items: readonly TranscriptItem[]): Promise<void>;
  /**
   * Adds the items of a response whose tool calls are about to run: their
   * durable record is written before any call is sent, and a record that
   * cannot be written ends the turn without sending them.
   */
  appendCalls(items: readonly TranscriptItem[]): Promise<void>;
  callModel(request: ProviderRunRequest, round: number): Promise<ProviderRunResult>;
  /** False when a follow-up arrived after the last delivery: the turn goes on. */
  closeFollowups(): Promise<boolean>;
  /**
   * The follow-ups that arrived, now delivered. `ending`: the turn would end here (an answer, or an approval point), so
   * what they bring may follow an answer already written. An item without `callback` is the user's own follow-up.
   */
  deliverFollowups(input: Readonly<{ ending: boolean }>): Promise<readonly TranscriptUserItem[]>;
  /** A run's held draft: the turn's answer may already be taken, and a response without calls may go back to the model. */
  draft?: Readonly<{
    /** Asked before each round: the answer is taken, so no model round follows. A delivered follow-up gives it back. */
    answerTaken(input: Readonly<{ toolChoice: LoopToolChoice }>): boolean;
    /** A response completed, before any record of it is written or any of its calls sent. */
    responseCompleted(input: Readonly<{ calls: readonly ModelToolCall[]; runnable: readonly ModelToolCall[] }>): void;
    /** A response ended without calls that may run: what to send the model back with, or null when the turn may end. */
    responseEnded(input: Readonly<{ round: number; text: string; toolsClosed: boolean }>): Promise<TranscriptUserItem | null>;
  }>;
  /**
   * Tool rounds the turn may take; the next round answers without tools. Null:
   * no round count, so tools close only at the tool time (or a spent call budget).
   */
  maxToolRounds: number | null;
  /**
   * The request of one round from the transcript so far; the place compaction
   * hooks in. `reserved`: the round offers only the reserved call, and its
   * request carries the instruction that asks for it.
   */
  prepareRequest(input: Readonly<{
    /**
     * With `reserved`: the answer is already written and stands, so the round only asks for the reserved call, and the
     * loop takes none of its text into the answer (`roundEnd` gets it without text).
     */
    afterAnswer?: true;
    /** The round asks for the answer itself: its request carries `ANSWER_NOW_INSTRUCTION`. */
    answerNow?: true; reserved?: true; round: number; toolChoice: LoopToolChoice;
  }>): Promise<ProviderRunRequest>;
  /**
   * The run's one call reserved outside the tool budgets, while it has not
   * been made (`toolBatch.ts` exempts its first call from the call budget).
   */
  reservedCall?: Readonly<{ name: string; outstanding(): boolean }>;
  responseItems(result: ProviderRunResult): readonly TranscriptItem[];
  /** The response completed: its text becomes the answer's before any record of it is written. */
  roundEnd(result: ProviderRunResult, round: number): Promise<void>;
  roundStart(round: number): Promise<void>;
  runTools(calls: readonly ModelToolCall[], round: number): Promise<ToolBatchOutcome>;
  signal: AbortSignal;
  /** Whether the turn still has time for tools before it must answer. */
  toolTimeLeft(): boolean;
}>;

export type AgentLoopOutcome =
  | Readonly<{ kind: "answered"; rounds: number }>
  | Readonly<{ approvals: readonly string[]; kind: "approval"; rounds: number }>
  /**
   * The turn has no answer text, because the tool-free rounds answered only with calls or nothing followed the user's
   * follow-up that started the answer over: a failure, never a completion.
   */
  | Readonly<{ kind: "empty"; rounds: number }>;

export const NO_MORE_TOOLS_OUTPUT = "Not run: this answer may call no more tools. Answer with what you have.";

/** The request-only instruction of the one more tool-free round a response of only calls gets. */
export const ANSWER_NOW_INSTRUCTION =
  "Tools are closed for this answer. Reply to the user now in plain text with what you have; do not call any tool.";

/** Rounds a turn may spend correcting calls refused before sending (an unknown tool name, malformed arguments). */
export const MAX_CORRECTION_ROUNDS = 2;

/**
 * Close-or-deliver attempts at the end of a turn. Each failed attempt means a
 * follow-up was accepted meanwhile, and a run accepts a bounded number.
 */
export const FOLLOWUP_SETTLE_ATTEMPTS = RUN_FOLLOWUP_MAX_COUNT + 2;

/** The calls of one response, each id once. */
function distinctCalls(calls: readonly ModelToolCall[] | undefined): ModelToolCall[] {
  const seen = new Set<string>();
  return (calls ?? []).filter((call) => !seen.has(call.id) && Boolean(seen.add(call.id)));
}

function refused(call: ModelToolCall, output: string): TranscriptToolResultItem {
  return { callId: call.id, id: randomUUID(), kind: "tool_result", name: call.name, outcome: "error", output };
}

/**
 * The one round that asks for a run's reserved report after its answer is written: only that call may run, the response's
 * text is not the answer's (the answer stands, and what this round writes would only follow it), and the call gets its result
 * before the turn ends. The report is bookkeeping behind the answer: a round that fails leaves the answer as it is and the
 * report unmade (a monitoring check then counts as unreported, which is shown), while Stop and the deadline still end the
 * turn. Returns the approvals its call waits for.
 */
async function reportAfterAnswer(ports: AgentLoopPorts, reserved: NonNullable<AgentLoopPorts["reservedCall"]>,
  round: number): Promise<readonly string[]> {
  let roundEnded = false;
  try {
    await ports.roundStart(round);
    const request = await ports.prepareRequest({ afterAnswer: true, reserved: true, round, toolChoice: "auto" });
    const result = await ports.callModel(request, round);
    roundEnded = true;
    await ports.roundEnd({ ...result, finalText: "" }, round);
    const calls = distinctCalls(result.toolCalls);
    const runnable = calls.filter((call) => call.name === reserved.name);
    const items = ports.responseItems(result);
    if (runnable.length > 0) await ports.appendCalls(items);
    else await ports.append(items);
    const refusedCalls = calls.filter((call) => !runnable.includes(call));
    if (refusedCalls.length > 0) await ports.append(refusedCalls.map((call) => refused(call, NO_MORE_TOOLS_OUTPUT)));
    if (runnable.length === 0) return [];
    const batch = await ports.runTools(runnable, round);
    await ports.append(batch.results);
    return batch.approvals;
  } catch (error) {
    if (ports.signal.aborted) throw error;
    // A failed request may have streamed text before it gave up: the round ends without it, so the answer stays as written.
    if (!roundEnded) {
      await ports.roundEnd({ finalProviderResponsePreview: {}, finalText: "", toolCalls: [], usage: {} }, round).catch(() => undefined);
    }
    return [];
  }
}

/**
 * Where the turn would end (an answer, or an approval point), its follow-ups
 * are settled first, because an answer is published only with its follow-ups
 * closed at the revision it read: they close, or the ones that arrived are
 * delivered and the turn goes on with them (empty once closed).
 */
async function settleFollowups(ports: AgentLoopPorts): Promise<readonly TranscriptUserItem[]> {
  for (let attempt = 0; attempt < FOLLOWUP_SETTLE_ATTEMPTS; attempt += 1) {
    ports.signal.throwIfAborted();
    if (await ports.closeFollowups()) return [];
    const delivered = await ports.deliverFollowups({ ending: true });
    if (delivered.length > 0) return delivered;
  }
  // Publication rechecks the follow-ups; an empty delivery never buys another paid round.
  return [];
}

export async function runAgentLoop(ports: AgentLoopPorts): Promise<AgentLoopOutcome> {
  let toolsAllowed = true;
  /** A call was refused for the call budget. */
  let budgetSpent = false;
  let reservedOffered = false;
  let corrections = 0;
  /** The answer's text so far: the user's own follow-up starts it over, what an agent sends adds to it. */
  let answerText = "";
  /** The user's follow-up started the answer over: an answer that stays empty after it fails rather than completing. */
  let restarted = false;
  /** The one more tool-free round that asks for the answer: due next, or already taken. */
  let answerNow: "due" | "taken" | null = null;
  const approvals: string[] = [];
  const ended = (round: number): AgentLoopOutcome =>
    approvals.length > 0 ? { approvals, kind: "approval", rounds: round } : { kind: "answered", rounds: round };
  /**
   * Delivered follow-ups give the turn new input and open its tools again. Only the user's own follow-up starts the
   * answer over; with what agents send alone, the answer written stands and the next text follows it. A held draft owes
   * the model one more offer of its reserved call to act on them.
   */
  const goOn = (followups: readonly TranscriptUserItem[]) => {
    if (followups.some((item) => !item.callback)) {
      answerText = "";
      restarted = true;
    }
    answerNow = null;
    toolsAllowed = true;
    if (ports.draft) reservedOffered = false;
  };
  for (let round = 1; ; round += 1) {
    ports.signal.throwIfAborted();
    const timeLeft = ports.toolTimeLeft();
    const roundsSpent = ports.maxToolRounds !== null && round > ports.maxToolRounds;
    const open = toolsAllowed && !roundsSpent && timeLeft;
    // Once the call budget, the tool rounds or the tool time are spent, an outstanding reserved call is offered
    // alone in one more round; a batch without progress answers at once.
    const reserved = !open && !reservedOffered && (budgetSpent || roundsSpent || !timeLeft) &&
      ports.reservedCall?.outstanding() === true ? ports.reservedCall : null;
    if (reserved) reservedOffered = true;
    const toolChoice: LoopToolChoice = open || reserved ? "auto" : "none";
    if (ports.draft?.answerTaken({ toolChoice })) {
      const followups = await settleFollowups(ports);
      if (followups.length === 0) return ended(round - 1);
      await ports.append(followups);
      goOn(followups);
      continue;
    }
    const asking = answerNow === "due" && toolChoice === "none";
    if (asking) answerNow = "taken";
    await ports.roundStart(round);
    const request = await ports.prepareRequest({ round, toolChoice, ...(reserved ? { reserved: true as const } : {}),
      ...(asking ? { answerNow: true as const } : {}) });
    const result = await ports.callModel(request, round);
    // Answer first: the response's text is the answer's before any record of it is written.
    await ports.roundEnd(result, round);
    answerText += result.finalText;
    const calls = distinctCalls(result.toolCalls);
    const items = ports.responseItems(result);
    const runnable = toolChoice === "none" ? [] : reserved ? calls.filter((call) => call.name === reserved.name) : calls;
    ports.draft?.responseCompleted({ calls, runnable });
    if (runnable.length > 0) {
      await ports.appendCalls(items);
    } else {
      await ports.append(items);
    }
    // A call that may not run (no more tools, or another call in a reserved round) still gets its result, never a dangling call.
    const refusedCalls = calls.filter((call) => !runnable.includes(call));
    if (refusedCalls.length > 0) await ports.append(refusedCalls.map((call) => refused(call, NO_MORE_TOOLS_OUTPUT)));
    if (calls.length === 0 || toolChoice === "none") {
      // A tool-free response of only calls, which may not run, is not an answer: the round is asked once more.
      // Calls written as native markup the adapter stopped count too (issue #56).
      const callsOnly = toolChoice === "none" && (calls.length > 0 || result.synthesisToolCallForbidden === true) &&
        !result.finalText.trim();
      if (callsOnly && answerNow === null) {
        answerNow = "due";
        continue;
      }
      const sentBack = await ports.draft?.responseEnded({ round, text: result.finalText, toolsClosed: toolChoice === "none" }) ?? null;
      if (sentBack) {
        await ports.append([sentBack]);
        answerText = "";
        answerNow = null;
        continue;
      }
      // An answer written while the run's reserved report is still owed, and never offered it alone, is offered it alone
      // once more. A held draft checks its own responses without calls instead.
      const owed = !callsOnly && !ports.draft && approvals.length === 0 && !reservedOffered &&
        ports.reservedCall?.outstanding() === true ? ports.reservedCall : null;
      if (owed) {
        reservedOffered = true;
        round += 1;
        approvals.push(...await reportAfterAnswer(ports, owed, round));
      }
      // The answer is final unless a follow-up arrived: then the turn goes on with it.
      const followups = await settleFollowups(ports);
      if (followups.length === 0) {
        return (callsOnly || restarted) && approvals.length === 0 && !answerText.trim() && !ports.draft?.answerTaken({ toolChoice })
          ? { kind: "empty", rounds: round } : ended(round);
      }
      await ports.append(followups);
      goOn(followups);
      continue;
    }
    // A reserved round whose response made only other calls answers without tools next.
    if (runnable.length === 0) continue;
    const batch = await ports.runTools(runnable, round);
    await ports.append(batch.results);
    if (batch.approvals.length > 0) {
      // A call waits for the user: the turn ends there, unless a follow-up arrived meanwhile.
      approvals.push(...batch.approvals);
      const followups = await settleFollowups(ports);
      if (followups.length === 0) return ended(round);
      await ports.append(followups);
      goOn(followups);
      continue;
    }
    // A spent budget, or a batch of which nothing ran, is answered without tools; a batch of only correctable
    // mistakes keeps them for a bounded number of rounds, so the model can do what its results ask.
    if (batch.budgetExhausted) budgetSpent = true;
    const correcting = !batch.budgetExhausted && batch.executed === 0 && batch.correctable === runnable.length &&
      corrections < MAX_CORRECTION_ROUNDS;
    if (correcting) corrections += 1;
    if (batch.budgetExhausted || batch.executed === 0 && !correcting) toolsAllowed = false;
    const followups = await ports.deliverFollowups({ ending: false });
    if (followups.length > 0) {
      await ports.append(followups);
      goOn(followups);
    }
  }
}
