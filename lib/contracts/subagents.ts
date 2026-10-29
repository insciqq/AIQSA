import { RUN_FOLLOWUP_MAX_CHARS } from "./runFollowups";

/**
 * Sub-agents (operator decisions 2026-10-29; Claude Code's Agent, SendMessage
 * and TaskStop are the reference): the main agent of a chat starts named
 * sub-agents with `call_subagent`, waits for them or lets them run in the
 * background, messages and stops them, and they keep their own context
 * between its turns.
 *
 * Model of record (`prisma/schema.prisma`):
 * - A thread (`SubagentThread`) is a named sub-agent of a chat. It belongs to
 *   the branch of its anchor, the main-agent run whose call started it: it is
 *   visible where that run's answer is on the branch, and a name resolves to
 *   the visible thread of that name.
 * - A turn (`SubagentTurn`) is what one `call_subagent` call started or
 *   continued: `foreground` inside the parent run, which waits, or
 *   `background` as a run of its own. A turn is on a branch when its parent
 *   run's answer is, so a thread's state on a branch is its latest turn there
 *   (`projectSubagentThreadState`) and editing an earlier message branches
 *   threads like the conversation.
 * - Transcript items and tool calls of a thread are rows of the run that
 *   executed them, keyed by the thread; the main agent's have no thread key
 *   and never include a thread's.
 *
 * Everything here is content-free apart from what the owner's own chat holds
 * (names, briefs, reports), and only owner-only routes carry it.
 */

export const SUBAGENT_LIMITS = Object.freeze({
  /** Sub-agents running at once per chat, every branch counted (operator: a symbolic cap). */
  runningPerChat: 20,
  nameCharacters: 48,
  /** A brief, or a message to a running sub-agent, which rides on the follow-up store. */
  messageCharacters: RUN_FOLLOWUP_MAX_CHARS,
  modelCharacters: 256,
  effortCharacters: 32,
  /** A stable code (blocked reason, failure, stop reason). */
  codeCharacters: 64,
  reportCharacters: 12_000,
  files: 50,
  filePathCharacters: 512,
  steps: 100,
  stepToolCharacters: 160,
  stepSummaryCharacters: 240,
  approvals: 10,
  approvalToolCharacters: 160,
  /** Serialized arguments of one MCP call handed back for approval. */
  approvalArgumentsCharacters: 16_384
});

/** A sub-agent name: a lowercase slug the main agent chooses, unique among the threads visible on a branch. */
export const SUBAGENT_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,46}[a-z0-9])?$/u;
/** The browser agent id of the main agent (`MAIN_AGENT_ID`) can never name a sub-agent. */
export const SUBAGENT_RESERVED_NAMES: readonly string[] = Object.freeze(["main"]);

/** A name as given, trimmed and lowercased, or null when it is not a valid sub-agent name. */
export function normalizeSubagentName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().toLowerCase();
  return SUBAGENT_NAME_PATTERN.test(name) && !SUBAGENT_RESERVED_NAMES.includes(name) ? name : null;
}

/** The states of a turn and so of a thread on a branch (`SubagentTurnState`). */
export const SUBAGENT_THREAD_STATES = ["running", "waiting", "done", "stopped", "failed", "interrupted"] as const;
export type SubagentThreadState = (typeof SUBAGENT_THREAD_STATES)[number];
/** `waiting`: still active, but waiting for the user (a browser handoff it asked for). */
export const ACTIVE_SUBAGENT_STATES = ["running", "waiting"] as const satisfies readonly SubagentThreadState[];
export type ActiveSubagentState = (typeof ACTIVE_SUBAGENT_STATES)[number];
export type EndedSubagentState = Exclude<SubagentThreadState, ActiveSubagentState>;

export function isSubagentThreadState(value: unknown): value is SubagentThreadState {
  return (SUBAGENT_THREAD_STATES as readonly unknown[]).includes(value);
}

/** Active turns count toward the running cap and can be messaged and stopped; ended ones never run again. */
export function isActiveSubagentState(value: unknown): value is ActiveSubagentState {
  return (ACTIVE_SUBAGENT_STATES as readonly unknown[]).includes(value);
}

