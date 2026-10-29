import {
  SUBAGENT_ERROR_CODES,
  decodeSubagentCallResult,
  normalizeSubagentName,
  type SubagentCallResult
} from "../../../contracts/subagents";
import type {
  SubagentBackgroundControl,
  SubagentBinding,
  SubagentCallerScope,
  SubagentTypeResolver,
  SubagentTypeSnapshot
} from "../../subagents/ports";
import { callSubagentTool, parseCallSubagentArguments, parseStopSubagentArguments, stopSubagentTool } from "../../subagents/tools";
import type { ModelToolCall, ToolExecutionResult } from "../../tools/types";
import type { EngineTool, EngineToolExecution } from "../toolRegistry";
import {
  chooseSubagentModel,
  type FrozenSubagentModels,
  type SubagentModelChoice,
  type SubagentParentModel,
  type SubagentPreviousBinding
} from "./modelCatalog";
import type { HostedSubagentRunner } from "./runner";
import type { SubagentThreadStore, SubagentTurnRecord } from "./threadStore";

/**
 * The main agent's `call_subagent` and `stop_subagent` on the native
 * registry (`lib/server/subagents/tools.ts` declares them). How a call on a
 * name decides follows `SubagentBackgroundControl`'s rules: a new name
 * starts a thread, a visible thread with no active turn continues, a
 * running background turn of this branch takes the message in its mailbox,
 * and anything else is `subagent_busy`. Without the background port (a
 * Telegram turn, a scheduled occurrence, until integration) `background:
 * true` is refused with `subagent_background_unavailable` and the same call
 * without it still works. Every refusal is a visible stable code; nothing is
 * substituted. The result is the sub-agent's own account: untrusted data for
 * the main agent.
 */
export type SubagentCallDeps = Readonly<{
  /** Assistant chats run only the default sub-agent (operator decision 2026-10-29). */
  assistantRun: boolean;
  background?: SubagentBackgroundControl;
  /** The native runs of the branch's answers and this run: where a name's thread is visible. */
  branchRunIds: readonly string[];
  catalog: FrozenSubagentModels | null;
  chatId: string;
  /** When a foreground turn must end: the parent's tool time. */
  deadlineAt(): Date;
  parent: SubagentParentModel;
  runId: string;
  runner: HostedSubagentRunner;
  store: Pick<SubagentThreadStore, "admitForeground" | "ensureThread" | "find" | "result">;
  types?: SubagentTypeResolver;
  /** The user's current message, verbatim: the authority a sub-agent's irreversible website actions need. */
  userMessage: string;
  userId: string;
}>;

const refusal = (call: ModelToolCall, code: string, message: string): ToolExecutionResult =>
  ({ callId: call.id, content: [{ type: "json", value: { error: code, message } }], name: call.name, status: "error" });

const resultOf = (call: ModelToolCall, result: SubagentCallResult): ToolExecutionResult => ({
  callId: call.id,
  content: [{ type: "json", value: result }],
  name: call.name,
  status: result.kind === "ended" && result.state !== "done" ? "error" : "complete"
});

function previousBinding(turn: SubagentTurnRecord | null): SubagentPreviousBinding | null {
  return turn ? { connectionId: turn.provider, effort: turn.reasoningEffort, effortSource: turn.effortSource,
    modelSource: turn.modelSource, providerModelId: turn.providerModelId } : null;
}

export function subagentBinding(choice: SubagentModelChoice, parent: SubagentParentModel): SubagentBinding {
  const entry = choice.entry;
  return {
    effortSource: choice.effortSource,
    modelId: entry?.upstreamModelId ?? parent.upstreamModelId,
    modelSource: choice.modelSource,
    provider: entry?.connectionId ?? parent.connectionId,
    providerModelId: entry?.providerModelId ?? parent.providerModelId,
    reasoningEffort: choice.effort
  };
}

type TypeResolution = Readonly<{ ok: true; type: SubagentTypeSnapshot | null }> | Readonly<{ message: string; ok: false }>;

async function resolveType(deps: SubagentCallDeps, requested: string | undefined,
  thread: Readonly<{ definitionId: string | null; typeName: string | null }> | null): Promise<TypeResolution> {
  const unavailable = (message: string) => ({ message, ok: false as const });
  if (thread) {
    // A thread keeps the type it was started as; another one needs another name.
    if (requested !== undefined && requested !== thread.typeName) {
      return unavailable(`This sub-agent is ${thread.typeName ? `a ${JSON.stringify(thread.typeName)}` : "the default sub-agent"}; start another name for another type.`);
    }
    if (!thread.typeName) return { ok: true, type: null };
    if (deps.assistantRun || !deps.types || !thread.definitionId) {
      return unavailable(`The custom sub-agent ${JSON.stringify(thread.typeName)} is no longer available, so this sub-agent cannot continue; start another name.`);
    }
    const found = await deps.types.resolve({ definitionId: thread.definitionId, userId: deps.userId });
    return found.kind === "found" ? { ok: true, type: found.type }
      : unavailable(`The custom sub-agent ${JSON.stringify(thread.typeName)} is no longer available; start another name.`);
  }
  if (requested === undefined) return { ok: true, type: null };
  if (deps.assistantRun || !deps.types) return unavailable("Custom sub-agents are not available in this chat; omit type.");
  const found = await deps.types.resolve({ name: requested, userId: deps.userId });
  return found.kind === "found" ? { ok: true, type: found.type }
    : unavailable(`${JSON.stringify(requested)} is not one of the user's custom sub-agents; omit type for the default.`);
}

