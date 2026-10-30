import type {
  ActiveSubagentState,
  EndedSubagentCallResult,
  SUBAGENT_ERROR_CODES,
  SubagentBindingSource,
  SubagentErrorCode,
  SubagentToolGroup,
  SubagentTurnMode
} from "../../contracts/subagents";
import type { WorkspaceAgent } from "./guestProtocol";

/**
 * The seams between the parallel sub-agent tasks. Each port names the task
 * that implements it; the others build against the in-memory fakes in
 * `tests/support/subagentPorts.ts` (a test-support boundary production code
 * cannot import), and `20261029223932601-sub-agents-integration` wires the
 * real ones. Persistence is `prisma/schema.prisma` (`SubagentThread`,
 * `SubagentTurn`, `SubagentDefinition`); the wire is `lib/contracts/subagents.ts`
 * and `lib/contracts/subagentViews.ts`.
 *
 * Deletion: an active background sub-agent run blocks deleting its branch or
 * message like any active run. The deleting path stops it first (abort, then
 * settle its turn) and deletes after; the cascades from the anchor run are an
 * integrity guarantee, never the way a running sub-agent is stopped. Chat and
 * account deletion stop every run of the chat the same way under the
 * existing deletion lock.
 */

/** One chat of one owner: every port call names both, and an implementation rechecks them. */
export type SubagentChatScope = Readonly<{ chatId: string; userId: string }>;

/**
 * The model binding a turn runs with, resolved at its admission from the
 * parent run's frozen catalog (precedence: the call, the type, the parent) and
 * snapshotted on `SubagentTurn`. Never current settings or browser claims.
 */
export type SubagentBinding = Readonly<{
  effortSource: SubagentBindingSource;
  modelId: string;
  modelSource: SubagentBindingSource;
  provider: string;
  providerModelId: string | null;
  /** Null for the model's default effort. */
  reasoningEffort: string | null;
}>;

/** A custom sub-agent as a turn runs it: one immutable revision (`SubagentDefinitionRevision`). */
export type SubagentTypeSnapshot = Readonly<{
  definitionId: string;
  description: string;
  instructions: string;
  name: string;
  /** Null runs on the parent's model. */
  providerModelId: string | null;
  reasoningEffort: string | null;
  revisionId: string;
  /** Null: every tool the built-in sub-agent has. */
  toolGroups: readonly SubagentToolGroup[] | null;
}>;

/** One turn to run: what `call_subagent` admitted (its `SubagentTurn` row exists before the turn starts). */
export type SubagentTurnInput = SubagentChatScope & Readonly<{
  binding: SubagentBinding;
  /** The main agent's brief, or its next instruction for a thread it continues. */
  brief: string;
  /** When the turn must end: the parent's tool time for a foreground turn, its own for a background one. */
  deadlineAt: Date;
  /**
   * The run whose rows hold the turn's transcript items and tool calls: the
   * parent run for a foreground turn, the turn's own run for a background one.
   * A background run carries a copy of its parent's `normalizedRequest` (the
   * Workspace grant, coordinator and request decoders read it by run id),
   * while its provider, MCP and Skill binding rows stay by reference: the
   * runner reads them from `parentRunId` (an MCP write reaches the guard
   * through the parent's `McpRunBinding` rows), never from `hostRunId`
   * (integrator decision 2026-10-30).
   */
  hostRunId: string;
  mode: SubagentTurnMode;
  name: string;
  parentRunId: string;
  parentToolCallId: string;
  signal: AbortSignal;
  threadId: string;
  turnId: string;
  /** Null for the built-in sub-agent. */
  type: SubagentTypeSnapshot | null;
  /**
   * The user's current message, verbatim: the only authority for irreversible
   * website actions and payments, never the brief alone.
   */
  userMessage: string;
}>;

export type SubagentTurnHandle = Readonly<{ turnId: string }>;

