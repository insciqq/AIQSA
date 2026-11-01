import {
  SUBAGENT_ERROR_CODES,
  SUBAGENT_FOLLOWUP_LIMITS,
  SUBAGENT_LIMITS,
  isActiveSubagentState,
  type EndedSubagentCallResult,
  type SubagentThreadState,
  type SubagentTurnMode
} from "@/lib/contracts/subagents";
import type { SubagentCallbackClaim, SubagentChatScope } from "@/lib/server/subagents/ports";
import {
  normalizedEndResult,
  type BackgroundOrphan,
  type CallbackIntoRunOutcome,
  type MailboxInsertInput,
  type MailboxInsertOutcome,
  type MainAgentMessageOutcome,
  type OwedCallbackChat,
  type OwedCallbacks,
  type SubagentAdmission,
  type SubagentAdmissionInput,
  type SubagentBackgroundStore,
  type SubagentSettlement,
  type SubagentTurnRecord
} from "@/lib/server/runs/subagentBackground/store";
import { renderCallbackFollowup, renderQuestionFollowup } from "@/lib/server/runs/subagentBackground/render";

/**
 * An in-memory `SubagentBackgroundStore` for the focused tests of the
 * control, callbacks and recovery. Branches are explicit: a turn is on the
 * active branch unless its parent answer is listed in `inactiveAnswers`.
 */
export type MemoryTurn = {
  callbackRunId: string | null;
  chatId: string;
  endedAt: number | null;
  mailbox: Array<{ delivered: boolean; from?: string; nonce: string; origin?: "subagent_message" | "user"; text: string }>;
  mode: SubagentTurnMode;
  modelId: string;
  name: string;
  parentAnswerId: string;
  parentRunId: string;
  /** While it waits for an answer: what its `ask_parent` call asks. */
  question?: string;
  /** That call's id, when a test tells two questions of a turn apart. */
  questionCallId?: string;
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
    const turn = this.turns.find((candidate) => candidate.turnId === input.turnId && candidate.chatId === input.chatId && candidate.userId === input.userId);
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

  async insertMailbox(input: MailboxInsertInput): Promise<MailboxInsertOutcome> {
    const turn = this.turns.find((candidate) => candidate.turnId === input.turnId);
    if (!turn?.runActive && turn?.mode !== "foreground") return "closed";
    if (turn.mailbox.some((entry) => entry.nonce === input.nonce)) return "exists";
    const sent = turn.mailbox.filter((entry) => (entry.origin ?? "main_agent") === input.origin).length;
    if (sent >= (input.origin !== "subagent_message" ? SUBAGENT_FOLLOWUP_LIMITS.messagesPerRun : SUBAGENT_FOLLOWUP_LIMITS.agentMessagesPerTurn)) return "full";
    turn.mailbox.push({ delivered: false, nonce: input.nonce, ...(input.origin === "main_agent" ? {} : { from: input.authorName, origin: input.origin }),
      text: input.text });
    return "inserted";
  }

  /** What a sub-agent wrote the main agent's running answer. */
  readonly mainMessages: Array<{ from: string; nonce: string; text: string }> = [];

  async messageMainAgent(input: SubagentChatScope & Readonly<{ authorName: string; nonce: string; parentRunId: string; text: string }>): Promise<MainAgentMessageOutcome> {
    const run = this.mainRuns.find((candidate) => candidate.chatId === input.chatId && candidate.status === "streaming");
    if (!run?.open) return "closed";
    if (this.mainMessages.length >= SUBAGENT_FOLLOWUP_LIMITS.callbacksPerRun) return "full";
    this.mainMessages.push({ from: input.authorName, nonce: input.nonce, text: input.text });
    return "delivered";
  }

  /** Stranded messages of a chat that the next answer takes, by id, and those taken. */
  readonly strandedMessages: Array<{ chatId: string; id: string }> = [];
  readonly movedMessages: Array<{ followupId: string; runId: string }> = [];

  async moveMessageIntoRun(input: SubagentChatScope & Readonly<{ followupId: string; runId: string }>): Promise<boolean> {
    const run = this.mainRuns.find((candidate) => candidate.runId === input.runId);
    if (!run?.open) return false;
    this.movedMessages.push({ followupId: input.followupId, runId: input.runId });
    return true;
  }

  async owedCallbacks(scope: SubagentChatScope): Promise<OwedCallbacks | null> {
    if (this.goneChats.has(scope.chatId)) return null;
    const owed = this.turns.filter((turn) => turn.chatId === scope.chatId && turn.mode === "background" && turn.endedAt !== null &&
      turn.callbackRunId === null).sort((left, right) => left.endedAt! - right.endedAt!);
    const asking = this.turns.filter((turn) => turn.chatId === scope.chatId && turn.mode === "background" && turn.state === "waiting" &&
      turn.callbackRunId === null && turn.question !== undefined);
    const main = this.mainRuns.find((run) => run.chatId === scope.chatId && run.status === "streaming");
    const moved = new Set(this.movedMessages.map((message) => message.followupId));
    return {
      activeBranch: [...owed.filter((turn) => !this.inactiveAnswers.has(turn.parentAnswerId))
        .map((turn) => ({ name: turn.name, result: turn.result!, turnId: turn.turnId })),
      ...asking.filter((turn) => !this.inactiveAnswers.has(turn.parentAnswerId))
        .map((turn) => ({ callId: turn.questionCallId ?? `ask-${turn.turnId}`, name: turn.name, question: turn.question!, turnId: turn.turnId }))],
      inactiveTurnIds: [...owed, ...asking].filter((turn) => this.inactiveAnswers.has(turn.parentAnswerId)).map((turn) => turn.turnId),
      mainRun: main ? { id: main.runId, status: main.status } : null,
      strandedMessageIds: this.strandedMessages.filter((message) => message.chatId === scope.chatId && !moved.has(message.id)).map((message) => message.id)
    };
  }

  async deliverIntoRun(input: SubagentChatScope & Readonly<{ runId: string; turnId: string }>): Promise<CallbackIntoRunOutcome> {
    const run = this.mainRuns.find((candidate) => candidate.runId === input.runId);
    if (!run?.open) return "closed";
    const turn = this.turns.find((candidate) => candidate.turnId === input.turnId);
    if (turn?.state === "waiting" && turn.question !== undefined && turn.callbackRunId === null) {
      turn.callbackRunId = run.runId;
      run.callbacks.push({ text: renderQuestionFollowup({ name: turn.name, question: turn.question }), turnId: input.turnId });
      return "delivered";
    }
    if (!turn?.result || turn.callbackRunId !== null) return "claimed";
    turn.callbackRunId = run.runId;
    run.callbacks.push({ text: renderCallbackFollowup({ name: turn.name, result: turn.result, turnId: turn.turnId }, { tokens: 2_048 }),
      turnId: input.turnId });
    return "delivered";
  }

  /** What a wake-up admission's transaction does: claim every one or none, each only for what the wake-up rendered. */
  claim(runId: string, claims: readonly SubagentCallbackClaim[]): boolean {
    const turns = claims.map((claim) => {
      const turn = this.turns.find((candidate) => candidate.turnId === claim.turnId);
      if (!turn || turn.callbackRunId !== null) return null;
      if (claim.kind === "callback") return turn.endedAt !== null ? turn : null;
      return turn.endedAt === null && turn.state === "waiting" && (turn.questionCallId ?? `ask-${turn.turnId}`) === claim.callId ? turn : null;
    });
    if (turns.includes(null)) return false;
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