/** How a `done` turn ended (`SubagentOutcome`). */
export const SUBAGENT_OUTCOMES = ["done", "partial", "blocked"] as const;
export type SubagentOutcome = (typeof SUBAGENT_OUTCOMES)[number];

export function isSubagentOutcome(value: unknown): value is SubagentOutcome {
  return (SUBAGENT_OUTCOMES as readonly unknown[]).includes(value);
}

/** `foreground`: the parent run waits inside its own run; `background`: the turn is a run of its own (`SubagentTurnMode`). */
export const SUBAGENT_TURN_MODES = ["foreground", "background"] as const;
export type SubagentTurnMode = (typeof SUBAGENT_TURN_MODES)[number];

export function isSubagentTurnMode(value: unknown): value is SubagentTurnMode {
  return (SUBAGENT_TURN_MODES as readonly unknown[]).includes(value);
}

/**
 * Where a turn's model or effort came from (`SubagentBindingSource`).
 * Precedence: the call's `model` and `effort`, then the custom sub-agent's,
 * then the parent run's binding. A continued thread keeps a model or effort
 * the call or type chose unless the call overrides it again; one that came
 * from the parent follows the parent run's current binding.
 */
export const SUBAGENT_BINDING_SOURCES = ["parent", "type", "call"] as const;
export type SubagentBindingSource = (typeof SUBAGENT_BINDING_SOURCES)[number];

export function isSubagentBindingSource(value: unknown): value is SubagentBindingSource {
  return (SUBAGENT_BINDING_SOURCES as readonly unknown[]).includes(value);
}

/** Who wrote a follow-up (`RunFollowupOrigin`); only `user` follow-ups are the user's clarifications. */
export const RUN_FOLLOWUP_ORIGINS = ["user", "main_agent", "subagent_callback"] as const;
export type RunFollowupOrigin = (typeof RUN_FOLLOWUP_ORIGINS)[number];

/** The server-written user turn that wakes an idle main agent with sub-agent callbacks (`MessageSystemTurnKind`). */
export const SUBAGENT_CALLBACK_TURN_KIND = "subagent_callback";

/** The usage purpose of sub-agent model calls: personal, counted toward the user's allowance (`lib/domain/usagePurpose.ts`). */
export const SUBAGENT_USAGE_PURPOSE = "subagent";

/** The main agent's tools for sub-agents. None of them is ever offered to a sub-agent (no nesting, no resource changes). */
export const CALL_SUBAGENT_TOOL_NAME = "call_subagent";
export const STOP_SUBAGENT_TOOL_NAME = "stop_subagent";
export const CREATE_SUBAGENT_TOOL_NAME = "create_subagent";
export const EDIT_SUBAGENT_TOOL_NAME = "edit_subagent";
export const DELETE_SUBAGENT_TOOL_NAME = "delete_subagent";
export const SUBAGENT_TOOL_NAMES = Object.freeze([
  CALL_SUBAGENT_TOOL_NAME, STOP_SUBAGENT_TOOL_NAME, CREATE_SUBAGENT_TOOL_NAME, EDIT_SUBAGENT_TOOL_NAME, DELETE_SUBAGENT_TOOL_NAME
] as const);

/**
 * Stable refusal and failure codes of the sub-agent tools, routes and
 * admission. A refusal is visible, never a substitution (`agent_docs/PROVIDERS.md`).
 */
