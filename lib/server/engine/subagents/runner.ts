import { randomUUID } from "node:crypto";
import { CHANGE_RESEARCH_FRAME_TOOL_NAME, RECORD_EVIDENCE_TOOL_NAME } from "../../../contracts/research";
import {
  CALL_SUBAGENT_TOOL_NAME,
  MAIN_AGENT_NAME,
  SUBAGENT_BLOCKED_REASONS,
  SUBAGENT_END_REASONS,
  SUBAGENT_FOLLOWUP_LIMITS,
  SUBAGENT_LIMITS,
  SUBAGENT_FILES_TRUNCATED_NOTICE,
  SUBAGENT_USAGE_PURPOSE,
  SUBAGENT_WAIT_REASONS,
  decodeSubagentCallResult,
  isSubagentCode,
  subagentQuestionNonce,
  type EndedSubagentCallResult,
  type EndedSubagentState,
  type SubagentApprovalRequest,
  type SubagentOutcome,
  type SubagentStep
} from "../../../contracts/subagents";
import type { ThreadWorkspaceActivityEntry } from "../../../contracts/workspace";
import { estimateApproxTokens } from "../../../domain/contextBudget";
import type { ModelRunUsage } from "../../../domain/modelRunEvents";
import { logEvent } from "../../observability";
import { gatewayRoutingLane } from "../../providers/gatewayRouting";
import type { ProviderHistoryItem } from "../../providers/history";
import { observedFailure } from "../../providers/providerObservability";
import type { ProviderRunRequest, ProviderRunResult } from "../../providers/types";
import type { RunUsageAttribution } from "../../runs/runRepositoryContract";
import { ToolCallRepeatHistory } from "../../runs/toolCallRepeatGuard";
import { reportedAnswerCost } from "../../runs/usagePricing";
import type { WorkspaceAgent } from "../../subagents/guestProtocol";
import type {
  BrowserAgentIdentity,
  SubagentBackgroundControl,
  SubagentBinding,
  SubagentDeliveryOutcome,
  SubagentMessage,
  SubagentMessaging,
  SubagentParentAgent,
  SubagentRunner,
  SubagentTypeResolver,
  SubagentStopReason,
  SubagentTurnHandle,
  SubagentTurnInput
} from "../../subagents/ports";
import type { McpApprovalRequest } from "../../mcp/writeApproval";
import { BROWSER_HANDOFF_TOOL_NAME } from "../../tools/browserHandoff";
import type { ModelToolCall, RunTool } from "../../tools/types";
import type { RunSecretSource } from "../../workspace/secrets/runSecrets";
import { engineItemRules, type ToolResultClearingPolicy } from "../compaction";
import { compactionModelCall } from "../compactionCalls";
import { turnContextItem } from "../conversation";
import { detachedCompactions } from "../detachedCompactions";
import { NO_ENGINE_TEST_FAULTS, type EngineTestFaults } from "../faults";
import { createHostedSearchEvidence, type HostedSearchEvidenceRow } from "./hostedSearchEvidence";
import { ANSWER_NOW_INSTRUCTION, NO_MORE_TOOLS_OUTPUT, runAgentLoop, type LoopToolChoice } from "../loop";
import { callModel } from "../modelCall";
import {
  SUBAGENT_CHILD_ROLE_SECTION,
  SUBAGENT_ROLE_SECTION,
  SUBAGENT_STARTER_ROLE_SECTION,
  subagentAgentMessageText,
  subagentChildQuestionText,
  subagentFollowupText,
  subagentTurnText
} from "../prompts";
import { createRunContext, type RunContext } from "../runContext";
import { splitTurnGuidance, withNativeSystemPrompt } from "../systemPrompt";
import {
  runToolBatch,
  SUBAGENT_APPROVAL_HANDED_BACK_OUTPUT,
  ToolBatchInactiveError,
  transcriptRecord,
  type ToolBatchDeps,
  type ToolBatchState
} from "../toolBatch";
import type { ToolCallStore } from "../toolCallStore";
import type { ToolRegistry } from "../toolRegistry";
import { toolOutputExcerpt } from "../toolResults";
import {
  modelResponseItems,
  projectTranscript,
  type TranscriptItem,
  type TranscriptProjectionOptions,
  type TranscriptTarget,
  type TranscriptToolResultItem,
  type TranscriptUserItem
} from "../transcript";
import type { TranscriptRepository, TranscriptThreadKey } from "../transcriptRepository";
import { createTranscriptWriter, type TranscriptWriter } from "../transcriptWriter";
import type { UnknownEffects } from "../unknownEffects";
import type { FrozenSubagentDefault } from "../../subagents/typeCatalog";
import { withForegroundTurnStops } from "./backgroundRunner";
import { subagentChildEngineTools, withSubagentDepthRefusals, withSubagentTools, type SubagentCallDeps } from "./callTools";
import { subagentMessageTools, type AgentToolTurn } from "./messageTools";
import type { FrozenSubagentModels, SubagentParentModel } from "./modelCatalog";
import type { SubagentModelRoute, SubagentRouteResult } from "./modelRoutes";
import { subagentToolRegistry } from "./registry";
import type { SubagentThreadStore } from "./threadStore";

/**
 * Foreground sub-agent turns on the native engine's loop (`runAgentLoop`,
 * never a second engine), implementing `SubagentRunner` for the run that
 * hosts them (`lib/server/subagents/ports.ts`). A turn's context is its
 * thread's own items from the branch's earlier runs and this one, then the
 * main agent's brief with the user's current message verbatim (the only
 * authority for irreversible website actions), after its own stable system
 * prompt, the run's context (Skills index, pinned Skills) and the Workspace
 * prompt contract; never the main transcript. Its tools are the run's
 * registry filtered (`registry.ts`) with what reaches the chat's other agents
 * (`messageTools.ts`), its records carry the thread key, its compaction and
 * gateway lanes are its own, and its model calls are usage of purpose
 * `subagent`. Stop and the deadline (the host's signal) end it; its thread
 * keeps what it recorded. A message reaches it in its mailbox, foreground or
 * background, and it reads them at its next step; a wait for one ends with the
 * message or the signal.
 *
 * With every tool it may start children (operator decision 2026-10-31), one
 * level deep: a foreground child is a turn of this same host, a background one
 * a run of its own that reports to this turn's mailbox. A turn that stops
 * calling tools stays for the reports of the children it left running, and a
 * turn's end takes its children with it, whatever ended it: they outlive
 * nothing, so no path wakes a sub-agent. What a child handed back for approval
 * climbs with its parent's result, by the server and not by the model, because
 * the parent may lack the tool and only the main agent can ask the user.
 */

/** What a host gives its sub-agents to start children with; absent, none of them can. */
export type SubagentChildHost = Readonly<{
  background?: SubagentBackgroundControl;
  /** Whether a child may run in the background: the run's rule (`SubagentCallDeps.backgroundAllowed`). */
  backgroundAllowed: boolean;
  catalog: FrozenSubagentModels | null;
  defaultType: FrozenSubagentDefault | null;
  /** A turn's binding as the model its children inherit. */
  modelOf(binding: SubagentBinding): SubagentParentModel;
  store: SubagentCallDeps["store"] & Pick<SubagentThreadStore, "activeChildren" | "childResults">;
  types?: SubagentTypeResolver;
}>;