export async function executeCallSubagent(deps: SubagentCallDeps, execution: EngineToolExecution): Promise<ToolExecutionResult> {
  const call = execution.call;
  const parsed = parseCallSubagentArguments(call.arguments);
  if (!parsed.ok) return refusal(call, parsed.code, parsed.message);
  const args = parsed.value;
  const scope: SubagentCallerScope = { chatId: deps.chatId, parentRunId: deps.runId, parentToolCallId: execution.persistedToolCallId,
    userId: deps.userId };
  const lookup = await deps.store.find({ branchRunIds: deps.branchRunIds, chatId: deps.chatId, name: args.name, userId: deps.userId });
  const active = lookup?.active ?? null;
  if (lookup && active) {
    const onBranch = deps.branchRunIds.includes(active.parentRunId);
    if (active.mode === "background" && onBranch && deps.background) {
      if (args.type !== undefined || args.model !== undefined || args.effort !== undefined) {
        return refusal(call, SUBAGENT_ERROR_CODES.busy, "This sub-agent is running with its own model and type; send only message, or start another name.");
      }
      const delivered = await deps.background.deliver({ ...scope, message: { nonce: call.id, origin: "main_agent", text: args.message },
        name: args.name, threadId: lookup.thread.id });
      if (delivered.kind === "delivered") return resultOf(call, { kind: "delivered", name: args.name, state: delivered.state });
      if (delivered.kind === "ended") return resultOf(call, delivered.result);
      return refusal(call, SUBAGENT_ERROR_CODES.notFound, "No sub-agent of that name is running in this conversation.");
    }
    return refusal(call, SUBAGENT_ERROR_CODES.busy, active.parentRunId === deps.runId && active.mode === "foreground"
      ? "This sub-agent is already working on a call of this answer; wait for its result, or start another name."
      : "This sub-agent is running elsewhere in this chat; start another name.");
  }
  if (args.background) {
    const availability = deps.background ? await deps.background.availability(scope) : null;
    if (!availability?.available) {
      return refusal(call, SUBAGENT_ERROR_CODES.backgroundUnavailable,
        "Background sub-agents are not available in this chat; call it again without background to wait for its result.");
    }
  }
  const type = await resolveType(deps, args.type, lookup?.thread ?? null);
  if (!type.ok) return refusal(call, SUBAGENT_ERROR_CODES.typeUnavailable, type.message);
  const chosen = chooseSubagentModel({ call: { ...(args.model !== undefined ? { model: args.model } : {}),
    ...(args.effort !== undefined ? { effort: args.effort } : {}) }, catalog: deps.catalog, parent: deps.parent,
  previous: previousBinding(lookup?.latest ?? null),
  type: type.type ? { providerModelId: type.type.providerModelId, reasoningEffort: type.type.reasoningEffort } : null });
  if (!chosen.ok) {
    // A type whose model is gone is the type's refusal, never another model.
    const code = type.type && args.model === undefined && chosen.code === SUBAGENT_ERROR_CODES.modelUnavailable
      ? SUBAGENT_ERROR_CODES.typeUnavailable : chosen.code;
    return refusal(call, code, chosen.message);
  }
  const binding = subagentBinding(chosen.choice, deps.parent);
  const route = await deps.runner.prepareRoute(binding, execution.signal);
  if (!route.ok) {
    return refusal(call, route.code, route.code === SUBAGENT_ERROR_CODES.effortUnsupported
      ? "That effort is not one this model takes; omit effort or pick another."
      : "That model cannot be used now (its connection or credential is no longer available); omit model or pick another.");
  }
  if (args.background && deps.background) {
    // A new name's thread exists before its background turn is admitted, anchored to this answer like a foreground one.
    const thread = lookup?.thread ?? await deps.store.ensureThread({ branchRunIds: deps.branchRunIds, chatId: deps.chatId,
      definitionId: type.type?.definitionId ?? null, name: args.name, parentRunId: deps.runId, typeName: type.type?.name ?? null,
      userId: deps.userId });
    const started = await deps.background.start({ ...scope, binding, brief: args.message, kind: lookup ? "continue" : "start",
      name: args.name, threadId: thread.id, type: type.type, userMessage: deps.userMessage });
    return started.kind === "started"
      ? resultOf(call, { continued: lookup !== null, kind: "started", name: started.name, state: started.state })
      : refusal(call, started.code, `The sub-agent did not start (${started.code}).`);
  }
  const admitted = await deps.store.admitForeground({ binding, branchRunIds: deps.branchRunIds, chatId: deps.chatId,
    definitionId: type.type?.definitionId ?? null, definitionRevisionId: type.type?.revisionId ?? null, name: args.name,
    parentRunId: deps.runId, parentToolCallId: execution.persistedToolCallId, typeName: type.type?.name ?? lookup?.thread.typeName ?? null,
    userId: deps.userId });
  if (admitted.kind === "refused") {
    return refusal(call, admitted.code, admitted.code === SUBAGENT_ERROR_CODES.limitReached
      ? "20 sub-agents are already running in this chat; wait for one to finish."
      : "This sub-agent is already running; wait for its result, or start another name.");
  }
  const input = { binding, brief: args.message, chatId: deps.chatId, deadlineAt: deps.deadlineAt(), hostRunId: deps.runId,
    mode: "foreground" as const, name: args.name, parentRunId: deps.runId, parentToolCallId: execution.persistedToolCallId,
    signal: execution.signal, threadId: admitted.thread.id, turnId: admitted.turn.id, type: type.type, userId: deps.userId,
    userMessage: deps.userMessage };
  const handle = admitted.continued ? await deps.runner.continue(input) : await deps.runner.start(input);
  return resultOf(call, await deps.runner.wait(handle, execution.signal));
}