export const SUBAGENT_ERROR_CODES = Object.freeze({
  /** A 21st sub-agent would run at once in the chat. Ended threads do not count. */
  limitReached: "subagent_limit_reached",
  /** The requested model is not one of the user's tool-calling chat models in the run's frozen catalog. */
  modelUnavailable: "subagent_model_unavailable",
  /** The requested (or the type's) effort is not one the resolved model supports. */
  effortUnsupported: "subagent_effort_unsupported",
  /** The custom sub-agent is unknown, deleted, unusable here (Assistant chats) or its model is unavailable. */
  typeUnavailable: "subagent_type_unavailable",
  /** No thread of that name on this branch (tools), or a thread the caller may not see (routes). */
  notFound: "subagent_not_found",
  /** The name is not a valid sub-agent name (`SUBAGENT_NAME_PATTERN`). */
  nameInvalid: "subagent_name_invalid",
  /** The message is empty, too long or not text. */
  messageInvalid: "subagent_message_invalid",
  /** Background mode is not offered in this run (Telegram turns, scheduled tasks). */
  backgroundUnavailable: "subagent_background_unavailable",
  /** Usage limits refused a background sub-agent run; nothing ran. */
  usageLimited: "subagent_usage_limited",
  /**
   * The thread runs a turn that cannot take this call: a foreground turn of this answer (wait for its result), or a
   * background turn started on another branch (a thread has one active run at a time; start another name).
   */
  busy: "subagent_busy",
  /** A custom sub-agent with this name exists already (create, rename). */
  definitionExists: "subagent_definition_exists",
  /** The custom sub-agent changed since the version the caller read (edit). */
  definitionConflict: "subagent_definition_conflict",
  /** The user's custom sub-agent count is at its limit (create). */
  definitionLimit: "subagent_definition_limit"
} as const);
export type SubagentErrorCode = (typeof SUBAGENT_ERROR_CODES)[keyof typeof SUBAGENT_ERROR_CODES];

/** Why a `blocked` turn stopped short (`SubagentTurn.reasonCode`); other stable codes may follow. */
export const SUBAGENT_BLOCKED_REASONS = Object.freeze({
  /** A data-changing MCP call needs the user's approval: the main agent makes it, the user sees the card. */
  needsApproval: "needs_approval",
  signInRequired: "sign_in_required",
  botWall: "bot_wall",
  /** The user cancelled a browser handoff the sub-agent asked for. */
  userCancelled: "user_cancelled",
  browserBusy: "browser_busy",
  browserMemoryLow: "browser_memory_low",
  /** This Workspace's guest image has no per-agent browser tabs; only the main agent may browse until it is recreated. */
  browserUnavailable: "browser_unavailable",
  /** An irreversible website action or payment the user's own message did not ask for. */
  actionNotAuthorized: "action_not_authorized"
} as const);

/** Why a turn ended as `stopped` or `interrupted` (`SubagentTurn.reasonCode`). */
export const SUBAGENT_END_REASONS = Object.freeze({
  /** The main agent called `stop_subagent`. */
  stoppedByAgent: "stop_subagent",
  /** The user pressed Stop on the sub-agent. */
  stoppedByUser: "user_stop",
  /** The user pressed "Stop all" in the chat. */
  stoppedAll: "stop_all",
  /** The parent run that waited for a foreground turn stopped. */
  parentStopped: "parent_stopped",
  /** The turn reached its tool time. */
  deadline: "deadline",
  chatDeleted: "chat_deleted",
  /** A restart or crash ended the turn; it is never replayed (`interrupted`). */
  restart: "restart"
} as const);

/** Browser lease refusals of the Workspace guest helper (`ops/workspace-guest/python/aiqsa/agents.py`). */
export const BROWSER_BUSY_CODE = SUBAGENT_BLOCKED_REASONS.browserBusy;
export const BROWSER_MEMORY_LOW_CODE = SUBAGENT_BLOCKED_REASONS.browserMemoryLow;
/** Reset Workspace and continuation seeds while sub-agent runs are attached: "stop the sub-agents first". */
export const WORKSPACE_SUBAGENTS_RUNNING_CODE = "workspace_subagents_running";

const CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;

/** A stable code: lowercase snake case, bounded. Known codes are listed above; a writer may add one. */
export function isSubagentCode(value: unknown): value is string {
  return typeof value === "string" && CODE_PATTERN.test(value);
}

/**
 * Tool groups a custom sub-agent may be limited to (`SubagentDefinitionRevision.toolGroups`).
 * Always present: `update_plan`, `read_tool_result` and the guide. A group
 * never adds a tool the default sub-agent lacks: resource changes, Skill saves,
 * exports and the sub-agent tools themselves stay out whatever the list says.
 */