/** A message for a running turn: from the main agent (its mailbox) or a user follow-up the parent received while it waited. */
export type SubagentMessage = Readonly<{
  /** Idempotency key: the sending tool call's id, or the follow-up's. */
  nonce: string;
  origin: "main_agent" | "user";
  text: string;
}>;

export type SubagentDeliveryOutcome =
  /** Accepted for its next round; receipt, not obedience. */
  | Readonly<{ kind: "delivered"; state: ActiveSubagentState }>
  /** It ended first: the caller gets its result instead. */
  | Readonly<{ kind: "ended"; result: EndedSubagentCallResult }>
  | Readonly<{ kind: "not_found" }>;

/** Why a turn is stopped (`SUBAGENT_END_REASONS`). */
export type SubagentStopReason = "chat_deleted" | "deadline" | "parent_stopped" | "stop_all" | "stop_subagent" | "user_stop";

/**
 * Runs sub-agent turns on the native engine's loop (`runAgentLoop`, never a
 * second engine), with the filtered registry, the thread's own context from
 * the branch, its own compaction and gateway lane.
 * Owner: `20261029205100915-subagents-engine` (foreground turns); the
 * background-runs task calls it inside a background turn's own run.
 */
export interface SubagentRunner {
  /** Starts the first turn of a new thread: its context is the brief and the user's message. */
  start(input: SubagentTurnInput): Promise<SubagentTurnHandle>;
  /** Starts a later turn of a thread: its context is its own items on the branch, then the brief. */
  continue(input: SubagentTurnInput): Promise<SubagentTurnHandle>;
  /**
   * Resolves when the turn ends, with the result `call_subagent` returns and
   * `SubagentTurn.result` keeps. A signal abort stops waiting, not the turn.
   */
  wait(handle: SubagentTurnHandle, signal?: AbortSignal): Promise<EndedSubagentCallResult>;
  /** Delivers a message the turn reads at its next round. */
  deliver(handle: SubagentTurnHandle, message: SubagentMessage): Promise<SubagentDeliveryOutcome>;
  /** Stops the turn; its thread keeps what it recorded. Idempotent: an ended turn returns how it ended. */
  stop(handle: SubagentTurnHandle, reason: SubagentStopReason): Promise<EndedSubagentCallResult | null>;
}

/** The main-agent run whose call reaches a sub-agent, and that call (`ModelRunToolCall`). */
export type SubagentCallerScope = SubagentChatScope & Readonly<{
  parentRunId: string;
  parentToolCallId: string;
}>;

export type SubagentBackgroundAvailability =
  | Readonly<{ available: true }>
  /** Telegram turns, scheduled-task occurrences, or no background port in this run. */
  | Readonly<{ available: false; code: typeof SUBAGENT_ERROR_CODES.backgroundUnavailable }>;

/** A background turn to admit: everything a foreground turn takes except what its own run is given at admission. */
export type SubagentBackgroundStartInput = SubagentCallerScope & Readonly<{
  binding: SubagentBinding;
  brief: string;
  /** `start` for the first turn of a thread, `continue` for a later one (`SubagentRunner`). */
  kind: "continue" | "start";
  name: string;
  threadId: string;
  type: SubagentTypeSnapshot | null;
  userMessage: string;
}>;

export type SubagentBackgroundStartResult =
  /** Admitted: the turn's row and its run exist and it runs; its result comes back as a callback. */
  | Readonly<{ kind: "started"; name: string; state: ActiveSubagentState; turnId: string }>
  /**
   * Nothing ran. `subagent_usage_limited` (usage limits refused the run),
   * `subagent_limit_reached` (20 running in the chat), `subagent_busy` (the
   * thread got an active run meanwhile), `subagent_background_unavailable`.
   */
  | Readonly<{ code: SubagentErrorCode; kind: "refused" }>;

export type SubagentBackgroundMessageInput = SubagentCallerScope & Readonly<{
  /** The main agent's message; its nonce is the sending call's id. */
  message: SubagentMessage & Readonly<{ origin: "main_agent" }>;
  name: string;
  threadId: string;
}>;