/** What a sub-agent turn needs of the run that hosts it. */
export type SubagentHost = Readonly<{
  /** The run's accepted MCP and Workspace bindings and executors, built for this agent: the same code path as the parent's. */
  buildRegistry(input: Readonly<{
    agent: WorkspaceAgent;
    followupTexts(): readonly string[];
    onWorkspaceActivity(entry: ThreadWorkspaceActivityEntry): Promise<void>;
    request: ProviderRunRequest;
  }>): Promise<ToolRegistry>;
  /** The native runs of the branch's earlier answers, in branch order. */
  branchRunIds: readonly string[];
  /**
   * The runs that hold a thread's items on this branch, in turn order: its foreground turns' parent runs and its
   * background turns' own runs (`threadStore.ts`). Absent: the branch's answers and the host run.
   */
  threadRunIds?(threadId: string): Promise<readonly string[]>;
  /** Releases a sub-agent's browser slot when its turn ends (`BrowserAgentIdentity`, the browser lease task's). */
  browserIdentity?: BrowserAgentIdentity;
  /** The Workspace tool calls of this agent may start until then (`toolCallBounds`). */
  callTimeLeft(tool: Pick<RunTool, "capability" | "name">): boolean;
  chatId: string;
  children?: SubagentChildHost;
  /** The turn's hard deadline: the parent's tool time ends it first. */
  deadlineAt: number;
  /** Aborted when the parent reached its deadline (rather than Stop). */
  deadlineSignal: AbortSignal;
  faults?: EngineTestFaults;
  /** User text delivered into the parent run: `fetch_url` link authority. */
  followupTexts(): readonly string[];
  /**
   * The thread's mailbox on record (`RunFollowup`): what its turns of these runs have not read, oldest first. Only the
   * transcript write that holds a message stamps it (`TranscriptRepository.append`), so one a turn never got on record is
   * read by the next.
   */
  mailbox?: Readonly<{
    unread(input: Readonly<{ runIds: readonly string[]; threadId: string }>): Promise<readonly SubagentMessage[]>;
  }>;
  maxToolCalls: number | null;
  maxToolRounds: number | null;
  /** Writes what a turn's hosted Search found as link evidence for its run. */
  recordSearchEvidence(row: HostedSearchEvidenceRow): Promise<void>;
  /** How the turn's agent sees and reaches the others (`messageTools.ts`); absent, it has no such tools. */
  messaging?: SubagentMessaging;
  now(): number;
  /** The run's Workspace lifecycle rows (the VM starting or stopping), which the answer shows whoever caused them. */
  onWorkspaceLifecycle(entry: ThreadWorkspaceActivityEntry): Promise<void>;
  /** Records a compaction of a thread that finished after its turn, at a sequence its writer reserved. */
  recordDetachedCompaction(input: Readonly<{ item: TranscriptItem; sequence: number; thread: TranscriptThreadKey }>): Promise<boolean>;
  /** The run's admitted request, which a sub-agent's requests start from (`subagentRequest`). */
  request: ProviderRunRequest;
  /** How a route's requests render and size (`nativeRequestParams`, the replay target). */
  requestShape(route: SubagentModelRoute): Readonly<{ maxOutputTokens: number; params: Record<string, unknown>; target: TranscriptTarget }>;
  /** A turn clears its oldest page results past the policy's mark (`compaction/clearing.ts`): a research run's researchers only. */
  resultClearing?: ToolResultClearingPolicy;
  /** The model route of a binding: the parent's own, or a frozen model's (`modelRoutes.ts`). */
  route(binding: SubagentBinding, signal?: AbortSignal): Promise<SubagentRouteResult>;
  /** The run's context items (Skills index, pinned Skills): rebuilt per run, never recorded. */
  runContextItems: readonly TranscriptItem[];
  /** Saves a long result for a later read, as the parent does. */
  saveResult: ToolBatchDeps["saveResult"];
  secrets?: RunSecretSource;
  /** Marks the turn as waiting for the user (its browser handoff) or its parent's answer (`reason`), or running again. */
  setTurnState?(input: Readonly<{ reason?: string; state: "running" | "waiting"; turnId: string }>): Promise<boolean>;
  /** Ends a turn's `SubagentTurn` row with its result. */
  settleTurn(input: Readonly<{ result: EndedSubagentCallResult; turnId: string }>): Promise<boolean>;
  /** Writes the run's usage records once more (a detached compaction's late usage). */
  settleUsage(): Promise<void>;
  /** The parent run's Stop and deadline. */
  signal: AbortSignal;
  toolCalls: ToolCallStore;
  /** What the run has spent on tools: sub-agents count toward the answer's call budget. */
  toolState: ToolBatchState;
  toolTimeLeft(): boolean;
  /**
   * The calls one turn may make, its records and frame changes apart (`TURN_BUDGET_EXEMPT`): each turn of a thread counts its own, and
   * past them a call is refused as a budget refusal, so the turn's next round writes its report without tools. A research run's
   * researchers only (`RESEARCH_TASK_LIMITS`); absent, a turn has only the run's budgets.
   */
  turnToolCalls?: number;
  transcripts: Pick<TranscriptRepository, "append" | "loadRuns" | "nextSequence" | "runLive">;
  /**
   * A thread's view of the run's agent fences (`createAgentUnknownEffects`), seeded with the effects the branch's
   * threads left (`execution.ts`): the thread records only into its own fence, in its own order, and finds an effect
   * any agent of the run left unknown; a handed-back retry keeps its approval fence.
   */
  unknownEffects(threadId: string): UnknownEffects;
  /** The run's usage ledger. */
  usage(attribution: RunUsageAttribution): void;
  /**
   * Every follow-up the user wrote into the parent answer, delivered there or not yet, oldest first: a correction the
   * main agent already read reaches the sub-agent before its first request, and each reaches a thread once.
   */
  userFollowups(): Promise<readonly Readonly<{ id: string; text: string }>[]>;
  userId: string;
}>;

/** The engine's own failure of a turn, with its stable code. */
export class SubagentTurnFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SubagentTurnFailure";
  }
}

/**
 * Why a turn's own signal aborted when its time ended it rather than anyone's decision (`lib/server/research/clock.ts`). Its
 * parent planned on that end and reads the report, so what it was writing stays. Every other end has another reason, and a turn
 * ended by one keeps only what it completed.
 */
export class SubagentTimeEnded extends Error {
  constructor() {
    super("subagent_time_ended");
    this.name = "SubagentTimeEnded";
  }
}

/** Leads a report time cut off, so a reader of any excerpt of it sees that: a new turn's report is never cut (`SubagentCallResult`). */
export const SUBAGENT_REPORT_CUT_OFF = "[Incomplete: time ended this turn while it was writing this report, so the text below stops part way.]";

/**
 * How the turn part of the Workspace prompt contract begins (`workspacePromptContract().turn`, its test keeps them
 * equal): the only turn guidance a sub-agent keeps.
 */
export const WORKSPACE_TURN_GUIDANCE_PREFIX = "This turn's output directory: ";

/** Workspace activity kinds whose rows name a file the agent wrote. */
const WRITTEN_FILE_KINDS = new Set(["file_write", "file_copy", "file_move", "file_change"]);
const WORKSPACE_LIFECYCLE_KINDS = new Set(["attachments_prepare", "execution_status", "outputs_export", "workspace_recreated",
  "workspace_start", "workspace_stopped"]);
