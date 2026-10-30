/**
 * In-memory fakes of the sub-agent ports (`lib/server/subagents/ports.ts`)
 * for the parallel sub-agent tasks' tests. This is a test-support boundary:
 * production code cannot import it (`scripts/eslint/architecture-boundaries.mjs`),
 * and `20261029223932601-sub-agents-integration` proves no fake is wired.
 */
import {
  SUBAGENT_END_REASONS,
  SUBAGENT_ERROR_CODES,
  SUBAGENT_LIMITS,
  WORKSPACE_SUBAGENTS_RUNNING_CODE,
  type EndedSubagentCallResult,
  type SubagentErrorCode
} from "@/lib/contracts/subagents";
import { workspaceAgentEnvironment, type WorkspaceAgent } from "@/lib/server/subagents/guestProtocol";
import {
  WORKSPACE_OPERATIONS_BLOCKED_BY_SUBAGENTS,
  type BrowserAgentIdentity,
  type BrowserAgentReleaseInput,
  type SubagentBackgroundAvailability,
  type SubagentBackgroundControl,
  type SubagentBackgroundMessageInput,
  type SubagentBackgroundStartInput,
  type SubagentBackgroundStartResult,
  type SubagentBackgroundStopResult,
  type SubagentCallerScope,
  type SubagentCallback,
  type SubagentCallbackDisposition,
  type SubagentCallbackSink,
  type SubagentChatScope,
  type SubagentDeliveryOutcome,
  type SubagentMessage,
  type SubagentRunner,
  type SubagentStopReason,
  type SubagentTurnHandle,
  type SubagentTurnInput,
  type SubagentTypeEntry,
  type SubagentTypeLookup,
  type SubagentTypeResolution,
  type SubagentTypeResolver,
  type SubagentTypeSnapshot,
  type WorkspaceAttachment,
  type WorkspaceAttachments,
  type WorkspaceAttachResult,
  type WorkspaceDetachInput,
  type WorkspaceDetachResult,
  type WorkspaceExclusiveOperation,
  type WorkspaceExclusiveResult
} from "@/lib/server/subagents/ports";

/** A finished result for a fake turn: done, with the given report. */
export function endedSubagentResult(name: string, overrides: Partial<EndedSubagentCallResult> = {}): EndedSubagentCallResult {
  return { approvals: [], files: [], kind: "ended", model: { effort: null, id: "fake-model" }, name, outcome: "done", report: "",
    state: "done", steps: [], ...overrides } as EndedSubagentCallResult;
}

type FakeTurn = {
  ended: EndedSubagentCallResult | null;
  input: SubagentTurnInput;
  kind: "continue" | "start";
  messages: SubagentMessage[];
  waiters: Array<(result: EndedSubagentCallResult) => void>;
};

/**
 * A runner whose turns run until the test finishes them (`finish`) or they are
 * stopped. `script` answers a turn as soon as it starts, when given.
 */
export class FakeSubagentRunner implements SubagentRunner {
  readonly turns = new Map<string, FakeTurn>();

  constructor(private readonly script?: (input: SubagentTurnInput, kind: "continue" | "start") => EndedSubagentCallResult | undefined) {}

  async start(input: SubagentTurnInput): Promise<SubagentTurnHandle> {
    return this.begin(input, "start");
  }

  async continue(input: SubagentTurnInput): Promise<SubagentTurnHandle> {
    return this.begin(input, "continue");
  }

  async wait(handle: SubagentTurnHandle, signal?: AbortSignal): Promise<EndedSubagentCallResult> {
    const turn = this.turn(handle);
    if (turn.ended) return turn.ended;
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      if (signal?.aborted) return abort();
      signal?.addEventListener("abort", abort, { once: true });
      turn.waiters.push((result) => {
        signal?.removeEventListener("abort", abort);
        resolve(result);
      });
    });
  }

  async deliver(handle: SubagentTurnHandle, message: SubagentMessage): Promise<SubagentDeliveryOutcome> {
    const turn = this.turns.get(handle.turnId);
    if (!turn) return { kind: "not_found" };
    if (turn.ended) return { kind: "ended", result: turn.ended };
    if (!turn.messages.some((entry) => entry.nonce === message.nonce)) turn.messages.push(message);
    return { kind: "delivered", state: "running" };
  }

  async stop(handle: SubagentTurnHandle, reason: SubagentStopReason): Promise<EndedSubagentCallResult | null> {
    const turn = this.turns.get(handle.turnId);
    if (!turn) return null;
    if (!turn.ended) this.finish(handle.turnId, endedSubagentResult(turn.input.name, { outcome: undefined, reason, state: "stopped" }));
    return turn.ended;
  }

  /** Ends a running turn with this result, as the engine would. */
  finish(turnId: string, result: EndedSubagentCallResult): void {
    const turn = this.turn({ turnId });
    if (turn.ended) return;
    turn.ended = result;
    for (const waiter of turn.waiters.splice(0)) waiter(result);
  }

  /** Ends every running turn as interrupted, as a restart does. */
  interruptAll(): void {
    for (const [turnId, turn] of this.turns) {
      if (!turn.ended) this.finish(turnId, endedSubagentResult(turn.input.name, { outcome: undefined, reason: SUBAGENT_END_REASONS.restart,
        state: "interrupted" }));
    }
  }

  private begin(input: SubagentTurnInput, kind: "continue" | "start"): SubagentTurnHandle {
    if (this.turns.has(input.turnId)) throw new Error("fake_subagent_turn_exists");
    this.turns.set(input.turnId, { ended: null, input, kind, messages: [], waiters: [] });
    const scripted = this.script?.(input, kind);
    if (scripted) this.finish(input.turnId, scripted);
    input.signal.addEventListener("abort", () => void this.stop({ turnId: input.turnId }, "parent_stopped"), { once: true });
    return { turnId: input.turnId };
  }

  private turn(handle: SubagentTurnHandle): FakeTurn {
    const turn = this.turns.get(handle.turnId);
    if (!turn) throw new Error("fake_subagent_turn_missing");
    return turn;
  }
}