export type SubagentBackgroundStopResult =
  | Readonly<{ kind: "stopped"; result: EndedSubagentCallResult }>
  /** No thread of that name on the caller's branch (`subagent_not_found`). */
  | Readonly<{ kind: "not_found" }>;

/**
 * What the engine's `call_subagent` and `stop_subagent` handlers use for
 * background turns: admitting one as its own run with the parent run's
 * frozen bindings (never current settings), delivering a main-agent message
 * to a running one's mailbox (a `main_agent` follow-up on its run), and
 * stopping one by name. Absent from a run, background mode is unavailable.
 *
 * How `call_subagent` decides on a name. The handler resolves the name to the
 * visible thread of the caller's branch (`SubagentThread`, anchor run's answer
 * on the branch), or starts a new thread when there is none; then:
 * - The thread has no active turn anywhere: it continues. Without
 *   `background` the engine runs a foreground turn (`SubagentRunner.continue`)
 *   and waits; with `background: true` it calls `start` here with `kind:
 *   "continue"`, after `availability` said yes (otherwise the call is refused
 *   with `subagent_background_unavailable`, and the same call without
 *   `background` still works).
 * - Its active turn is on the caller's branch and runs in the background: the
 *   message goes to its mailbox (`deliver`), whatever `background` says, and
 *   the call returns `delivered` (receipt, not obedience). A `type`, `model`
 *   or `effort` on such a call is refused with `subagent_busy`: the running
 *   turn keeps its binding, and nothing is silently ignored.
 * - Its active turn is a foreground turn of this answer, or runs on another
 *   branch (a thread has one active run at a time): `subagent_busy`.
 * The 20-running cap counts the chat's active turns: the handler checks it
 * for a foreground turn, and `start` checks it atomically with admission.
 * Owner: `20261029221046686-sub-agent-background-runs`; consumer: the engine's
 * handlers (`20261029205100915-subagents-engine`).
 */
export interface SubagentBackgroundControl {
  /** Whether this run may start background turns (web and Assistant chats; never Telegram or scheduled runs). */
  availability(scope: SubagentCallerScope): Promise<SubagentBackgroundAvailability>;
  /** Admits a background turn and returns at once; refused admissions leave no turn and no run. */
  start(input: SubagentBackgroundStartInput): Promise<SubagentBackgroundStartResult>;
  /** Delivers a main-agent message to the thread's running background turn on the caller's branch. Idempotent by nonce. */
  deliver(input: SubagentBackgroundMessageInput): Promise<SubagentDeliveryOutcome>;
  /**
   * Stops the thread of that name on the caller's branch (`stop_subagent`) and
   * returns its last state; one that already ended returns how it ended.
   */
  stop(input: SubagentCallerScope & Readonly<{ name: string }>): Promise<SubagentBackgroundStopResult>;
}

/** A background turn that ended, for the main agent of the branch it was started on. */
export type SubagentCallback = SubagentChatScope & Readonly<{
  name: string;
  parentRunId: string;
  result: EndedSubagentCallResult;
  threadId: string;
  turnId: string;
}>;

export type SubagentCallbackDisposition =
  /** Into the running main-agent answer, as a `subagent_callback` follow-up. */
  | "delivered"
  /** A wake-up turn (`subagent_callback`) was admitted, coalescing callbacks close together. */
  | "wake_up"
  /**
   * The branch's main-agent answer is running but already closed to follow-ups
   * (it lost the close-to-publish race, or it is published and still ends
   * its Workspace hand-off). A wake-up is tried first and admitted only where
   * the user's own next message would be: behind a published answer still
   * handing off its Workspace, or once that answer ended (`wake_up`). When the
   * send refuses it, the callback stays owed, and that run's terminal flush
   * delivers it (a wake-up turn) when it ends.
   */
  | "after_run"
  /** Usage limits refused the wake-up; it stays owed and goes with the next main-agent turn. */
  | "pending"
  /** Its branch is not the active one: recorded there, owed, and it wakes nothing. */
  | "inactive_branch";

