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
 * budget or tool time are spent. Everything the loop knows is the
 * transcript; every effect goes through its ports.
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
  deliverFollowups(): Promise<readonly TranscriptUserItem[]>;
  /** Tool rounds the turn may take; the next round answers without tools. */
  maxToolRounds: number;
  /** The request of one round from the transcript so far; the place compaction hooks in. */
  prepareRequest(input: Readonly<{ round: number; toolChoice: LoopToolChoice }>): Promise<ProviderRunRequest>;
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
  | Readonly<{ approvals: readonly string[]; kind: "approval"; rounds: number }>;

export const NO_MORE_TOOLS_OUTPUT = "Not run: this answer may call no more tools. Answer with what you have.";

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
 * Where the turn would end (an answer, or an approval point), its follow-ups
 * are settled first, because an answer is published only with its follow-ups
 * closed at the revision it read: they close, or the ones that arrived are
 * delivered and the turn goes on with them (empty once closed).
 */
async function settleFollowups(ports: AgentLoopPorts): Promise<readonly TranscriptUserItem[]> {
  for (let attempt = 0; attempt < FOLLOWUP_SETTLE_ATTEMPTS; attempt += 1) {
    ports.signal.throwIfAborted();
    if (await ports.closeFollowups()) return [];
    const delivered = await ports.deliverFollowups();
    if (delivered.length > 0) return delivered;
  }
  // Publication rechecks the follow-ups; an empty delivery never buys another paid round.
  return [];
}

export async function runAgentLoop(ports: AgentLoopPorts): Promise<AgentLoopOutcome> {
  let toolsAllowed = true;
  const approvals: string[] = [];
  const ended = (round: number): AgentLoopOutcome =>
    approvals.length > 0 ? { approvals, kind: "approval", rounds: round } : { kind: "answered", rounds: round };
  for (let round = 1; ; round += 1) {
    ports.signal.throwIfAborted();
    const toolChoice: LoopToolChoice = toolsAllowed && round <= ports.maxToolRounds && ports.toolTimeLeft() ? "auto" : "none";
    await ports.roundStart(round);
    const request = await ports.prepareRequest({ round, toolChoice });
    const result = await ports.callModel(request, round);
    // Answer first: the response's text is the answer's before any record of it is written.
    await ports.roundEnd(result, round);
    const calls = distinctCalls(result.toolCalls);
    const items = ports.responseItems(result);
    if (calls.length > 0 && toolChoice === "auto") {
      await ports.appendCalls(items);
    } else {
      await ports.append(items);
      // A response that called tools anyway gets a result for each call, never a dangling call.
      if (calls.length > 0) await ports.append(calls.map((call) => refused(call, NO_MORE_TOOLS_OUTPUT)));
    }
    if (calls.length === 0 || toolChoice === "none") {
      // The answer is final unless a follow-up arrived: then the turn goes on with it.
      const followups = await settleFollowups(ports);
      if (followups.length === 0) return ended(round);
      await ports.append(followups);
      toolsAllowed = true;
      continue;
    }
    const batch = await ports.runTools(calls, round);
    await ports.append(batch.results);
    if (batch.approvals.length > 0) {
      // A call waits for the user: the turn ends there, unless a follow-up arrived meanwhile.
      approvals.push(...batch.approvals);
      const followups = await settleFollowups(ports);
      if (followups.length === 0) return ended(round);
      await ports.append(followups);
      toolsAllowed = true;
      continue;
    }
    // A spent budget, or a batch of which nothing ran, is answered without tools.
    if (batch.budgetExhausted || batch.executed === 0) toolsAllowed = false;
    const followups = await ports.deliverFollowups();
    if (followups.length > 0) {
      await ports.append(followups);
      toolsAllowed = true;
    }
  }
}