type FakeBackgroundTurn = {
  input: SubagentBackgroundStartInput;
  messages: SubagentMessage[];
  result: EndedSubagentCallResult | null;
  turnId: string;
};

/**
 * Background turns of one process: `start` admits until the chat runs
 * `SUBAGENT_LIMITS.runningPerChat` turns, refuses a thread that already runs,
 * and honours a scripted refusal (`refuse`, such as `subagent_usage_limited`)
 * or an unavailable mode (`available: false`). Turns run until `finish`.
 */
export class FakeSubagentBackgroundControl implements SubagentBackgroundControl {
  readonly turns: FakeBackgroundTurn[] = [];

  constructor(private readonly options: Readonly<{ available?: boolean; refuse?: SubagentErrorCode }> = {}) {}

  async availability(): Promise<SubagentBackgroundAvailability> {
    return this.options.available === false
      ? { available: false, code: SUBAGENT_ERROR_CODES.backgroundUnavailable } : { available: true };
  }

  async start(input: SubagentBackgroundStartInput): Promise<SubagentBackgroundStartResult> {
    if (this.options.available === false) return { code: SUBAGENT_ERROR_CODES.backgroundUnavailable, kind: "refused" };
    if (this.options.refuse) return { code: this.options.refuse, kind: "refused" };
    const active = this.turns.filter((turn) => turn.input.chatId === input.chatId && turn.result === null);
    if (active.some((turn) => turn.input.threadId === input.threadId)) return { code: SUBAGENT_ERROR_CODES.busy, kind: "refused" };
    if (active.length >= SUBAGENT_LIMITS.runningPerChat) return { code: SUBAGENT_ERROR_CODES.limitReached, kind: "refused" };
    const turnId = `background-turn-${this.turns.length + 1}`;
    this.turns.push({ input, messages: [], result: null, turnId });
    return { kind: "started", name: input.name, state: "running", turnId };
  }

  async deliver(input: SubagentBackgroundMessageInput): Promise<SubagentDeliveryOutcome> {
    const turn = this.latest(input.chatId, (candidate) => candidate.input.threadId === input.threadId);
    if (!turn) return { kind: "not_found" };
    if (turn.result) return { kind: "ended", result: turn.result };
    if (!turn.messages.some((message) => message.nonce === input.message.nonce)) turn.messages.push(input.message);
    return { kind: "delivered", state: "running" };
  }

  async stop(input: SubagentCallerScope & Readonly<{ name: string }>): Promise<SubagentBackgroundStopResult> {
    const turn = this.latest(input.chatId, (candidate) => candidate.input.name === input.name);
    if (!turn) return { kind: "not_found" };
    if (!turn.result) this.finish(turn.turnId, endedSubagentResult(input.name, { outcome: undefined, reason: SUBAGENT_END_REASONS.stoppedByAgent,
      state: "stopped" }));
    return { kind: "stopped", result: turn.result! };
  }

  /** Ends a running background turn with this result, as its run would. */
  finish(turnId: string, result: EndedSubagentCallResult): void {
    const turn = this.turns.find((candidate) => candidate.turnId === turnId);
    if (!turn) throw new Error("fake_background_turn_missing");
    turn.result ??= result;
  }

  private latest(chatId: string, matches: (turn: FakeBackgroundTurn) => boolean): FakeBackgroundTurn | undefined {
    return this.turns.filter((turn) => turn.input.chatId === chatId && matches(turn)).at(-1);
  }
}

/** A callback sink that records every callback and answers with a fixed or scripted disposition. */
export class FakeSubagentCallbackSink implements SubagentCallbackSink {
  readonly callbacks: SubagentCallback[] = [];

  constructor(private readonly disposition: SubagentCallbackDisposition | ((callback: SubagentCallback) => SubagentCallbackDisposition) = "delivered") {}