const BROWSER_STEP_LINE = /\[browser #\d+\][^\n]*/u;
const OUTCOME_LINE = /^\s*\**\s*outcome\s*\**\s*:\s*\**\s*(done|partial|blocked)\b\s*(?:\(\s*([a-z][a-z0-9_]{0,63})\s*\))?/iu;
/** Attempts to end a turn's row; one that stays unsettled ends with its run's next admission (`threadStore.ts`). */
const SETTLE_ATTEMPTS = 3;
/** How often a wait looks at the clock; a message ends it at once. */
const MAIL_CHECK_MS = 1_000;
/** Looks at a child gone from the record with no report coming (a restart, a delivery that failed) before a turn goes on without it. */
const CHILD_REPORT_LOOKS = 2;
/**
 * What a turn's own budget never counts (`SubagentHost.turnToolCalls`): a researcher's records and frame changes, so recording is never
 * what a spent budget discourages (operator-approved plan, 2026-11-03).
 */
const TURN_BUDGET_EXEMPT: ReadonlySet<string> = new Set([CHANGE_RESEARCH_FRAME_TOOL_NAME, RECORD_EVIDENCE_TOOL_NAME]);

const boundLine = (value: string, max: number) => {
  const line = value.replace(/\s+/gu, " ").trim();
  const characters = Array.from(line);
  return characters.length > max ? `${characters.slice(0, max - 1).join("")}…` : line;
};

/** A response's items for adapters that report none. */
function fallbackHistory(result: ProviderRunResult): ProviderHistoryItem[] {
  return [
    ...(result.finalText ? [{ text: result.finalText, type: "assistant_text" as const }] : []),
    ...(result.toolCalls ?? []).map((call) => ({ arguments: JSON.stringify(call.arguments), callId: call.id, name: call.name,
      type: "tool_call" as const }))
  ];
}

/**
 * A sub-agent's request base: the run's admitted request on this route's
 * model, with neither the parent's answer rules nor anything personal to the
 * user's own conversation (personal instructions, Memory context, the
 * current message's attachments); the Workspace contract, the tool index and
 * the run's other admitted guidance stay. Of the turn's own guidance only its
 * Workspace paths stay: the attachment, image and artifact facts describe what
 * the sub-agent was not given. Direct image view is the route's: the parent's
 * flag was decided from the parent's model, while `analyze_image` stays for
 * every model. `withoutWorkspace` is a turn the Workspace refused: it runs as in
 * a chat that has none, so no Workspace tool is offered.
 */
export function subagentRequest(request: ProviderRunRequest, route: SubagentModelRoute,
  options: Readonly<{ withoutWorkspace?: boolean }> = {}): ProviderRunRequest {
  const { personalContext: _personal, workspace, workspaceCheckpoints, workspaceImageView: _parentView, ...rest } = request;
  void _personal;
  void _parentView;
  const recorded = request.prompt.turnGuidance ?? [];
  const split = splitTurnGuidance(request.prompt.system ?? "", recorded);
  const kept = options.withoutWorkspace ? [] : split.turn.filter((part) => part.startsWith(WORKSPACE_TURN_GUIDANCE_PREFIX));
  const system = [split.chat, ...kept].filter((part) => part.trim()).join("\n\n");
  return {
    ...rest,
    ...(options.withoutWorkspace ? {} : { ...(workspace ? { workspace } : {}), ...(workspaceCheckpoints ? { workspaceCheckpoints } : {}),
      ...(workspace && route.workspaceImageView ? { workspaceImageView: route.workspaceImageView } : {}) }),
    attachmentIds: [],
    attachments: [],
    modelCapabilities: route.request.modelCapabilities,
    modelId: route.request.modelId,
    params: route.request.params,
    prompt: {
      ...(request.prompt.baseline ? { baseline: request.prompt.baseline } : {}),
      developer: null,
      system: system || null,
      ...(kept.length > 0 ? { turnGuidance: kept } : {})
    },
    provider: route.request.provider,
    reasoningEffort: route.request.reasoningEffort
  };
}

/** The report's first line, when it states the outcome as the role section asks. */
export function parseSubagentOutcome(report: string): Readonly<{ outcome: SubagentOutcome; reason?: string }> | null {
  const first = report.split("\n").find((line) => line.trim().length > 0) ?? "";
  const match = OUTCOME_LINE.exec(first);
  if (!match) return null;
  const outcome = match[1]!.toLowerCase() as SubagentOutcome;
  const reason = match[2]?.toLowerCase();
  return { outcome, ...(reason && isSubagentCode(reason) ? { reason } : {}) };
}

/** One call's step for the main agent: the tool's friendly name, its outcome and a content-light line. */
export function subagentStep(registry: ToolRegistry, call: ModelToolCall, result: TranscriptToolResultItem): SubagentStep {
  const activity = registry.resolve(call.name)?.activity(call);
  const name = activity?.toolName ?? call.name;
  const tool = boundLine(activity?.serverName && activity.serverName !== name ? `${activity.serverName}: ${name}` : name,
    SUBAGENT_LIMITS.stepToolCharacters) || "tool";
  const refused = result.output === SUBAGENT_APPROVAL_HANDED_BACK_OUTPUT || result.output === NO_MORE_TOOLS_OUTPUT;
  const outcome: SubagentStep["outcome"] = refused ? "refused" : result.outcome;
  const browser = BROWSER_STEP_LINE.exec(result.output)?.[0];
  const summary = browser ?? (refused ? (result.output === NO_MORE_TOOLS_OUTPUT ? "not run" : SUBAGENT_BLOCKED_REASONS.needsApproval)
    : outcome === "complete" ? "" : (result.output.split("\n").find((line) => line.trim()) ?? ""));
  return { outcome, summary: boundLine(summary, SUBAGENT_LIMITS.stepSummaryCharacters), tool };
}

/** The approval a sub-agent's call needs, as the main agent makes it again; null when it cannot be handed back whole. */
export function handedBackApproval(call: ModelToolCall, approval: McpApprovalRequest): SubagentApprovalRequest | null {
  try {
    JSON.stringify(call.arguments);
  } catch {
    return null;
  }
  return {
    arguments: call.arguments,
    reason: approval.guard ? "guard_refused" : "approval_required",
    serverName: approval.serverName,
    toolName: call.name
  };
}

/** What a turn's row says of it while it is active. */
type TurnActivity = Readonly<{ reason?: string; state: "running" | "waiting" }>;

type TurnWait = Readonly<{
  leave(): Promise<boolean>;
  /** The row says so; false when it could not be written. */
  marked: boolean;
}>;

type TurnWaits = Readonly<{ enter(kind: "answer" | "user"): Promise<TurnWait> }>;

/**
 * A turn's waits and the one row they make. They overlap when one response asks the parent and hands the browser to the
 * user: a question makes the row wait for its answer, else a handoff makes it wait for the user, else the turn runs. The
 * row is written only when that changes, one write at a time: every write clears the claim on the turn's question
 * (`setActiveState`), so a handoff ending beside a question writes nothing, and only the question's own end clears its
 * reason and its claim. After a failed write the row is unknown, and the next one is written whatever it says.
 */
function createTurnWaits(write: (activity: TurnActivity) => Promise<boolean>): TurnWaits {
  const waits = new Set<Readonly<{ kind: "answer" | "user" }>>();
  let written: TurnActivity | null = { state: "running" };
  let writes: Promise<boolean> = Promise.resolve(true);
  const sync = () => {
    writes = writes.then(async () => {
      const activity: TurnActivity = [...waits].some((wait) => wait.kind === "answer") ? { reason: SUBAGENT_WAIT_REASONS.answer, state: "waiting" }
        : waits.size > 0 ? { state: "waiting" } : { state: "running" };
      if (activity.state === written?.state && activity.reason === written?.reason) return true;
      const saved = await write(activity).catch(() => false);
      written = saved ? activity : null;
      return saved;
    });
    return writes;
  };
  return {
    async enter(kind) {
      const wait = { kind };
      waits.add(wait);
      const marked = await sync();
      return { leave: () => {
        waits.delete(wait);
        return sync();
      }, marked };
    }
  };
}

/** While a sub-agent waits in a browser handoff for the user, its turn waits (an active state) and runs again after. */
function waitingDuringHandoff(registry: ToolRegistry, waits: TurnWaits): ToolRegistry {
  return {
    ...registry,
    resolve: (name) => {
      const tool = registry.resolve(name);
      if (!tool || name !== BROWSER_HANDOFF_TOOL_NAME) return tool;
      return { ...tool, execute: async (execution) => {
        const wait = await waits.enter("user");
        try {
          return await tool.execute(execution);
        } finally {
          await wait.leave();
        }
      } };
    }
  };
}

/**
 * What one thread keeps across its turns in a host run: the highest round its calls took, the writer whose sequence
 * a later turn continues, and the user's follow-ups and the messages it already received.
 */
type ThreadState = {
  deliveredTexts: string[];
  readMessages: Set<string>;
  rounds: number;
  seenFollowups: Set<string>;
  writer: TranscriptWriter | null;
};

type TurnRecord = {
  /** Calls waiting for a message: a delivery wakes each. */
  readonly arrivals: Set<() => void>;
  /** This turn's background children, by name, whose report it has not had. */
  readonly awaitedChildren: Set<string>;
  /** It called `call_subagent`, so it may have children to end and calls of theirs to hand on. */
  calledChildren: boolean;
  readonly controller: AbortController;
  readonly input: SubagentTurnInput;
  readonly kind: "continue" | "start";
  readonly mailbox: SubagentMessage[];
  readonly promise: Promise<EndedSubagentCallResult>;
  result: EndedSubagentCallResult | null;
  stopReason: SubagentStopReason | null;
};

/** One look's wait: it ends with the next message, the signal or `MAIL_CHECK_MS`. */
function nextMail(turn: TurnRecord, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      turn.arrivals.delete(done);
      resolve();
    };
    const timer = setTimeout(done, MAIL_CHECK_MS);
    (timer as { unref?: () => void }).unref?.();
    signal.addEventListener("abort", done, { once: true });
    turn.arrivals.add(done);
  });
}