export const SUBAGENT_TOOL_GROUPS = Object.freeze({
  /** Workspace shell and files, the Workspace browser and `browser_handoff`, Workspace image view. */
  workspace: "workspace",
  web_search: "web_search",
  web_fetch: "web_fetch",
  /** The run's MCP catalog; data-changing calls still need approval or the guard. */
  mcp: "mcp",
  /** `load_skill` and `read_skill_file`. */
  skills: "skills",
  /** `read_secret`. */
  secrets: "secrets",
  /** `memory_search`. */
  memory: "memory",
  /** Image generation. */
  images: "images",
  /** System Vision image analysis. */
  vision: "vision"
} as const);
export type SubagentToolGroup = (typeof SUBAGENT_TOOL_GROUPS)[keyof typeof SUBAGENT_TOOL_GROUPS];
const TOOL_GROUP_VALUES: readonly string[] = Object.values(SUBAGENT_TOOL_GROUPS);

export function isSubagentToolGroup(value: unknown): value is SubagentToolGroup {
  return typeof value === "string" && TOOL_GROUP_VALUES.includes(value);
}

/** A tool group list: distinct known groups in the vocabulary's order, or null when it is not one. */
export function decodeSubagentToolGroups(value: unknown): SubagentToolGroup[] | null {
  if (!Array.isArray(value) || value.length > TOOL_GROUP_VALUES.length || !value.every(isSubagentToolGroup)) return null;
  if (new Set(value).size !== value.length) return null;
  const chosen: readonly string[] = value;
  return TOOL_GROUP_VALUES.filter((group): group is SubagentToolGroup => chosen.includes(group));
}

/** Bounds of a custom sub-agent (`SubagentDefinitionRevision`); the database keeps outer guards. */
export const SUBAGENT_DEFINITION_LIMITS = Object.freeze({
  nameCharacters: SUBAGENT_LIMITS.nameCharacters,
  descriptionCharacters: 1_000,
  instructionsCharacters: 32_000,
  /** Custom sub-agents one user keeps. */
  perUser: 50
});

/**
 * One step a sub-agent took, for the main agent and the thread view: the
 * tool's friendly name, its outcome (an unknown effect stays `unknown`) and a
 * bounded content-light line such as the browser's step line.
 */
export type SubagentStep = Readonly<{
  outcome: "complete" | "error" | "refused" | "unknown";
  summary: string;
  tool: string;
}>;

/**
 * A data-changing MCP call a sub-agent did not send: the guard refused it or
 * it needs the user's approval. The main agent makes exactly this call, so
 * the user sees the ordinary approval card.
 */
export type SubagentApprovalRequest = Readonly<{
  arguments: Readonly<Record<string, unknown>>;
  reason: "approval_required" | "guard_refused";
  serverName: string;
  /** The tool's name as the run's frozen catalog declares it to the main agent. */
  toolName: string;
}>;

/**
 * What `call_subagent` and `stop_subagent` return to the main agent, as the
 * JSON content of their result. Everything a sub-agent reports is untrusted
 * data for the main agent. `ended` is also a turn's stored result
 * (`SubagentTurn.result`) and what its callback renders.
 */
export type SubagentCallResult =
  | Readonly<{
      approvals: readonly SubagentApprovalRequest[];
      /** Workspace paths the sub-agent wrote, relative to the project folder. */
      files: readonly string[];
      kind: "ended";
      /** The model and effort the turn ran with (`modelId`, the effort or null for the model's default). */
      model: Readonly<{ effort: string | null; id: string }>;
      name: string;
      /** Only for `done`. */
      outcome?: SubagentOutcome;
      /** A blocked outcome's reason, or why the turn failed, stopped or was interrupted. */
      reason?: string;
      report: string;
      reportTruncated?: true;
      state: EndedSubagentState;
      /** Always present, failures included. */
      steps: readonly SubagentStep[];
      stepsTruncated?: true;
    }>
  /** A background turn admitted: the result arrives later as a callback. */
  | Readonly<{ continued: boolean; kind: "started"; name: string; state: ActiveSubagentState }>
  /** A message for a running sub-agent, delivered to its mailbox; it reads it at its next step. Receipt, not obedience. */
  | Readonly<{ kind: "delivered"; name: string; state: ActiveSubagentState }>;