  async deliver(callback: SubagentCallback): Promise<SubagentCallbackDisposition> {
    this.callbacks.push(callback);
    return typeof this.disposition === "function" ? this.disposition(callback) : this.disposition;
  }
}

/**
 * One shared Workspace per chat with attached runs, exclusive operations one
 * at a time, and Reset and continuation seeds refused while a sub-agent run
 * is attached. `unknownExecutionStopsVm` makes an unknown detach stop the VM
 * and interrupt the other runs, the fallback when a process-group stop cannot
 * be proven.
 */
export class FakeWorkspaceAttachments implements WorkspaceAttachments {
  readonly sessions = new Map<string, WorkspaceAttachment[]>();
  readonly operations: Array<Readonly<{ chatId: string; operation: WorkspaceExclusiveOperation }>> = [];
  /** Chats whose session `fence` marked failed: they refuse every attach, as a failed session does. */
  readonly fenced = new Set<string>();
  private readonly busy = new Set<string>();

  constructor(private readonly options: Readonly<{ refuseAttach?: string; unknownExecutionStopsVm?: boolean }> = {}) {}

  async attach(attachment: WorkspaceAttachment): Promise<WorkspaceAttachResult> {
    if (this.options.refuseAttach) return { code: this.options.refuseAttach, kind: "refused" };
    if (this.fenced.has(attachment.chatId)) return { code: "workspace_busy", kind: "refused" };
    const runs = this.sessions.get(attachment.chatId) ?? [];
    if (!runs.some((run) => run.modelRunId === attachment.modelRunId)) runs.push(attachment);
    this.sessions.set(attachment.chatId, runs);
    return { attachedRuns: runs.length, kind: "attached", sessionId: `session-${attachment.chatId}` };
  }

  async detach(input: WorkspaceDetachInput): Promise<WorkspaceDetachResult> {
    const runs = (this.sessions.get(input.chatId) ?? []).filter((run) => run.modelRunId !== input.modelRunId);
    if (input.execution === "unknown" && this.options.unknownExecutionStopsVm) {
      this.sessions.set(input.chatId, []);
      return { interruptedRunIds: runs.map((run) => run.modelRunId), kind: "detached", remainingRuns: 0 };
    }
    this.sessions.set(input.chatId, runs);
    return { interruptedRunIds: [], kind: "detached", remainingRuns: runs.length };
  }

  async exclusive<T>(scope: SubagentChatScope & Readonly<{ operation: WorkspaceExclusiveOperation }>,
    work: (lease: Readonly<{ sessionId: string }>) => Promise<T>): Promise<WorkspaceExclusiveResult<T>> {
    const subagentAttached = (this.sessions.get(scope.chatId) ?? []).some((run) => run.agent.kind === "subagent");
    if (subagentAttached && WORKSPACE_OPERATIONS_BLOCKED_BY_SUBAGENTS.includes(scope.operation)) {
      return { code: WORKSPACE_SUBAGENTS_RUNNING_CODE, kind: "refused" };
    }
    if (this.busy.has(scope.chatId)) return { code: "workspace_operation_busy", kind: "refused" };
    this.busy.add(scope.chatId);
    this.operations.push({ chatId: scope.chatId, operation: scope.operation });
    try {
      return { kind: "done", value: await work({ sessionId: `session-${scope.chatId}` }) };
    } finally {
      this.busy.delete(scope.chatId);
    }
  }

  async attached(scope: SubagentChatScope): Promise<readonly WorkspaceAttachment[]> {
    return [...this.sessions.get(scope.chatId) ?? []];
  }

  async fence(input: SubagentChatScope & Readonly<{ modelRunId: string }>): Promise<void> {
    this.fenced.add(input.chatId);
  }
}

/** The real environment builder, with releases recorded instead of sent to a guest. */
export class FakeBrowserAgentIdentity implements BrowserAgentIdentity {
  readonly releases: BrowserAgentReleaseInput[] = [];

  environment(agent: WorkspaceAgent): Readonly<Record<string, string>> {
    return workspaceAgentEnvironment(agent);
  }

  async release(input: BrowserAgentReleaseInput): Promise<void> {
    this.releases.push(input);
  }
}

/** Custom sub-agents of each user, by name. */
export class FakeSubagentTypeResolver implements SubagentTypeResolver {
  constructor(private readonly types: Readonly<Record<string, readonly SubagentTypeSnapshot[]>> = {}) {}

  async catalog(input: Readonly<{ userId: string }>): Promise<readonly SubagentTypeEntry[]> {
    return (this.types[input.userId] ?? []).map((type) => ({ description: type.description, name: type.name }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async resolve(input: SubagentTypeLookup): Promise<SubagentTypeResolution> {
    const type = (this.types[input.userId] ?? []).find((candidate) =>
      "definitionId" in input ? candidate.definitionId === input.definitionId : candidate.name === input.name);
    return type ? { kind: "found", type } : { kind: "unavailable" };
  }
}