/**
 * Waits until a message that matches is in the turn's mailbox, for as long as `open` says. It stays in the mailbox for
 * the turn's next step to read like any other. A stop or the deadline ends the wait by the signal, through the same path
 * as any call they cut.
 */
async function mailArrived(turn: TurnRecord, matches: (message: SubagentMessage) => boolean, signal: AbortSignal, open: () => boolean): Promise<boolean> {
  for (;;) {
    signal.throwIfAborted();
    if (turn.mailbox.some(matches)) return true;
    if (!open()) return false;
    await nextMail(turn, signal);
  }
}

/** A child's report taken off a turn's list of those it waits for. */
function reportArrived(turn: TurnRecord, message: SubagentMessage): void {
  if (message.origin === "subagent_callback" && message.from) turn.awaitedChildren.delete(message.from);
}

/**
 * What a parent's result says of the calls its children handed back: they go up with it, once each, and a parent that
 * calls itself done is still blocked on them, because they did not run. Nothing else of a child's result climbs: the
 * parent has read that, and decides what its report says.
 */
export function withChildApprovals(result: EndedSubagentCallResult, childResults: readonly unknown[]): EndedSubagentCallResult {
  const seen = new Set(result.approvals.map((approval) => JSON.stringify([approval.serverName, approval.toolName, approval.arguments])));
  const added: SubagentApprovalRequest[] = [];
  for (const value of childResults) {
    const child = decodeSubagentCallResult(value);
    for (const approval of child?.kind === "ended" ? child.approvals : []) {
      const key = JSON.stringify([approval.serverName, approval.toolName, approval.arguments]);
      if (seen.has(key)) continue;
      seen.add(key);
      added.push(approval);
    }
  }
  if (added.length === 0) return result;
  const blocked = result.state === "done" && result.outcome !== "blocked";
  return { ...result, approvals: [...result.approvals, ...added],
    ...(blocked ? { outcome: "blocked" as const, reason: SUBAGENT_BLOCKED_REASONS.needsApproval } : {}) };
}

/** The ended result of a turn, bounded as `decodeSubagentCallResult` accepts it. */
export function endedSubagentCallResult(input: Readonly<{
  approvals: readonly SubagentApprovalRequest[];
  binding: Pick<SubagentBinding, "modelId" | "reasoningEffort">;
  files: readonly string[];
  name: string;
  outcome?: SubagentOutcome;
  question?: string;
  reason?: string;
  report: string;
  state: EndedSubagentState;
  steps: readonly SubagentStep[];
}>): EndedSubagentCallResult {
  const steps = input.steps.slice(-SUBAGENT_LIMITS.steps);
  const uniqueFiles = [...new Set(input.files)];
  const files = uniqueFiles.filter((path) => path.trim() && path.length <= SUBAGENT_LIMITS.filePathCharacters &&
    !path.includes("\0")).slice(0, SUBAGENT_LIMITS.files);
  const reason = input.reason && isSubagentCode(input.reason) ? input.reason : undefined;
  const outcome = input.state === "done" ? input.outcome ?? "done" : undefined;
  const blockedReason = outcome === "blocked" || input.state === "failed" ? reason ?? "subagent_blocked" : reason;
  return {
    approvals: input.approvals,
    files,
    ...(files.length < uniqueFiles.length ? { filesNotice: SUBAGENT_FILES_TRUNCATED_NOTICE } as const : {}),
    kind: "ended",
    model: { effort: input.binding.reasoningEffort ? input.binding.reasoningEffort.slice(0, SUBAGENT_LIMITS.effortCharacters) : null,
      id: input.binding.modelId.slice(0, SUBAGENT_LIMITS.modelCharacters) },
    name: input.name,
    ...(outcome ? { outcome } : {}),
    ...(input.question ? { question: input.question } : {}),
    ...(blockedReason ? { reason: blockedReason } : {}),
    report: input.report,
    state: input.state,
    steps,
    ...(input.steps.length > steps.length ? { stepsTruncated: true as const } : {})
  };
}

/** Why a turn that threw ended: stopped (by whom), or failed with a stable code. */
function endingOf(error: unknown, turn: TurnRecord, host: SubagentHost): Readonly<{ reason: string; state: "failed" | "stopped" }> {
  if (turn.stopReason) return { reason: turn.stopReason, state: "stopped" };
  if (host.deadlineSignal.aborted) return { reason: SUBAGENT_END_REASONS.deadline, state: "stopped" };
  if (host.signal.aborted || turn.input.signal.aborted || error instanceof ToolBatchInactiveError) {
    return { reason: SUBAGENT_END_REASONS.parentStopped, state: "stopped" };
  }
  if (error instanceof SubagentTurnFailure) return { reason: error.code, state: "failed" };
  const code = observedFailure(error).code;
  return { reason: code !== "unknown" && isSubagentCode(code) ? code : "subagent_failed", state: "failed" };
}

export type HostedSubagentRunner = SubagentRunner & Readonly<{
  /** Resolves a binding's route before its turn is admitted, so a refusal leaves no turn; the turn reuses it. */
  prepareRoute(binding: SubagentBinding, signal?: AbortSignal): Promise<SubagentRouteResult>;
  /** Stops every running turn (the parent ends); resolves once they ended. */
  stopAll(reason: SubagentStopReason): Promise<void>;
}>;

const bindingKey = (binding: SubagentBinding) =>
  JSON.stringify([binding.provider, binding.providerModelId, binding.modelId, binding.reasoningEffort]);

