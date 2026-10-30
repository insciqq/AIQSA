import { randomUUID } from "node:crypto";
import {
  SUBAGENT_BLOCKED_REASONS,
  SUBAGENT_END_REASONS,
  SUBAGENT_LIMITS,
  SUBAGENT_USAGE_PURPOSE,
  boundSubagentReport,
  isSubagentCode,
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
  SubagentBinding,
  SubagentDeliveryOutcome,
  SubagentMessage,
  SubagentRunner,
  SubagentStopReason,
  SubagentTurnHandle,
  SubagentTurnInput
} from "../../subagents/ports";
import type { McpApprovalRequest } from "../../mcp/writeApproval";
import { BROWSER_HANDOFF_TOOL_NAME } from "../../tools/browserHandoff";
import type { ModelToolCall, RunTool } from "../../tools/types";
import type { RunSecretSource } from "../../workspace/secrets/runSecrets";
import { engineItemRules } from "../compaction";
import { compactionModelCall } from "../compactionCalls";
import { turnContextItem } from "../conversation";
import { detachedCompactions } from "../detachedCompactions";
import { NO_ENGINE_TEST_FAULTS, type EngineTestFaults } from "../faults";
import { ANSWER_NOW_INSTRUCTION, NO_MORE_TOOLS_OUTPUT, runAgentLoop, type LoopToolChoice } from "../loop";
import { callModel } from "../modelCall";
import { SUBAGENT_ROLE_SECTION, subagentFollowupText, subagentTurnText } from "../prompts";
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
import type { SubagentModelRoute, SubagentRouteResult } from "./modelRoutes";
import { subagentToolRegistry } from "./registry";

/**
 * Foreground sub-agent turns on the native engine's loop (`runAgentLoop`,
 * never a second engine), implementing `SubagentRunner` for the run that
 * hosts them (`lib/server/subagents/ports.ts`). A turn's context is its
 * thread's own items from the branch's earlier runs and this one, then the
 * main agent's brief with the user's current message verbatim (the only
 * authority for irreversible website actions), after its own stable system
 * prompt, the run's context (Skills index, pinned Skills) and the Workspace
 * prompt contract; never the main transcript. Its tools are the run's
 * registry filtered (`registry.ts`), its records carry the thread key, its
 * compaction and gateway lanes are its own, and its model calls are usage
 * of purpose `subagent`. Stop and the deadline (the host's signal) end it;
 * its thread keeps what it recorded.
 */

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
  /** The turn's hard deadline: the parent's tool time ends it first. */
  deadlineAt: number;
  /** Aborted when the parent reached its deadline (rather than Stop). */
  deadlineSignal: AbortSignal;
  faults?: EngineTestFaults;
  /** User text delivered into the parent run: `fetch_url` link authority. */
  followupTexts(): readonly string[];
  maxToolCalls: number | null;
  maxToolRounds: number | null;
  now(): number;
  /** The run's Workspace lifecycle rows (the VM starting or stopping), which the answer shows whoever caused them. */
  onWorkspaceLifecycle(entry: ThreadWorkspaceActivityEntry): Promise<void>;
  /** Records a compaction of a thread that finished after its turn, at a sequence its writer reserved. */
  recordDetachedCompaction(input: Readonly<{ item: TranscriptItem; sequence: number; thread: TranscriptThreadKey }>): Promise<boolean>;
  /** The run's admitted request, which a sub-agent's requests start from (`subagentRequest`). */
  request: ProviderRunRequest;
  /** How a route's requests render and size (`nativeRequestParams`, the replay target). */
  requestShape(route: SubagentModelRoute): Readonly<{ maxOutputTokens: number; params: Record<string, unknown>; target: TranscriptTarget }>;
  /** The model route of a binding: the parent's own, or a frozen model's (`modelRoutes.ts`). */
  route(binding: SubagentBinding, signal?: AbortSignal): Promise<SubagentRouteResult>;
  /** The run's context items (Skills index, pinned Skills): rebuilt per run, never recorded. */
  runContextItems: readonly TranscriptItem[];
  /** Saves a long result for a later read, as the parent does. */
  saveResult: ToolBatchDeps["saveResult"];
  secrets?: RunSecretSource;
  /** Marks the turn as waiting for the user (its browser handoff) or running again; bookkeeping only. */
  setTurnState?(input: Readonly<{ state: "running" | "waiting"; turnId: string }>): Promise<boolean>;
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
 * the sub-agent was not given.
 */