export async function executeStopSubagent(deps: SubagentCallDeps, execution: EngineToolExecution): Promise<ToolExecutionResult> {
  const call = execution.call;
  const parsed = parseStopSubagentArguments(call.arguments);
  if (!parsed.ok) return refusal(call, parsed.code, parsed.message);
  const name = parsed.value.name;
  const notFound = () => refusal(call, SUBAGENT_ERROR_CODES.notFound, "No sub-agent of that name is in this conversation.");
  if (deps.background) {
    const stopped = await deps.background.stop({ chatId: deps.chatId, name, parentRunId: deps.runId,
      parentToolCallId: execution.persistedToolCallId, userId: deps.userId });
    return stopped.kind === "stopped" ? resultOf(call, stopped.result) : notFound();
  }
  const lookup = await deps.store.find({ branchRunIds: deps.branchRunIds, chatId: deps.chatId, name, userId: deps.userId });
  if (!lookup) return notFound();
  if (lookup.active) {
    if (lookup.active.parentRunId === deps.runId && lookup.active.mode === "foreground") {
      const result = await deps.runner.stop({ turnId: lookup.active.id }, "stop_subagent");
      if (result) return resultOf(call, result);
    }
    return refusal(call, SUBAGENT_ERROR_CODES.busy, "This sub-agent is running elsewhere in this chat and cannot be stopped from here.");
  }
  const stored = lookup.latest ? decodeSubagentCallResult(await deps.store.result({ chatId: deps.chatId, turnId: lookup.latest.id,
    userId: deps.userId })) : null;
  return stored ? resultOf(call, stored) : notFound();
}

/** The registry entries of the two tools, for the main agent's registry only. */
export function subagentEngineTools(deps: SubagentCallDeps): readonly EngineTool[] {
  // The live step names the sub-agent it addressed (its server name), so the status says whose work runs.
  const activity = (toolName: string) => (call: ModelToolCall) => {
    const name = normalizeSubagentName(call.arguments.name);
    return { origin: "tool" as const, ...(name ? { serverName: name } : {}), toolName };
  };
  return [
    { activity: activity(callSubagentTool.name), definition: callSubagentTool.tool, effects: callSubagentTool.effects,
      observationSource: "workspace", execute: (execution) => executeCallSubagent(deps, execution) },
    { activity: activity(stopSubagentTool.name), definition: stopSubagentTool.tool, effects: stopSubagentTool.effects,
      observationSource: "workspace", execute: (execution) => executeStopSubagent(deps, execution) }
  ];
}

/** The main agent's registry with the sub-agent tools: definitions and resolution, nothing else changed. */
export function withSubagentTools<T extends Readonly<{ definitions(): readonly import("../../tools/types").RunTool[];
  resolve(name: string): EngineTool | undefined }>>(registry: T, tools: readonly EngineTool[]): T {
  const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));
  return {
    ...registry,
    definitions: () => [...registry.definitions(), ...tools.filter((tool) => !registry.resolve(tool.definition.name)).map((tool) => tool.definition)],
    resolve: (name: string) => registry.resolve(name) ?? byName.get(name)
  };
}
