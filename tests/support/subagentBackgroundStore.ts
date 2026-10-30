import {
  SUBAGENT_ERROR_CODES,
  SUBAGENT_FOLLOWUP_LIMITS,
  SUBAGENT_LIMITS,
  isActiveSubagentState,
  type EndedSubagentCallResult,
  type SubagentThreadState,
  type SubagentTurnMode
} from "@/lib/contracts/subagents";
import type { SubagentChatScope } from "@/lib/server/subagents/ports";
import {
  normalizedEndResult,
  type BackgroundOrphan,
  type CallbackIntoRunOutcome,
  type MailboxInsertOutcome,
  type OwedCallbackChat,
  type OwedCallbacks,
  type SubagentAdmission,
  type SubagentAdmissionInput,
  type SubagentBackgroundStore,
  type SubagentSettlement,
  type SubagentTurnRecord
} from "@/lib/server/runs/subagentBackground/store";
import { renderCallbackFollowup } from "@/lib/server/runs/subagentBackground/render";

/**
 * An in-memory `SubagentBackgroundStore` for the focused tests of the
 * control, callbacks and recovery. Branches are explicit: a turn is on the
 * active branch unless its parent answer is listed in `inactiveAnswers`.
 */
export type MemoryTurn = {
  callbackRunId: string | null;
  chatId: string;
  endedAt: number | null;
  mailbox: Array<{ delivered: boolean; nonce: string; text: string }>;
  mode: SubagentTurnMode;
  modelId: string;
  name: string;
  parentAnswerId: string;
  parentRunId: string;
  result: EndedSubagentCallResult | null;
  runId: string | null;
  runActive: boolean;
  state: SubagentThreadState;
  threadId: string;
  turnId: string;
  userId: string;
};

export type MemoryMainRun = {
  callbacks: Array<{ text: string; turnId: string }>;
  chatId: string;
  open: boolean;
  runId: string;
  status: "complete" | "streaming";
};

export class MemorySubagentStore implements SubagentBackgroundStore {
  readonly turns: MemoryTurn[] = [];
  readonly mainRuns: MemoryMainRun[] = [];
  readonly inactiveAnswers = new Set<string>();
  /** Parent runs that may start background turns. */
  readonly callers = new Set<string>();
  goneChats = new Set<string>();
  threads = new Map<string, string>();
  orphans: BackgroundOrphan[] = [];
  strandedInterrupts = 0;
  admitGate: (() => Promise<void>) | null = null;
  /** Holds an admission before its row exists, as a transaction blocked before its insert would be. */
  admitBeforeGate: (() => Promise<void>) | null = null;
  private sequence = 0;

  private record(turn: MemoryTurn): SubagentTurnRecord {
    return { chatId: turn.chatId, mode: turn.mode, model: { effort: null, id: turn.modelId }, name: turn.name,
      parentAnswerId: turn.parentAnswerId, parentRunId: turn.parentRunId, result: turn.result, runId: turn.runId, state: turn.state,
      threadId: turn.threadId, turnId: turn.turnId, userId: turn.userId };
  }

  /** Adds an ended background turn that owes its callback. */
  addEnded(input: Readonly<{ chatId: string; name: string; parentAnswerId?: string; result: EndedSubagentCallResult; userId: string }>): MemoryTurn {
    const turn: MemoryTurn = { callbackRunId: null, chatId: input.chatId, endedAt: ++this.sequence, mailbox: [], mode: "background",
      modelId: "fake-model", name: input.name, parentAnswerId: input.parentAnswerId ?? "answer-1", parentRunId: "parent-run",
      result: input.result, runActive: false, runId: `run-${this.sequence}`, state: input.result.state, threadId: `thread-${input.name}`,
      turnId: `turn-${this.sequence}`, userId: input.userId };
    this.turns.push(turn);
    return turn;
  }

  async callerAvailable(input: SubagentChatScope & Readonly<{ parentRunId: string }>): Promise<boolean> {
    return this.callers.has(input.parentRunId);
  }

  async admit(input: SubagentAdmissionInput): Promise<SubagentAdmission> {
    await this.admitBeforeGate?.();
    const active = this.turns.filter((turn) => turn.chatId === input.chatId && isActiveSubagentState(turn.state));
    if (active.some((turn) => turn.threadId === input.threadId)) return { code: SUBAGENT_ERROR_CODES.busy, kind: "refused" };
    if (active.length >= SUBAGENT_LIMITS.runningPerChat) return { code: SUBAGENT_ERROR_CODES.limitReached, kind: "refused" };
    const turn: MemoryTurn = { callbackRunId: null, chatId: input.chatId, endedAt: null, mailbox: [], mode: "background",
      modelId: input.binding.modelId, name: this.threads.get(input.threadId) ?? input.threadId.replace(/^thread-/u, ""), parentAnswerId: "answer-1",
      parentRunId: input.parentRunId, result: null, runActive: true, runId: input.runId, state: "running",
      threadId: input.threadId, turnId: input.turnId, userId: input.userId };
    this.turns.push(turn);
    // A test may hold the admission after it is visible, as a committed transaction would be (`admitGate`).
    await this.admitGate?.();
    return { kind: "admitted", runId: input.runId, turnId: input.turnId };
  }

  async settle(input: SubagentChatScope & Readonly<{ result: EndedSubagentCallResult; turnId: string }>): Promise<SubagentSettlement> {
    const turn = this.turns.find((candidate) => candidate.turnId === input.turnId);
    if (!turn) return { result: null, settled: false };
    if (!isActiveSubagentState(turn.state)) return { result: turn.result, settled: false };
    const ended = normalizedEndResult(input.result, { modelId: turn.modelId, name: turn.name, reasoningEffort: null });
    Object.assign(turn, { endedAt: ++this.sequence, result: ended, runActive: false, state: ended.state });
    return { result: ended, settled: true };
  }