export function subagentRequest(request: ProviderRunRequest, route: SubagentModelRoute): ProviderRunRequest {
  const { personalContext: _personal, ...rest } = request;
  void _personal;
  const recorded = request.prompt.turnGuidance ?? [];
  const split = splitTurnGuidance(request.prompt.system ?? "", recorded);
  const kept = split.turn.filter((part) => part.startsWith(WORKSPACE_TURN_GUIDANCE_PREFIX));
  const system = [split.chat, ...kept].filter((part) => part.trim()).join("\n\n");
  return {
    ...rest,
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
  let serialized: string;
  try {
    serialized = JSON.stringify(call.arguments);
  } catch {
    return null;
  }
  if (serialized.length > SUBAGENT_LIMITS.approvalArgumentsCharacters) return null;
  return {
    arguments: call.arguments,
    reason: approval.guard ? "guard_refused" : "approval_required",
    serverName: boundLine(approval.serverName, SUBAGENT_LIMITS.approvalToolCharacters) || "MCP server",
    toolName: call.name
  };
}

/** While a sub-agent waits in a browser handoff for the user, its turn is `waiting` (an active state), then `running` again. */
function waitingDuringHandoff(registry: ToolRegistry, mark: (state: "running" | "waiting") => Promise<void>): ToolRegistry {
  return {
    ...registry,
    resolve: (name) => {
      const tool = registry.resolve(name);
      if (!tool || name !== BROWSER_HANDOFF_TOOL_NAME) return tool;
      return { ...tool, execute: async (execution) => {
        await mark("waiting");
        try {
          return await tool.execute(execution);
        } finally {
          await mark("running");
        }
      } };
    }
  };
}

/**
 * What one thread keeps across its turns in a host run: the highest round its calls took, the writer whose sequence
 * a later turn continues, and the user's follow-ups it already received.
 */
type ThreadState = {
  deliveredTexts: string[];
  rounds: number;
  seenFollowups: Set<string>;
  writer: TranscriptWriter | null;
};

type TurnRecord = {
  readonly controller: AbortController;
  readonly input: SubagentTurnInput;
  readonly kind: "continue" | "start";
  readonly mailbox: SubagentMessage[];
  readonly promise: Promise<EndedSubagentCallResult>;
  result: EndedSubagentCallResult | null;
  stopReason: SubagentStopReason | null;
};

/** The ended result of a turn, bounded as `decodeSubagentCallResult` accepts it. */
export function endedSubagentCallResult(input: Readonly<{
  approvals: readonly SubagentApprovalRequest[];
  binding: Pick<SubagentBinding, "modelId" | "reasoningEffort">;
  files: readonly string[];
  name: string;
  outcome?: SubagentOutcome;
  reason?: string;
  report: string;
  state: EndedSubagentState;
  steps: readonly SubagentStep[];
}>): EndedSubagentCallResult {
  const report = boundSubagentReport(input.report);
  const steps = input.steps.slice(-SUBAGENT_LIMITS.steps);
  const files = [...new Set(input.files)].filter((path) => path.trim() && path.length <= SUBAGENT_LIMITS.filePathCharacters &&
    !path.includes("\0")).slice(0, SUBAGENT_LIMITS.files);
  const reason = input.reason && isSubagentCode(input.reason) ? input.reason : undefined;
  const outcome = input.state === "done" ? input.outcome ?? "done" : undefined;
  const blockedReason = outcome === "blocked" || input.state === "failed" ? reason ?? "subagent_blocked" : reason;
  return {
    approvals: input.approvals.slice(0, SUBAGENT_LIMITS.approvals),
    files,
    kind: "ended",
    model: { effort: input.binding.reasoningEffort ? input.binding.reasoningEffort.slice(0, SUBAGENT_LIMITS.effortCharacters) : null,
      id: input.binding.modelId.slice(0, SUBAGENT_LIMITS.modelCharacters) },
    name: input.name,
    ...(outcome ? { outcome } : {}),
    ...(blockedReason ? { reason: blockedReason } : {}),
    report: report.report,
    ...(report.truncated ? { reportTruncated: true as const } : {}),
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
      state = { deliveredTexts: [], rounds: 0, seenFollowups: new Set(), writer: null };
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
    const ended = (state: EndedSubagentState, extra: Readonly<{ outcome?: SubagentOutcome; reason?: string }> = {}) =>
      endedSubagentCallResult({ approvals, binding: input.binding, files: [...files], name: input.name, report: report || roundText,
        state, steps, ...extra });
    try {
      const routed = await routeFor(input.binding, signal);
      if (!routed.ok) return ended("failed", { reason: routed.code });
      const route = routed.route;
      const shape = host.requestShape(route);
      const request = { ...subagentRequest(host.request, route), params: shape.params };
      const onWorkspaceActivity = async (entry: ThreadWorkspaceActivityEntry) => {
        if (WORKSPACE_LIFECYCLE_KINDS.has(entry.kind)) await host.onWorkspaceLifecycle(entry);
        if (!WRITTEN_FILE_KINDS.has(entry.kind) || entry.phase !== "succeeded") return;
        for (const change of entry.changes ?? []) if (change.action !== "delete") files.add(change.displayPath);
        const path = entry.file?.targetPath ?? entry.file?.displayPath;
        if (path && entry.kind !== "file_change") files.add(path);
      };
      const registry = waitingDuringHandoff(subagentToolRegistry(await host.buildRegistry({ agent,
        followupTexts: () => [...host.followupTexts(), ...deliveredTexts], onWorkspaceActivity, request }), input.type?.toolGroups ?? null),
      (state) => host.setTurnState?.({ state, turnId: input.turnId }).then(() => undefined, () => undefined) ?? Promise.resolve());
      // A thread's earlier turns may have run in the background, in runs of their own that answer nothing.
      const runIds = [...new Set([...(host.threadRunIds ? await host.threadRunIds(input.threadId) : host.branchRunIds),
        input.hostRunId])];
      const loaded = await host.transcripts.loadRuns({ chatId: host.chatId, runIds, threadId: input.threadId, userId: host.userId });
      const history = runIds.flatMap((runId) => loaded.get(runId) ?? []);
      const role = input.type?.instructions.trim()
        ? `${SUBAGENT_ROLE_SECTION}\n\n# Your instructions\n${input.type.instructions.trim()}` : SUBAGENT_ROLE_SECTION;
      const native = await withNativeSystemPrompt({ now: new Date(host.now()), request, scope: { runId: input.hostRunId, userId: host.userId },
        ...(host.secrets ? { secrets: host.secrets } : {}), selfService: role, snapshot: route.snapshot, tools: registry.definitions() });
      const base = native.request;
      const inputItem: TranscriptUserItem = { id: `sub-${input.turnId}`, kind: "user",
        text: subagentTurnText({ brief: input.brief, continued: turn.kind === "continue", name: input.name, userMessage: input.userMessage }) };
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
          if (message.origin === "user") {
            added.push({ followup: true, id: randomUUID(), kind: "user", text: subagentFollowupText(message.text) });
            deliveredTexts.push(message.text);
            unknownEffects.userSpoke();
          } else {
            // The main agent's message is no user speech: it never releases an unknown effect or authorizes a link.
            added.push({ id: randomUUID(), kind: "user", text: subagentTurnText({ brief: message.text, continued: true, name: input.name,
              userMessage: input.userMessage }) });
          }
        }
        return added;
      };
      // What the user already wrote into this answer (a correction the main agent read before it called) comes with the brief.
      const earlier = await incoming();
      const items: TranscriptItem[] = [...host.runContextItems, ...history, turnContextItem(native.turnContext), inputItem, ...earlier];
      // One sequence per thread for the life of the run: a later turn continues where the last one stopped, and a compaction
      // that finished after its turn reserves from the thread's current writer.
      const activeWriter = createTranscriptWriter({ append: (from, added) => host.transcripts.append(scope, from, added),
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
          if (handed && approvals.length < SUBAGENT_LIMITS.approvals) approvals.push(handed);
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
      const outcome = await runAgentLoop({
        append,
        appendCalls,
        callModel: (request) => sendOnceMore(request, (sent) => callModel({ adapter: route.adapter, deadlineAt: host.deadlineAt,
          faults: host.faults ?? NO_ENGINE_TEST_FAULTS, now: host.now, onDiscard: async () => undefined, onEvent: async () => undefined,
          onUsage: recordUsage, routing: loopRouting, signal, timeoutMs: route.timeoutMs }, sent)),
        closeFollowups: async () => {
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
        toolTimeLeft: host.toolTimeLeft
      });
      await activeContext.afterAnswer();
      await activeWriter.flush();
      if (outcome.kind === "empty" || !(report || roundText).trim()) return ended("failed", { reason: "model_answer_empty" });
      const stated = parseSubagentOutcome(report || roundText);
      if (approvals.length > 0 && stated?.outcome !== "blocked") {
        return ended("done", { outcome: "blocked", reason: SUBAGENT_BLOCKED_REASONS.needsApproval });
      }
      return ended("done", { outcome: stated?.outcome ?? "done", ...(stated?.reason ? { reason: stated.reason } : {}) });
    } catch (error) {
      const ending = endingOf(error, turn, host);
      if (ending.state === "failed") {
        logEvent("run_execution", { code: ending.reason, error, outcome: "failed", run_id: input.hostRunId, stage: "execution" });
      }
      await context?.close().catch(() => undefined);
      await writer?.flush();
      return ended(ending.state, { reason: ending.reason });
    } finally {
      if (host.browserIdentity) {
        await host.browserIdentity.release({ agent, chatId: host.chatId, modelRunId: input.hostRunId, userId: host.userId })
          .catch(() => undefined);
      }
    }
  }

  function begin(input: SubagentTurnInput, kind: "continue" | "start"): SubagentTurnHandle {
    // A host runs the turns of its own chat and owner: a foreground turn in the parent run, a background one in its own run.
    if (input.chatId !== host.chatId || input.userId !== host.userId) throw new Error("subagent_turn_scope_invalid");
    if (turns.has(input.turnId)) throw new Error("subagent_turn_exists");
    let resolveRecord!: (record: TurnRecord) => void;
    const ready = new Promise<TurnRecord>((resolve) => { resolveRecord = resolve; });
    const promise = ready.then(async (record) => {
      const result = await executeTurn(record);
      record.result = result;
      await settleRow(input, result);
      return result;
    });
    const record: TurnRecord = { controller: new AbortController(), input, kind, mailbox: [], promise, result: null, stopReason: null };
    turns.set(input.turnId, record);
    resolveRecord(record);
    return { turnId: input.turnId };
  }

  const turnOf = (handle: SubagentTurnHandle) => {
    const turn = turns.get(handle.turnId);
    if (!turn) throw new Error("subagent_turn_missing");
    return turn;
  };

  return {
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
      if (!turn.mailbox.some((entry) => entry.nonce === message.nonce)) turn.mailbox.push(message);
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
}