export type EndedSubagentCallResult = Extract<SubagentCallResult, { kind: "ended" }>;

/** A report bounded for the main agent: cut at a character boundary with a mark, never silently. */
export function boundSubagentReport(text: string): Readonly<{ report: string; truncated: boolean }> {
  const characters = Array.from(text);
  if (characters.length <= SUBAGENT_LIMITS.reportCharacters) return { report: text, truncated: false };
  return { report: characters.slice(0, SUBAGENT_LIMITS.reportCharacters).join(""), truncated: true };
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const only = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key));
const boundedText = (value: unknown, max: number, allowEmpty = false): value is string =>
  typeof value === "string" && value.length <= max && (allowEmpty || value.trim().length > 0) && !value.includes("\0");

function decodeStep(value: unknown): SubagentStep | null {
  if (!record(value) || !only(value, ["outcome", "summary", "tool"])) return null;
  if (!["complete", "error", "refused", "unknown"].includes(value.outcome as string) ||
    !boundedText(value.tool, SUBAGENT_LIMITS.stepToolCharacters) ||
    !boundedText(value.summary, SUBAGENT_LIMITS.stepSummaryCharacters, true)) return null;
  return { outcome: value.outcome as SubagentStep["outcome"], summary: value.summary, tool: value.tool };
}

function decodeApproval(value: unknown): SubagentApprovalRequest | null {
  if (!record(value) || !only(value, ["arguments", "reason", "serverName", "toolName"])) return null;
  if (!record(value.arguments) || (value.reason !== "approval_required" && value.reason !== "guard_refused") ||
    !boundedText(value.serverName, SUBAGENT_LIMITS.approvalToolCharacters) ||
    !boundedText(value.toolName, SUBAGENT_LIMITS.approvalToolCharacters)) return null;
  let serialized: string;
  try {
    serialized = JSON.stringify(value.arguments);
  } catch {
    return null;
  }
  if (serialized.length > SUBAGENT_LIMITS.approvalArgumentsCharacters) return null;
  return { arguments: value.arguments, reason: value.reason, serverName: value.serverName, toolName: value.toolName };
}

const ENDED_KEYS = ["approvals", "files", "kind", "model", "name", "outcome", "reason", "report", "reportTruncated", "state",
  "steps", "stepsTruncated"];

/** A `call_subagent` or `stop_subagent` result, or a stored turn result; null when it is not one exactly. */
export function decodeSubagentCallResult(value: unknown): SubagentCallResult | null {
  if (!record(value) || normalizeSubagentName(value.name) !== value.name) return null;
  const name = value.name as string;
  if (value.kind === "started") {
    if (!only(value, ["continued", "kind", "name", "state"]) || typeof value.continued !== "boolean" ||
      !isActiveSubagentState(value.state)) return null;
    return { continued: value.continued, kind: "started", name, state: value.state };
  }
  if (value.kind === "delivered") {
    if (!only(value, ["kind", "name", "state"]) || !isActiveSubagentState(value.state)) return null;
    return { kind: "delivered", name, state: value.state };
  }
  if (value.kind !== "ended" || !only(value, ENDED_KEYS)) return null;
  const state = value.state;
  if (!isSubagentThreadState(state) || isActiveSubagentState(state)) return null;
  if ((state === "done") !== (value.outcome !== undefined)) return null;
  if (value.outcome !== undefined && !isSubagentOutcome(value.outcome)) return null;
  if (value.reason !== undefined && !isSubagentCode(value.reason)) return null;
  if ((value.outcome === "blocked" || state === "failed") && value.reason === undefined) return null;
  if (typeof value.report !== "string" || value.report.length > SUBAGENT_LIMITS.reportCharacters * 2 ||
    Array.from(value.report).length > SUBAGENT_LIMITS.reportCharacters) return null;
  if (value.reportTruncated !== undefined && value.reportTruncated !== true) return null;
  if (value.stepsTruncated !== undefined && value.stepsTruncated !== true) return null;
  if (!Array.isArray(value.files) || value.files.length > SUBAGENT_LIMITS.files ||
    !value.files.every((path) => boundedText(path, SUBAGENT_LIMITS.filePathCharacters))) return null;
  if (!Array.isArray(value.steps) || value.steps.length > SUBAGENT_LIMITS.steps) return null;
  const steps = value.steps.map(decodeStep);
  if (steps.some((step) => step === null)) return null;
  if (!Array.isArray(value.approvals) || value.approvals.length > SUBAGENT_LIMITS.approvals) return null;
  const approvals = value.approvals.map(decodeApproval);
  if (approvals.some((approval) => approval === null)) return null;
  if (!record(value.model) || !only(value.model, ["effort", "id"]) ||
    !boundedText(value.model.id, SUBAGENT_LIMITS.modelCharacters) ||
    (value.model.effort !== null && !boundedText(value.model.effort, SUBAGENT_LIMITS.effortCharacters))) return null;
  return {
    approvals: approvals as SubagentApprovalRequest[],
    files: [...value.files as string[]],
    kind: "ended",
    model: { effort: value.model.effort as string | null, id: value.model.id },
    name,
    ...(value.outcome !== undefined ? { outcome: value.outcome } : {}),
    ...(value.reason !== undefined ? { reason: value.reason } : {}),
    report: value.report,
    ...(value.reportTruncated === true ? { reportTruncated: true as const } : {}),
    state,
    steps: steps as SubagentStep[],
    ...(value.stepsTruncated === true ? { stepsTruncated: true as const } : {})
  };
}