  async findTurn(input: SubagentChatScope & Readonly<{ turnId: string }>): Promise<SubagentTurnRecord | null> {
    const turn = this.turns.find((candidate) => candidate.turnId === input.turnId && candidate.chatId === input.chatId);
    return turn ? this.record(turn) : null;
  }

  async findThreadTurnOnBranch(input: SubagentChatScope & Readonly<{ name: string; parentRunId: string }>): Promise<SubagentTurnRecord | null> {
    const turn = this.turns.filter((candidate) => candidate.chatId === input.chatId && candidate.name === input.name &&
      !this.inactiveAnswers.has(candidate.parentAnswerId)).at(-1);
    return turn ? this.record(turn) : null;
  }

  async activeTurns(input: SubagentChatScope & Readonly<{ threadId?: string; underMessageId?: string }>): Promise<readonly SubagentTurnRecord[]> {
    return this.turns.filter((turn) => turn.chatId === input.chatId && isActiveSubagentState(turn.state) &&
      (!input.threadId || turn.threadId === input.threadId) && (!input.underMessageId || turn.parentAnswerId === input.underMessageId))
      .map((turn) => this.record(turn));
  }

  async runIdsUnderMessage(input: SubagentChatScope & Readonly<{ messageId: string }>): Promise<readonly string[]> {
    return input.messageId === "answer-1" ? ["parent-run"] : [];
  }

  async insertMailbox(input: SubagentChatScope & Readonly<{ nonce: string; runId: string; text: string }>): Promise<MailboxInsertOutcome> {
    const turn = this.turns.find((candidate) => candidate.runId === input.runId);
    if (!turn?.runActive) return "closed";
    if (turn.mailbox.some((entry) => entry.nonce === input.nonce)) return "exists";
    if (turn.mailbox.length >= SUBAGENT_FOLLOWUP_LIMITS.messagesPerRun) return "full";
    turn.mailbox.push({ delivered: false, nonce: input.nonce, text: input.text });
    return "inserted";
  }

  async markMailboxDelivered(input: SubagentChatScope & Readonly<{ nonce: string; runId: string }>): Promise<void> {
    const entry = this.turns.find((turn) => turn.runId === input.runId)?.mailbox.find((candidate) => candidate.nonce === input.nonce);
    if (entry) entry.delivered = true;
  }

  async owedCallbacks(scope: SubagentChatScope): Promise<OwedCallbacks | null> {
    if (this.goneChats.has(scope.chatId)) return null;
    const owed = this.turns.filter((turn) => turn.chatId === scope.chatId && turn.mode === "background" && turn.endedAt !== null &&
      turn.callbackRunId === null).sort((left, right) => left.endedAt! - right.endedAt!);
    const main = this.mainRuns.find((run) => run.chatId === scope.chatId && run.status === "streaming");
    return {
      activeBranch: owed.filter((turn) => !this.inactiveAnswers.has(turn.parentAnswerId))
        .map((turn) => ({ name: turn.name, result: turn.result!, turnId: turn.turnId })),
      inactiveTurnIds: owed.filter((turn) => this.inactiveAnswers.has(turn.parentAnswerId)).map((turn) => turn.turnId),
      mainRun: main ? { id: main.runId, status: main.status } : null
    };
  }

  async deliverIntoRun(input: SubagentChatScope & Readonly<{ runId: string; turnId: string }>): Promise<CallbackIntoRunOutcome> {
    const run = this.mainRuns.find((candidate) => candidate.runId === input.runId);
    if (!run?.open) return "closed";
    const turn = this.turns.find((candidate) => candidate.turnId === input.turnId);
    if (!turn?.result || turn.callbackRunId !== null) return "claimed";
    turn.callbackRunId = run.runId;
    run.callbacks.push({ text: renderCallbackFollowup({ name: turn.name, result: turn.result, turnId: turn.turnId }, { tokens: 2_048 }),
      turnId: input.turnId });
    return "delivered";
  }

  /** What a wake-up admission's transaction does: claim every one or none. */
  claim(runId: string, turnIds: readonly string[]): boolean {
    const turns = turnIds.map((id) => this.turns.find((turn) => turn.turnId === id));
    if (turns.some((turn) => !turn || turn.callbackRunId !== null)) return false;
    for (const turn of turns) turn!.callbackRunId = runId;
    return true;
  }

  async mainRunScope(runId: string): Promise<SubagentChatScope | null> {
    const run = this.mainRuns.find((candidate) => candidate.runId === runId);
    return run ? { chatId: run.chatId, userId: "user-1" } : null;
  }

  async findOrphans(): Promise<readonly BackgroundOrphan[]> {
    return this.orphans;
  }

  async findOwedCallbackChats(): Promise<readonly OwedCallbackChat[]> {
    const chats = new Map<string, { chatId: string; turnIds: string[]; userId: string }>();
    for (const turn of this.turns) {
      if (turn.mode !== "background" || turn.endedAt === null || turn.callbackRunId !== null || this.goneChats.has(turn.chatId)) continue;
      if (this.mainRuns.some((run) => run.chatId === turn.chatId && run.status === "streaming")) continue;
      const chat = chats.get(turn.chatId) ?? { chatId: turn.chatId, turnIds: [], userId: turn.userId };
      chat.turnIds.push(turn.turnId);
      chats.set(turn.chatId, chat);
    }
    return [...chats.values()];
  }

  async interruptStrandedForegroundTurns(): Promise<number> {
    this.strandedInterrupts += 1;
    return 0;
  }
}