export function createSubagentRunner(host: SubagentHost): HostedSubagentRunner {
  const turns = new Map<string, TurnRecord>();
  const threadStates = new Map<string, ThreadState>();
  /** A thread's allocators and receipts in one host run, for the life of the run. */
  const threadStateOf = (input: Pick<SubagentTurnInput, "hostRunId" | "threadId">): ThreadState => {
    const key = `${input.hostRunId}\n${input.threadId}`;
    let state = threadStates.get(key);
    if (!state) {
      state = { deliveredTexts: [], readMessages: new Set(), rounds: 0, seenFollowups: new Set(), writer: null };
      threadStates.set(key, state);
    }
    return state;
  };
  const routes = new Map<string, Promise<SubagentRouteResult>>();

  const routeFor = (binding: SubagentBinding, signal?: AbortSignal) => {
    const key = bindingKey(binding);
    let route = routes.get(key);
    if (!route) {
      route = host.route(binding, signal);
      routes.set(key, route);
      // A failed resolution is not kept: the next call tries again.
      void route.then((result) => { if (!result.ok) routes.delete(key); }, () => routes.delete(key));
    }
    return route;
  };

  /** What a sub-agent's own `call_subagent` and `stop_subagent` work with: its binding, its time, its run. */
  function childDeps(turn: TurnRecord, children: SubagentChildHost): SubagentCallDeps & Readonly<{ parentAgent: SubagentParentAgent }> {
    const { input } = turn;
    return {
      ...(children.background ? { background: children.background } : {}),
      backgroundAllowed: children.backgroundAllowed,
      branchRunId: input.parentRunId,
      branchRunIds: [...new Set([...host.branchRunIds, input.parentRunId])],
      catalog: children.catalog,
      chatId: host.chatId,
      deadlineAt: () => new Date(host.deadlineAt),
      defaultType: children.defaultType,
      onChildStarted: (name) => { turn.awaitedChildren.add(name); },
      parent: children.modelOf(input.binding),
      parentAgent: { name: input.name, runId: input.hostRunId, threadId: input.threadId, toolState: host.toolState, turnId: input.turnId },
      runId: input.hostRunId,
      runner: listedRunner,
      store: children.store,
      ...(children.types ? { types: children.types } : {}),
      userId: host.userId,
      userMessage: input.userMessage,
      ...(input.workspaceRefused ? { workspaceRefused: input.workspaceRefused } : {})
    };
  }

  /**
   * A turn's end takes its children with it, whatever ended it, before its own result is on record, so a parent is never
   * reported ended with work of its own still running; then what they handed back goes up with it. Never fails the turn.
   */
  async function endChildren(record: TurnRecord, result: EndedSubagentCallResult): Promise<EndedSubagentCallResult> {
    const { input } = record;
    if (!record.calledChildren || !host.children) return result;
    const scope = { chatId: host.chatId, userId: host.userId };
    try {
      await host.children.background?.stopChildren({ ...scope, threadId: input.threadId });
      return withChildApprovals(result, await host.children.store.childResults({ ...scope, parentTurnId: input.turnId }));
    } catch (error) {
      logEvent("service_operation", { action: "degrade", code: "subagent_children_unsettled", error, outcome: "degraded", run_id: input.hostRunId,
        stage: "write", subsystem: "database" });
      return result;
    }
  }

  async function settleRow(input: SubagentTurnInput, result: EndedSubagentCallResult): Promise<void> {
    for (let attempt = 1; attempt <= SETTLE_ATTEMPTS; attempt += 1) {
      try {
        await host.settleTurn({ result, turnId: input.turnId });
        return;
      } catch (error) {
        logEvent("service_operation", { action: attempt < SETTLE_ATTEMPTS ? "retry" : "degrade", attempt, code: "subagent_turn_unsettled",
          error, outcome: attempt < SETTLE_ATTEMPTS ? "failed" : "degraded", run_id: input.hostRunId, stage: "write",
          subsystem: "database" });
      }
    }
  }

  async function executeTurn(turn: TurnRecord): Promise<EndedSubagentCallResult> {
    const { input } = turn;
    const thread: TranscriptThreadKey = { threadId: input.threadId, turnId: input.turnId };
    const scope = { chatId: host.chatId, runId: input.hostRunId, thread, userId: host.userId };
    const signal = AbortSignal.any([host.signal, input.signal, turn.controller.signal]);
    const agent: WorkspaceAgent = { kind: "subagent", name: input.name, threadId: input.threadId };
    const steps: SubagentStep[] = [];
    const approvals: SubagentApprovalRequest[] = [];
    const files = new Set<string>();
    const threadState = threadStateOf(input);
    const deliveredTexts = threadState.deliveredTexts;
    // The thread's rounds continue across its turns in this run, so their calls never take each other's keys.
    const roundBase = threadState.rounds;
    let writer: TranscriptWriter | null = null;
    let context: RunContext | null = null;
    let report = "";
    let roundText = "";
    /** What the current attempt has streamed: no response holds it yet, so it counts only if time cuts that attempt off. */
    let streamed = "";
    /** A foreground turn's question: its parent can read nothing until it ends, so the turn ends with it. */
    const handBack: { question: string | null } = { question: null };
    let questions = 0;
    /** Mailbox messages this turn took and has not yet on record, by the transcript item that holds each: item id, nonce. */
    const unrecorded = new Map<string, string>();
    const ended = (state: EndedSubagentState, extra: Readonly<{ outcome?: SubagentOutcome; reason?: string }> = {}) =>
      endedSubagentCallResult({ approvals, binding: input.binding, files: [...files], name: input.name, report: report || roundText,
        state, steps, ...(handBack.question ? { question: handBack.question } : {}), ...extra });
    const waits = createTurnWaits((activity) => host.setTurnState?.({ ...activity, turnId: input.turnId }) ?? Promise.resolve(false));
    const parentName = input.parentAgent?.name ?? MAIN_AGENT_NAME;
    /** What that agent wrote: the main agent writes under no name, and a sub-agent under its own, its orders included. */
    const writtenBy = (name: string) => (message: SubagentMessage) => name === MAIN_AGENT_NAME
      ? message.origin === "main_agent" && message.from === undefined : message.from === name;
    const fromParent = writtenBy(parentName);
    /** Messages of its parent an earlier question of this batch took: one stays in the mailbox until the turn's next step. */
    const answers = new Set<string>();
    const agentTurn: AgentToolTurn = {
      name: input.name,
      async ask(question, execution) {
        if (questions >= SUBAGENT_FOLLOWUP_LIMITS.questionsPerTurn) return "limit";
        questions += 1;
        if (input.mode === "foreground") {
          handBack.question ??= question;
          return "handed_back";
        }
        const wait = await waits.enter("answer");
        try {
          if (!wait.marked) return "unavailable";
          if (input.parentAgent) {
            // Its parent runs, or it would have ended with it: the question goes to its mailbox, and the turn waits like any asker.
            const sent = await host.messaging?.send({ chatId: host.chatId, from: input.name, nonce: subagentQuestionNonce(execution.persistedToolCallId),
              parentRunId: input.parentRunId, question: true, text: question, to: input.parentAgent.name, userId: host.userId });
            if (sent?.kind !== "delivered") return "unavailable";
          } else host.messaging?.questionAsked({ chatId: host.chatId, userId: host.userId });
          const unanswered = (message: SubagentMessage) => fromParent(message) && !answers.has(message.nonce);
          if (!await mailArrived(turn, unanswered, execution.signal, host.toolTimeLeft)) return "no_answer";
          const answer = turn.mailbox.find(unanswered);
          if (answer) answers.add(answer.nonce);
          return "answered";
        } finally {
          await wait.leave();
        }
      },
      async waitForReply(from, execution) {
        // A foreground parent reads nothing until the turn ends: no wait can get its reply.
        if (from === parentName && input.mode === "foreground") return false;
        const until = host.now() + SUBAGENT_FOLLOWUP_LIMITS.replyWaitMinutes * 60_000;
        return mailArrived(turn, writtenBy(from), execution.signal, () => host.now() < until && host.toolTimeLeft());
      }
    };
    try {
      const routed = await routeFor(input.binding, signal);
      if (!routed.ok) return ended("failed", { reason: routed.code });
      const route = routed.route;
      const shape = host.requestShape(route);
      // In a chat with no Workspace the refusal says only that, and there is nothing to tell the agent.
      const workspaceRefused = host.request.workspace ? input.workspaceRefused : undefined;
      const request = { ...subagentRequest(host.request, route, { withoutWorkspace: workspaceRefused !== undefined }), params: shape.params };
      const onWorkspaceActivity = async (entry: ThreadWorkspaceActivityEntry) => {
        if (WORKSPACE_LIFECYCLE_KINDS.has(entry.kind)) await host.onWorkspaceLifecycle(entry);
        if (!WRITTEN_FILE_KINDS.has(entry.kind) || entry.phase !== "succeeded") return;
        for (const change of entry.changes ?? []) if (change.action !== "delete") files.add(change.displayPath);
        const path = entry.file?.targetPath ?? entry.file?.displayPath;
        if (path && entry.kind !== "file_change") files.add(path);
      };
      const filtered = subagentToolRegistry(await host.buildRegistry({ agent,
        followupTexts: () => [...host.followupTexts(), ...deliveredTexts], onWorkspaceActivity, request }), input.type?.toolGroups ?? null);
      // No tool group narrows them: they reach the agents of the chat, nothing outside it.
      const messages = host.messaging ? subagentMessageTools({ chatId: host.chatId, messaging: host.messaging, parentRunId: input.parentRunId,
        userId: host.userId }, agentTurn) : [];
      // Only a sub-agent with every tool starts children: a list narrows, and a child must not have what its parent was denied.
      const starts = host.children && !input.parentAgent && !input.type?.toolGroups ? host.children : null;
      const children = starts ? subagentChildEngineTools(childDeps(turn, starts), () => { turn.calledChildren = true; }) : [];
      const offered = withSubagentTools(filtered, [...messages, ...children]);
      const registry = waitingDuringHandoff(input.parentAgent ? withSubagentDepthRefusals(offered) : offered, waits);
      // A thread's earlier turns may have run in the background, in runs of their own that answer nothing.
      const runIds = [...new Set([...(host.threadRunIds ? await host.threadRunIds(input.threadId) : host.branchRunIds),
        input.hostRunId])];
      const loaded = await host.transcripts.loadRuns({ chatId: host.chatId, runIds, threadId: input.threadId, userId: host.userId });
      // What an earlier turn never read, or what came while this one was attaching, is read first.
      for (const message of await host.mailbox?.unread({ runIds, threadId: input.threadId }).catch(() => []) ?? []) {
        if (!turn.mailbox.some((entry) => entry.nonce === message.nonce)) turn.mailbox.push(message);
      }
      const history = runIds.flatMap((runId) => loaded.get(runId) ?? []);
      const roleSection = input.parentAgent ? SUBAGENT_CHILD_ROLE_SECTION : starts ? SUBAGENT_STARTER_ROLE_SECTION : SUBAGENT_ROLE_SECTION;
      const role = input.type?.instructions.trim() ? `${roleSection}\n\n# Your instructions\n${input.type.instructions.trim()}` : roleSection;
      const native = await withNativeSystemPrompt({ now: new Date(host.now()), request, scope: { runId: input.hostRunId, userId: host.userId },
        ...(host.secrets ? { secrets: host.secrets } : {}), selfService: role, snapshot: route.snapshot, tools: registry.definitions() });
      const base = native.request;
      const inputItem: TranscriptUserItem = { id: `sub-${input.turnId}`, kind: "user",
        text: subagentTurnText({ brief: input.brief, continued: turn.kind === "continue", name: input.name, ...(input.parentAgent ? { parent: input.parentAgent.name } : {}),
          userMessage: input.userMessage, ...(workspaceRefused ? { workspaceRefused } : {}) }) };
      // The run's one fence (`SubagentHost.unknownEffects`): only the user's own words count as them speaking, never the
      // main agent's brief or messages.
      const unknownEffects = host.unknownEffects(input.threadId);
      const seenFollowups = threadState.seenFollowups;
      const incoming = async (): Promise<TranscriptUserItem[]> => {
        const added: TranscriptUserItem[] = [];
        for (const followup of await host.userFollowups().catch(() => [])) {
          if (seenFollowups.has(followup.id)) continue;
          seenFollowups.add(followup.id);
          added.push({ followup: true, id: randomUUID(), kind: "user", text: subagentFollowupText(followup.text) });
          deliveredTexts.push(followup.text);
          unknownEffects.userSpoke();
        }
        for (const message of turn.mailbox.splice(0)) {
          reportArrived(turn, message);
          if (threadState.readMessages.has(message.nonce)) continue;
          threadState.readMessages.add(message.nonce);
          const id = randomUUID();
          unrecorded.set(id, message.nonce);
          if (message.origin === "user") {
            added.push({ followup: true, id, kind: "user", text: subagentFollowupText(message.text) });
            deliveredTexts.push(message.text);
            unknownEffects.userSpoke();
          } else if (message.origin === "subagent_message") {
            // Another agent's message is no user speech and no brief: it releases nothing, authorizes nothing and changes no task.
            added.push({ id, kind: "user", text: subagentAgentMessageText({ from: message.from ?? "unknown", text: message.text }) });
          } else if (message.origin === "subagent_question") {
            added.push({ id, kind: "user", text: subagentChildQuestionText({ from: message.from ?? "unknown", text: message.text }) });
          } else if (message.origin === "subagent_callback") {
            // Written by the server, with what a callback carries: the report inside stays its writer's own account.
            added.push({ id, kind: "user", text: message.text });
          } else {
            // Its parent's message is no user speech: it never releases an unknown effect or authorizes a link.
            added.push({ id, kind: "user", text: subagentTurnText({ brief: message.text, continued: true, name: input.name,
              ...(input.parentAgent ? { parent: input.parentAgent.name } : {}), userMessage: input.userMessage }) });
          }
        }
        return added;
      };
      // What the user already wrote into this answer (a correction the main agent read before it called) comes with the brief.
      const earlier = await incoming();
      const items: TranscriptItem[] = [...host.runContextItems, ...history, turnContextItem(native.turnContext), inputItem, ...earlier];
      // One sequence per thread for the life of the run: a later turn continues where the last one stopped, and a compaction
      // that finished after its turn reserves from the thread's current writer.
      const activeWriter = createTranscriptWriter({
        // A message is read when the write that holds it commits, which stamps it: never before, so none is lost, and in one
        // transaction, so none is read twice.
        append: async (from, added) => {
          const nonces = added.flatMap((item) => unrecorded.get(item.id) ?? []);
          await host.transcripts.append(scope, from, added, nonces.length > 0 ? { nonces, runIds, threadId: input.threadId } : undefined);
          for (const item of added) unrecorded.delete(item.id);
        },
        firstSequence: threadState.writer ? threadState.writer.reserve(0) : await host.transcripts.nextSequence(scope),
        runId: input.hostRunId });
      threadState.writer = activeWriter;
      writer = activeWriter;
      const record = (added: readonly TranscriptItem[]) => activeWriter.record(added.map((item) => transcriptRecord(registry, item)));
      // The brief is on record before the turn's first request, so a later turn of the thread reads it.
      await record([inputItem, ...earlier]);
      const append = async (added: readonly TranscriptItem[]) => {
        if (added.length === 0) return;
        items.push(...added);
        void record(added).catch(() => undefined);
      };
      const appendCalls = async (added: readonly TranscriptItem[]) => {
        if (added.length === 0) return;
        items.push(...added);
        await record(added);
      };
      const recordUsage = (usage: ModelRunUsage, costUsd: number | undefined) => host.usage({ ...reportedAnswerCost(costUsd),
        modelId: route.request.modelId, operationCount: 1, provider: route.request.provider, providerModelId: route.snapshot.providerModelId,
        purpose: SUBAGENT_USAGE_PURPOSE, usage } satisfies RunUsageAttribution);
      const batchDeps: ToolBatchDeps = {
        approvalHandBack: (call, approval) => {
          const handed = handedBackApproval(call, approval);
          if (handed) approvals.push(handed);
        },
        chatId: host.chatId,
        history: new ToolCallRepeatHistory(),
        maxToolCalls: host.maxToolCalls,
        // Outputs of a sub-agent's tools stay its own: the main agent hands on what it chooses from the report and files.
        onEvent: async () => undefined,
        onLiveEvent: () => undefined,
        registry,
        runId: input.hostRunId,
        saveResult: host.saveResult,
        signal,
        store: host.toolCalls,
        thread,
        toolTimeLeft: host.callTimeLeft,
        // Made with the turn, so each turn of a thread starts its own count.
        ...(host.turnToolCalls !== undefined ? { turnBudget: { exempt: TURN_BUDGET_EXEMPT, limit: host.turnToolCalls, spent: { calls: 0 } } } : {}),
        unknownEffects,
        userId: host.userId
      };
      const target = shape.target;
      const projection: TranscriptProjectionOptions = { ...(registry.images ? { images: registry.images } : {}) };
      // The thread's own lanes (`gatewayRouting.ts`): its rounds never overlap, and its compactions run beside them.
      const loopRouting = gatewayRoutingLane({ chatId: host.chatId, name: `subagent:${input.threadId}` });
      const compactionRouting = gatewayRoutingLane({ chatId: host.chatId, name: `subagent-compaction:${input.threadId}:${input.turnId}` });
      const detachedSequences = new Map<string, number>();
      const window = route.request.modelCapabilities.contextWindow
        ? { contextWindow: route.request.modelCapabilities.contextWindow, maxOutputTokens: shape.maxOutputTokens } : null;
      const activeContext = createRunContext({
        append,
        // Its stubs go on record with the thread through `append`, so a later turn of it reads the same context.
        ...(host.resultClearing ? { clearing: host.resultClearing } : {}),
        compactionCall: (latest) => compactionModelCall({ adapter: route.adapter, deadlineAt: host.deadlineAt, now: host.now,
          onUsage: recordUsage, routing: compactionRouting, timeoutMs: route.timeoutMs }, latest),
        // A compaction still running when the turn ends goes on detached under the thread's own key, and the thread's
        // next turn joins it.
        detached: { chatId: `${host.chatId}:subagent:${input.threadId}`, live: () => host.transcripts.runLive(scope),
          record: (item) => {
            const sequence = detachedSequences.get(item.id) ?? (threadState.writer ?? activeWriter).reserve(1);
            detachedSequences.set(item.id, sequence);
            return host.recordDetachedCompaction({ item, sequence, thread });
          }, registry: detachedCompactions, settleUsage: host.settleUsage, userId: host.userId },
        insert: (added) => { items.push(...added); },
        items,
        now: host.now,
        // The thread's compactions are its own; the answer's process disclosure shows none of them.
        onStatus: async () => undefined,
        projection,
        record: (item) => transcriptRecord(registry, item),
        rules: engineItemRules(null),
        runId: input.hostRunId,
        signal,
        target,
        tooLarge: () => new SubagentTurnFailure("context_too_large"),
        window
      });
      context = activeContext;
      const sendOnceMore = async (request: ProviderRunRequest, send: (sent: ProviderRunRequest) => Promise<ProviderRunResult>) => {
        try {
          return await send(request);
        } catch (error) {
          const retry = await activeContext.overflow(request, error);
          if (!retry) throw error;
          return send(retry);
        }
      };
      let pending: TranscriptUserItem[] = [];
      /**
       * A turn that stopped calling tools stays for the reports of the children it left running, whose reports are what it
       * started them for, and goes on from each. Its tool time bounds this; a question it handed back ends it at once, and
       * a child that left the record without a report does not hold it.
       */
      const childReports = async () => {
        let gone = 0;
        while (turn.awaitedChildren.size > 0 && turn.mailbox.length === 0 && handBack.question === null && host.toolTimeLeft() &&
          gone < CHILD_REPORT_LOOKS) {
          signal.throwIfAborted();
          const running = await host.children?.store.activeChildren({ chatId: host.chatId, threadId: input.threadId, userId: host.userId })
            .catch(() => 1) ?? 0;
          const coming = host.children?.background?.reportsOnTheirWay(input.threadId) ?? 0;
          gone = running + coming > 0 ? 0 : gone + 1;
          await nextMail(turn, signal);
        }
      };
      // Outputs stay the sub-agent's own, but what its hosted Search found still authorizes page reads (`hostedSearchEvidence.ts`).
      const searchEvidence = createHostedSearchEvidence({ modelRunId: input.hostRunId, record: host.recordSearchEvidence,
        searchPlan: request.searchPlan });
      const outcome = await runAgentLoop({
        append,
        appendCalls,
        callModel: (request) => sendOnceMore(request, async (sent) => {
          const evidence = searchEvidence.modelCall();
          // A request sent once more after a size refusal is a new attempt, as a retry inside `callModel` is.
          streamed = "";
          const result = await callModel({ adapter: route.adapter, deadlineAt: host.deadlineAt,
            faults: host.faults ?? NO_ENGINE_TEST_FAULTS, now: host.now,
            onDiscard: async () => {
              streamed = "";
              evidence.discard();
            },
            onEvent: async (event) => {
              if (event.type === "token") streamed += event.data.delta;
              evidence.add(event);
            }, onUsage: recordUsage, routing: loopRouting, signal, timeoutMs: route.timeoutMs }, sent);
          await evidence.save();
          return result;
        }),
        closeFollowups: async () => {
          await childReports();
          pending.push(...await incoming());
          return pending.length === 0;
        },
        deliverFollowups: async () => {
          pending.push(...await incoming());
          const delivered = pending;
          pending = [];
          if (delivered.length > 0) report = "";
          return delivered;
        },
        maxToolRounds: host.maxToolRounds,
        prepareRequest: async ({ answerNow, toolChoice }: Readonly<{ answerNow?: true; round: number; toolChoice: LoopToolChoice }>) => {
          const prepared = await activeContext.prepare({ ...base, history: projectTranscript(items, target, projection),
            parallelToolCalls: true, previousProviderResponseId: undefined, providerToolMessages: undefined, toolChoice,
            tools: [...registry.definitions()] });
          return answerNow ? { ...prepared, history: [...(prepared.history ?? []), { text: ANSWER_NOW_INSTRUCTION, type: "user" as const }] }
            : prepared;
        },
        responseItems: (result) => modelResponseItems({ estimate: estimateApproxTokens, history: result.history ?? fallbackHistory(result),
          nextId: randomUUID, origin: target, requestAnchor: activeContext.requestAnchor(result.usage), usage: result.usage }),
        roundEnd: async (result) => {
          activeContext.observe(result.usage);
          streamed = "";
          roundText = result.finalText;
          if (result.finalText.trim()) report = report ? `${report}\n\n${result.finalText}` : result.finalText;
        },
        roundStart: async () => {
          roundText = "";
        },
        runTools: async (calls, round) => {
          // Narration before tool calls is no report: the report is what the agent says once it stops calling tools.
          report = "";
          const threadRound = roundBase + round;
          threadState.rounds = Math.max(threadState.rounds, threadRound);
          const batch = await runToolBatch(batchDeps, host.toolState, { calls, round: threadRound });
          calls.forEach((call, index) => {
            const result = batch.results[index];
            if (result) steps.push(subagentStep(registry, call, result));
          });
          return batch;
        },
        signal,
        // A handed-back question closes tools: the next round is the report its parent is waiting for.
        toolTimeLeft: () => handBack.question === null && host.toolTimeLeft()
      });
      await activeContext.afterAnswer();
      await activeWriter.flush();
      // The question reaches the parent whatever the model made of its last round.
      if (handBack.question !== null && !(report || roundText).trim()) {
        report = `Outcome: blocked (${SUBAGENT_BLOCKED_REASONS.needsAnswer})\n\n${handBack.question}`;
      }
      if (outcome.kind === "empty" && handBack.question === null || !(report || roundText).trim()) return ended("failed", { reason: "model_answer_empty" });
      const stated = parseSubagentOutcome(report || roundText);
      if (handBack.question !== null) {
        return ended("done", { outcome: "blocked", reason: stated?.outcome === "blocked" && stated.reason ? stated.reason : SUBAGENT_BLOCKED_REASONS.needsAnswer });
      }
      if (approvals.length > 0 && stated?.outcome !== "blocked") {
        return ended("done", { outcome: "blocked", reason: SUBAGENT_BLOCKED_REASONS.needsApproval });
      }
      return ended("done", { outcome: stated?.outcome ?? "done", ...(stated?.reason ? { reason: stated.reason } : {}) });
    } catch (error) {
      const ending = endingOf(error, turn, host);
      if (ending.state === "failed") {
        logEvent("run_execution", { code: ending.reason, error, outcome: "failed", run_id: input.hostRunId, stage: "execution" });
      }
      if (input.signal.reason instanceof SubagentTimeEnded && streamed.trim()) {
        report = [SUBAGENT_REPORT_CUT_OFF, report, streamed].filter(Boolean).join("\n\n");
      }
      await context?.close().catch(() => undefined);
      await writer?.flush();
      return ended(ending.state, { reason: ending.reason });
    } finally {
      // What it took but never got on record stays unread, and the thread's next turn in this run reads it instead of skipping it.
      for (const nonce of unrecorded.values()) threadState.readMessages.delete(nonce);
      if (host.browserIdentity) {
        await host.browserIdentity.release({ agent, chatId: host.chatId, modelRunId: input.hostRunId, userId: host.userId })
          .catch(() => undefined);
      }
    }
  }

  async function saveBackgroundResult(input: SubagentTurnInput, signal: AbortSignal,
    result: EndedSubagentCallResult): Promise<EndedSubagentCallResult> {
    if (input.mode !== "background") return result;
    const text = JSON.stringify(result);
    let saved: { handle: string } | { unsavedReason: string } = { unsavedReason: "storage_unavailable" };
    try {
      // The parent's call already returned "started". Its completion needs a producer in the background run,
      // outside the thread's executed steps. Even a short result may exceed a callback's remaining reserve.
      const begun = await host.toolCalls.begin({ arguments: { name: input.name }, chatId: input.chatId, ordinal: 0,
        providerCallId: `subagent-report:${input.turnId}`, roundIndex: 1, runId: input.hostRunId,
        toolName: CALL_SUBAGENT_TOOL_NAME, userId: input.userId });
      if (begun.kind === "running") {
        saved = await host.saveResult({ outcome: "complete", signal, source: "workspace", text, toolCallId: begun.row.id });
        const excerpt = toolOutputExcerpt(text, saved);
        await host.toolCalls.settle({ callId: begun.row.id, runId: input.hostRunId, state: "complete",
          result: { handle: excerpt.handle, output: excerpt.output, truncated: excerpt.truncated } });
      }
    } catch (error) {
      logEvent("service_operation", { action: "degrade", code: "subagent_turn_unsettled", error, outcome: "degraded",
        run_id: input.hostRunId, stage: "write", subsystem: "database" });
    }
    return { ...result, ...("handle" in saved ? { resultHandle: saved.handle } : { resultUnavailableReason: saved.unsavedReason }) };
  }

  function begin(input: SubagentTurnInput, kind: "continue" | "start"): SubagentTurnHandle {
    // A host runs the turns of its own chat and owner: a foreground turn in the parent run, a background one in its own run.
    if (input.chatId !== host.chatId || input.userId !== host.userId) throw new Error("subagent_turn_scope_invalid");
    if (turns.has(input.turnId)) throw new Error("subagent_turn_exists");
    let resolveRecord!: (record: TurnRecord) => void;
    const ready = new Promise<TurnRecord>((resolve) => { resolveRecord = resolve; });
    const promise = ready.then(async (record) => {
      const result = await saveBackgroundResult(input, AbortSignal.any([host.signal, input.signal, record.controller.signal]),
        await endChildren(record, await executeTurn(record)));
      record.result = result;
      await settleRow(input, result);
      return result;
    });
    const record: TurnRecord = { arrivals: new Set(), awaitedChildren: new Set(), calledChildren: false, controller: new AbortController(), input, kind,
      mailbox: [], promise, result: null, stopReason: null };
    turns.set(input.turnId, record);
    resolveRecord(record);
    return { turnId: input.turnId };
  }

  const turnOf = (handle: SubagentTurnHandle) => {
    const turn = turns.get(handle.turnId);
    if (!turn) throw new Error("subagent_turn_missing");
    return turn;
  };

  const runner: HostedSubagentRunner = {
    prepareRoute: routeFor,
    async start(input) {
      return begin(input, "start");
    },
    async continue(input) {
      return begin(input, "continue");
    },
    async wait(handle, signal) {
      const turn = turnOf(handle);
      if (!signal) return turn.promise;
      signal.throwIfAborted();
      return new Promise<EndedSubagentCallResult>((resolve, reject) => {
        const abort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        signal.addEventListener("abort", abort, { once: true });
        turn.promise.then((result) => {
          signal.removeEventListener("abort", abort);
          resolve(result);
        }, (error: unknown) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        });
      });
    },
    async deliver(handle, message): Promise<SubagentDeliveryOutcome> {
      const turn = turns.get(handle.turnId);
      if (!turn) return { kind: "not_found" };
      if (turn.result) return { kind: "ended", result: turn.result };
      reportArrived(turn, message);
      if (!turn.mailbox.some((entry) => entry.nonce === message.nonce)) turn.mailbox.push(message);
      for (const arrived of turn.arrivals) arrived();
      return { kind: "delivered", state: "running" };
    },
    async stop(handle, reason) {
      const turn = turns.get(handle.turnId);
      if (!turn) return null;
      if (!turn.result) {
        turn.stopReason ??= reason;
        turn.controller.abort(new SubagentTurnFailure(reason));
      }
      return turn.promise;
    },
    async stopAll(reason) {
      await Promise.all([...turns.values()].filter((turn) => !turn.result).map(async (turn) => {
        turn.stopReason ??= reason;
        turn.controller.abort(new SubagentTurnFailure(reason));
        await turn.promise.catch(() => undefined);
      }));
    }
  };
  // A foreground child runs here, and the thread Stop, Stop all and other agents' messages reach it like any other.
  const listedRunner = withForegroundTurnStops(runner);
  return runner;
}