/**
 * Takes the callbacks of background turns that ended (done, partial, blocked,
 * needs_approval, failed, stopped, interrupted). A callback stays owed until
 * `SubagentTurn.callbackRunId` names the run that received it
 * (`subagentCallbackOwed`). Rules every implementation keeps:
 * - The claim: a callback is delivered only by
 *   `UPDATE "SubagentTurn" SET "callbackRunId" = $run WHERE "id" = $turn AND "callbackRunId" IS NULL`
 *   in the same transaction as the `subagent_callback` follow-up insert
 *   (nonce `subagentCallbackNonce(turnId)`) or the wake-up turn's admission.
 *   The turn's end and a main run's terminal flush may both try; the one whose
 *   update finds the row unclaimed delivers, the other does nothing, so no
 *   callback is delivered twice.
 * - The flush: every main-agent run's terminal path except a user's Stop
 *   flushes the owed callbacks of its active branch (a wake-up turn), so one
 *   that lost the close-to-publish race (`after_run`) is never left waiting
 *   for a user turn. A user's Stop wakes nothing (integrator decision
 *   2026-10-30): callbacks left unread in the stopped run are owed again and
 *   go with the next main-agent turn or the next wake-up another sub-agent's
 *   end triggers; recovery flushes callbacks left owed by a restart or a
 *   failed flush.
 * - The budget: `subagent_callback` and `main_agent` follow-ups never count
 *   toward the user's follow-ups (`RUN_FOLLOWUP_MAX_COUNT`) or the run's
 *   `followupBudgetTokens`; they have their own bounds
 *   (`SUBAGENT_FOLLOWUP_LIMITS`). A callback is cut to what is left of the
 *   receiving run's follow-up reserve (`followupContextReserveTokens`) with a
 *   cut mark, never refused; a wake-up turn shares a fixed room among its
 *   callbacks the same way. The whole result stays on the turn and in the
 *   thread view.
 * Owner: `20261029221046686-sub-agent-background-runs`.
 */
export interface SubagentCallbackSink {
  deliver(callback: SubagentCallback): Promise<SubagentCallbackDisposition>;
}

/** Operations of a shared Workspace session that stay exclusive while several runs are attached. */
export const WORKSPACE_EXCLUSIVE_OPERATIONS = [
  "vm_create", "vm_start", "vm_stop", "export_capture", "reset", "continuation_seed", "restore", "disk_loss"
] as const;
export type WorkspaceExclusiveOperation = (typeof WORKSPACE_EXCLUSIVE_OPERATIONS)[number];
/** Refused while sub-agent runs are attached ("stop the sub-agents first", `WORKSPACE_SUBAGENTS_RUNNING_CODE`). */
export const WORKSPACE_OPERATIONS_BLOCKED_BY_SUBAGENTS: readonly WorkspaceExclusiveOperation[] = Object.freeze(["reset", "continuation_seed"]);

export type WorkspaceAttachment = SubagentChatScope & Readonly<{
  agent: WorkspaceAgent;
  modelRunId: string;
}>;

export type WorkspaceAttachResult =
  | Readonly<{ attachedRuns: number; kind: "attached"; sessionId: string }>
  /** No Workspace in this run, or it cannot attach now; the stable code says which. */
  | Readonly<{ code: string; kind: "refused" }>;

export type WorkspaceDetachInput = SubagentChatScope & Readonly<{
  /** `unknown`: the run's execution state is not known, so its processes must be proven stopped or the VM stops. */
  execution: "settled" | "unknown";
  modelRunId: string;
}>;

export type WorkspaceDetachResult = Readonly<{
  /** Other runs ended as interrupted because an unknown execution forced the VM to stop. */
  interruptedRunIds: readonly string[];
  kind: "detached";
  /** Runs still attached; the idle timer starts when this reaches zero. */
  remainingRuns: number;
}>;

export type WorkspaceExclusiveResult<T> =
  | Readonly<{ kind: "done"; value: T }>
  | Readonly<{ code: string; kind: "refused" }>;