/** One turn as the projection reads it: its state and when it started. */
export type SubagentTurnStateInput = Readonly<{ startedAt: Date | string; state: SubagentThreadState }>;

/**
 * A thread's state on a branch: the state of its latest turn there (by start,
 * later rows winning ties), or null when none of its turns is on the branch,
 * in which case the thread is not shown there.
 */
export function projectSubagentThreadState(turns: readonly SubagentTurnStateInput[]): SubagentThreadState | null {
  let latest: SubagentTurnStateInput | null = null;
  let latestAt = Number.NEGATIVE_INFINITY;
  for (const turn of turns) {
    const at = new Date(turn.startedAt).getTime();
    if (!Number.isFinite(at)) continue;
    if (at >= latestAt) {
      latest = turn;
      latestAt = at;
    }
  }
  return latest?.state ?? null;
}

/**
 * Whether a turn is on a branch: its parent run's answer message is on the
 * branch's path (the running answer included). A thread is on a branch when
 * its anchor run's answer is.
 */
export function isSubagentTurnOnBranch(parentAnswerMessageId: string | null, branchMessageIds: ReadonlySet<string>): boolean {
  return parentAnswerMessageId !== null && branchMessageIds.has(parentAnswerMessageId);
}

/**
 * Whether an ended background turn still owes its callback: no main-agent run
 * received it yet. A foreground turn's result is its parent's tool result.
 */
export function subagentCallbackOwed(turn: Readonly<{ callbackRunId: string | null; mode: SubagentTurnMode; state: SubagentThreadState }>): boolean {
  return turn.mode === "background" && !isActiveSubagentState(turn.state) && turn.callbackRunId === null;
}

/**
 * The sub-agent a call row of an answer's tool activity belongs to
 * (`ThreadToolActivityCall.subagent`): the thread a `call_subagent` or
 * `stop_subagent` call addressed, for the chat's card and its thread link.
 */
export type SubagentActivityRef = Readonly<{ mode: SubagentTurnMode; name: string; threadId: string }>;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

export function isSubagentIdentifier(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

export function decodeSubagentActivityRef(value: unknown): SubagentActivityRef | null {
  if (!record(value) || !only(value, ["mode", "name", "threadId"])) return null;
  if (!isSubagentTurnMode(value.mode) || normalizeSubagentName(value.name) !== value.name || !isSubagentIdentifier(value.threadId)) return null;
  return { mode: value.mode, name: value.name as string, threadId: value.threadId };
}

/**
 * The agent of one Workspace browser action, for step lines, the live panel's
 * switcher and a handoff's label: `main`, or a sub-agent's thread id with its
 * name (`ops/workspace-guest/python/aiqsa/agents.py`).
 */
export type BrowserAgentRef = Readonly<{ id: string; name: string | null }>;