/**
 * One Workspace per chat serves every attached run of its main agent and
 * sub-agents at once; exec calls of attached runs run concurrently, and
 * lifecycle operations take a short exclusive lease. A background sub-agent
 * run never takes the chat's Workspace wait slot (`workspaceWaitPending`,
 * `ModelRun_one_workspace_wait_per_chat_idx`, which a waiting main-agent
 * message holds): it attaches here instead.
 * Owner: `20261029221042976-shared-workspace-sessions` (which also designs and
 * migrates the attachment table).
 */
export interface WorkspaceAttachments {
  attach(attachment: WorkspaceAttachment, signal?: AbortSignal): Promise<WorkspaceAttachResult>;
  /** Retires only this run's guest authority (its processes and exec capabilities). Idempotent. */
  detach(input: WorkspaceDetachInput): Promise<WorkspaceDetachResult>;
  /** Runs `work` under the session's exclusive lease for this operation, or refuses it. */
  exclusive<T>(scope: SubagentChatScope & Readonly<{ operation: WorkspaceExclusiveOperation; signal?: AbortSignal }>,
    work: (lease: Readonly<{ sessionId: string }>) => Promise<T>): Promise<WorkspaceExclusiveResult<T>>;
  attached(scope: SubagentChatScope): Promise<readonly WorkspaceAttachment[]>;
  /**
   * A run whose guest authority could not be retired was settled anyway (recovery's bound): the run's session is
   * marked failed, so no run joins or claims it, and the next send answers that the Workspace stopped working, until
   * maintenance's backstop proves the VM stopped or the user resets it. Idempotent.
   */
  fence(input: SubagentChatScope & Readonly<{ modelRunId: string }>): Promise<void>;
}

export type BrowserAgentReleaseInput = SubagentChatScope & Readonly<{
  agent: WorkspaceAgent;
  modelRunId: string;
  signal?: AbortSignal;
}>;

/**
 * Who a Workspace command runs for: every exec call of an agent carries
 * `workspaceAgentEnvironment(agent)` (`guestProtocol.ts`), set by the server
 * over the command's own environment, and the server releases the agent's
 * browser slot when its tool call or run ends. A coordination key, not a
 * security boundary.
 * Owner: `20261029221039219-browser-agent-lease`.
 */
export interface BrowserAgentIdentity {
  /** The environment values of this agent's exec calls. */
  environment(agent: WorkspaceAgent): Readonly<Record<string, string>>;
  /** Releases the agent's browser slot (`aiqsa-browser release`); idempotent, and a no-op without a slot or a running VM. */
  release(input: BrowserAgentReleaseInput): Promise<void>;
}

export type SubagentTypeEntry = Readonly<{ description: string; name: string }>;

export type SubagentTypeResolution =
  | Readonly<{ kind: "found"; type: SubagentTypeSnapshot }>
  /** Unknown, deleted or another user's (`subagent_type_unavailable`). */
  | Readonly<{ kind: "unavailable" }>;

/**
 * The user's custom sub-agents for the main agent's context and for
 * admission. Model availability is checked by the caller against the run's
 * frozen catalog, so an unavailable type model is refused there, never
 * substituted.
 * Owner: `20261029205104652-subagent-profiles`.
 */
export interface SubagentTypeResolver {
  /** Name and description of each of the user's custom sub-agents, in a stable order. */
  catalog(input: Readonly<{ userId: string }>): Promise<readonly SubagentTypeEntry[]>;
  /**
   * The current revision of one of the user's custom sub-agents: by `name` for
   * a call that starts a thread with `type`, by `definitionId`
   * (`SubagentThread.definitionId`) to continue a thread, so renaming the
   * definition never strands a live thread. A deleted definition, a thread
   * whose `definitionId` was cleared, or another user's definition is
   * `unavailable` either way.
   */
  resolve(input: SubagentTypeLookup): Promise<SubagentTypeResolution>;
}

export type SubagentTypeLookup = Readonly<{ userId: string }> & (Readonly<{ name: string }> | Readonly<{ definitionId: string }>);
