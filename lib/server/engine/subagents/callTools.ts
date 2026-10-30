import {
  SUBAGENT_BUILT_IN_TYPE,
  SUBAGENT_ERROR_CODES,
  decodeSubagentCallResult,
  normalizeSubagentName,
  type SubagentCallResult
} from "../../../contracts/subagents";
import { logEvent } from "../../observability";
import type {
  SubagentBackgroundControl,
  SubagentBinding,
  SubagentCallerScope,
  SubagentTypeResolver,
  SubagentTypeSnapshot
} from "../../subagents/ports";
import { callSubagentTool, parseCallSubagentArguments, parseStopSubagentArguments, stopSubagentTool } from "../../subagents/tools";
import type { FrozenSubagentDefault } from "../../subagents/typeCatalog";
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
 *
 * Which sub-agent a call starts (operator decisions 2026-10-30): a thread keeps
 * the type it started with, whatever the default is now. A new thread takes its
 * `type`, or `built-in` for the built-in sub-agent; with no `type`, the custom
 * sub-agent of its very name, else the default admission froze, else the
 * built-in. A `type` that matches nothing and a default that cannot run refuse,
 * and the refusal sends the model to the right name or to the user, because a
 * model told to drop `type` quietly runs another sub-agent than the one asked for.
 */
export type SubagentCallDeps = Readonly<{
  background?: SubagentBackgroundControl;
  /**
   * Whether this run may start background turns: web chats only. A Telegram turn or a scheduled occurrence is refused
   * here, before the port's own check, which only backs it up (a Telegram turn's link is written after its send).
   */
  backgroundAllowed: boolean;
  /** The native runs of the branch's answers and this run: where a name's thread is visible. */
  branchRunIds: readonly string[];
  catalog: FrozenSubagentModels | null;
  chatId: string;
  /** When a foreground turn must end: the parent's tool time. */
  deadlineAt(): Date;
  /** The user's default sub-agent as admission froze it; null: none set. */
  defaultType: FrozenSubagentDefault | null;
  parent: SubagentParentModel;
  runId: string;
  runner: HostedSubagentRunner;
  store: Pick<SubagentThreadStore, "admitForeground" | "endOrphanedTurns" | "ensureThread" | "find" | "result">;
  types?: SubagentTypeResolver;
  /** The user's current message, verbatim: the authority a sub-agent's irreversible website actions need. */
  userMessage: string;
  userId: string;
}>;

/** A thrown error's own stable code, if it carries one. */
function errorCode(error: unknown): string | undefined {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
}

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

/** `fromDefault`: the type came from the user's default, which its refusals name as such. */
type TypeResolution = Readonly<{ fromDefault?: true; ok: true; type: SubagentTypeSnapshot | null }> | Readonly<{ message: string; ok: false }>;

const unavailable = (message: string) => ({ message, ok: false as const });

const TYPE_NAMES_LISTED = 50;

/** The user's custom sub-agents as a refusal names them, so the next call can be exact. */
async function customNamesLine(deps: SubagentCallDeps): Promise<string> {
  const names = await deps.types?.catalog({ userId: deps.userId }).then((entries) => entries.map((entry) => entry.name), () => null);
  if (names === null || names === undefined) return "Their list could not be read right now.";
  if (names.length === 0) return "The user has no custom sub-agents.";
  const listed = names.slice(0, TYPE_NAMES_LISTED).map((name) => JSON.stringify(name)).join(", ");
  return `Their custom sub-agents: ${listed}${names.length > TYPE_NAMES_LISTED ? ` and ${names.length - TYPE_NAMES_LISTED} more` : ""}.`;
}

/** Why a named type does not start. Never "omit type": that would quietly run another sub-agent than the one asked for. */
async function unknownTypeMessage(deps: SubagentCallDeps, requested: string): Promise<string> {
  return `${JSON.stringify(requested)} is not one of the user's custom sub-agents. ${await customNamesLine(deps)} ` +
    "Call again with the exact name of the one the user means, or tell the user it does not exist. " +
    "Do not drop type: that would start another sub-agent than the one asked for.";
}

async function resolveNewThreadType(deps: SubagentCallDeps, requested: string | undefined, name: string): Promise<TypeResolution> {
  const types = deps.types;
  // A thread named `built-in` with no type means what `type: "built-in"` means.
  const named = requested ?? (name === SUBAGENT_BUILT_IN_TYPE ? SUBAGENT_BUILT_IN_TYPE : undefined);
  if (named === SUBAGENT_BUILT_IN_TYPE) {
    // A definition saved under the reserved name before it was reserved keeps it: the value is ambiguous, and neither reading is guessed.
    const legacy = await types?.resolve({ name: named, userId: deps.userId });
    return legacy?.kind === "found"
      ? unavailable(`The user has a custom sub-agent named ${JSON.stringify(named)}, so this value is ambiguous and nothing started. ` +
        "Tell the user; renaming it in Studio > Sub-agents frees the name.")
      : { ok: true, type: null };
  }
  if (named !== undefined) {
    if (!types) return unavailable("Custom sub-agents are not available in this chat, so nothing started. Tell the user.");
    const found = await types.resolve({ name: named, userId: deps.userId });
    return found.kind === "found" ? { ok: true, type: found.type } : unavailable(await unknownTypeMessage(deps, named));
  }
  // With no type, a custom sub-agent of this very name: the model named it, in the wrong argument.
  const sameName = await types?.resolve({ name, userId: deps.userId });
  if (sameName?.kind === "found") return { ok: true, type: sameName.type };
  const frozen = deps.defaultType;
  if (!frozen) return { ok: true, type: null };
  if ("unreadable" in frozen) {
    return unavailable("The user's default sub-agent could not be read for this answer, so nothing started. Tell the user, or pass the type they ask for.");
  }
  const found = await types?.resolve({ definitionId: frozen.definitionId, userId: deps.userId });
  return found?.kind === "found" ? { fromDefault: true, ok: true, type: found.type }
    : unavailable(`The user's default sub-agent ${JSON.stringify(frozen.name)} is no longer available, so nothing started. ` +
      "Tell the user; they can choose another in Studio > Sub-agents. Do not start another sub-agent in its place unless they ask.");
}

async function resolveType(deps: SubagentCallDeps, requested: string | undefined, name: string,
  thread: Readonly<{ definitionId: string | null; typeName: string | null }> | null): Promise<TypeResolution> {
  try {
    if (!thread) return await resolveNewThreadType(deps, requested, name);
    // A thread keeps the type it was started as, whatever the default is now; another one needs another name.
    const sameType = requested === undefined || requested === thread.typeName || (!thread.typeName && requested === SUBAGENT_BUILT_IN_TYPE);
    if (!sameType) {
      return unavailable(`This sub-agent is ${thread.typeName ? `a ${JSON.stringify(thread.typeName)}` : "the built-in sub-agent"}; start another name for another type.`);
    }
    if (!thread.typeName) return { ok: true, type: null };
    const found = deps.types && thread.definitionId
      ? await deps.types.resolve({ definitionId: thread.definitionId, userId: deps.userId }) : null;
    return found?.kind === "found" ? { ok: true, type: found.type }
      : unavailable(`The custom sub-agent ${JSON.stringify(thread.typeName)} is no longer available, so this sub-agent cannot continue. ` +
        "Tell the user; do not start another sub-agent in its place unless they ask.");
  } catch (error) {
    // Nothing started, so this is a refusal and never an unknown effect of the call.
    logEvent("service_operation", { action: "degrade", code: "subagent_types_unreadable", error, outcome: "degraded", run_id: deps.runId,
      stage: "read", subsystem: "database" });
    return unavailable("The user's custom sub-agents could not be read right now, so nothing started. Tell the user.");
  }
}

const typeWho = (resolved: Extract<TypeResolution, { ok: true }>) =>
  `${resolved.fromDefault ? "The user's default sub-agent" : "The custom sub-agent"} ${JSON.stringify(resolved.type?.name)}`;

/** What the type itself asks for cannot run: the model tells the user, and never reaches for another model or sub-agent. */
function typeModelGoneMessage(resolved: Extract<TypeResolution, { ok: true }>, deps: Pick<SubagentCallDeps, "catalog">): string {
  if (deps.catalog === null) return `${typeWho(resolved)} could not start, because this answer could not read the user's models. ` +
    "Tell the user to try again in a new message. Do not start another sub-agent or model in its place unless they ask.";
  return `${typeWho(resolved)} runs on a model that is not available in this chat, so nothing started. ` +
    "Tell the user; they can choose another model in Studio > Sub-agents. Do not start another sub-agent or model in its place unless they ask.";
}

export async function executeCallSubagent(deps: SubagentCallDeps, execution: EngineToolExecution): Promise<ToolExecutionResult> {
  const call = execution.call;
  const parsed = parseCallSubagentArguments(call.arguments);
  if (!parsed.ok) {
    return refusal(call, parsed.code, parsed.code === SUBAGENT_ERROR_CODES.typeUnavailable
      ? `${parsed.message} ${await customNamesLine(deps)}` : parsed.message);
  }
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
      let delivered: Awaited<ReturnType<SubagentBackgroundControl["deliver"]>>;
      try {
        delivered = await deps.background.deliver({ ...scope, message: { nonce: call.id, origin: "main_agent", text: args.message },
          name: args.name, threadId: lookup.thread.id });
      } catch (error) {
        // A mailbox at its bound (`SubagentMailboxFullError`) refuses the message visibly; nothing was delivered.
        if (errorCode(error) !== SUBAGENT_ERROR_CODES.messageInvalid) throw error;
        return refusal(call, SUBAGENT_ERROR_CODES.messageInvalid,
          "This sub-agent has too many unread messages; wait for its result before writing again.");
      }
      if (delivered.kind === "delivered") return resultOf(call, { kind: "delivered", name: args.name, state: delivered.state });
      if (delivered.kind === "ended") return resultOf(call, delivered.result);
      return refusal(call, SUBAGENT_ERROR_CODES.notFound, "No sub-agent of that name is running in this conversation.");
    }
    return refusal(call, SUBAGENT_ERROR_CODES.busy, active.parentRunId === deps.runId && active.mode === "foreground"
      ? "This sub-agent is already working on a call of this answer; wait for its result, or start another name."
      : "This sub-agent is running elsewhere in this chat; start another name.");
  }
  if (args.background) {
    const availability = deps.background && deps.backgroundAllowed ? await deps.background.availability(scope) : null;
    if (!availability?.available) {
      return refusal(call, SUBAGENT_ERROR_CODES.backgroundUnavailable,
        "Background sub-agents are not available in this chat; call it again without background to wait for its result.");
    }
  }
  const type = await resolveType(deps, args.type, args.name, lookup?.thread ?? null);
  if (!type.ok) return refusal(call, SUBAGENT_ERROR_CODES.typeUnavailable, type.message);
  const chosen = chooseSubagentModel({ call: { ...(args.model !== undefined ? { model: args.model } : {}),
    ...(args.effort !== undefined ? { effort: args.effort } : {}) }, catalog: deps.catalog, parent: deps.parent,
  previous: previousBinding(lookup?.latest ?? null),
  type: type.type ? { providerModelId: type.type.providerModelId, reasoningEffort: type.type.reasoningEffort } : null });
  if (!chosen.ok) {
    // A type whose model is gone is the type's refusal, never another model.
    if (type.type && args.model === undefined && chosen.code === SUBAGENT_ERROR_CODES.modelUnavailable) {
      return refusal(call, SUBAGENT_ERROR_CODES.typeUnavailable, type.type.providerModelId ? typeModelGoneMessage(type, deps) : chosen.message);
    }
    // The type's own effort: omitting effort, as the general refusal says, would only meet it again.
    if (type.type?.reasoningEffort && args.effort === undefined && chosen.code === SUBAGENT_ERROR_CODES.effortUnsupported) {
      return refusal(call, chosen.code, `${typeWho(type)} asks for the reasoning effort ${JSON.stringify(type.type.reasoningEffort)}, which this model does not take, ` +
        "so nothing started. Pass an effort the model supports, or tell the user.");
    }
    return refusal(call, chosen.code, chosen.message);
  }
  const binding = subagentBinding(chosen.choice, deps.parent);
  const route = await deps.runner.prepareRoute(binding, execution.signal);
  if (!route.ok) {
    if (route.code === SUBAGENT_ERROR_CODES.modelUnavailable && binding.modelSource === "type") {
      return refusal(call, SUBAGENT_ERROR_CODES.typeUnavailable, typeModelGoneMessage(type, deps));
    }
    return refusal(call, route.code, route.code === SUBAGENT_ERROR_CODES.effortUnsupported
      ? "That effort is not one this model takes; pick another or tell the user."
      : "That model cannot be used now (its connection or credential is no longer available). Pick another only if the user asked for none in particular; otherwise tell them.");
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
  const lookup = await deps.store.find({ branchRunIds: deps.branchRunIds, chatId: deps.chatId, name, userId: deps.userId });
  // A foreground turn of this answer runs here, not in the background control, which cannot stop it.
  const ownForeground = lookup?.active && lookup.active.parentRunId === deps.runId && lookup.active.mode === "foreground";
  if (deps.background && !ownForeground) {
    const stopped = await deps.background.stop({ chatId: deps.chatId, name, parentRunId: deps.runId,
      parentToolCallId: execution.persistedToolCallId, userId: deps.userId });
    return stopped.kind === "stopped" ? resultOf(call, stopped.result) : notFound();
  }
  if (!lookup) return notFound();
  if (lookup.active) {
    if (lookup.active.parentRunId === deps.runId && lookup.active.mode === "foreground") {
      const result = await deps.runner.stop({ turnId: lookup.active.id }, "stop_subagent");
      if (result) return resultOf(call, result);
    }
    return refusal(call, SUBAGENT_ERROR_CODES.busy, "This sub-agent is running elsewhere in this chat and cannot be stopped from here.");
  }
  const latest = lookup.latest;
  if (!latest) return notFound();
  const read = async () => decodeSubagentCallResult(await deps.store.result({ chatId: deps.chatId, turnId: latest.id, userId: deps.userId }));
  let stored = await read();
  // A turn a restart left behind (its parent ended) ends as interrupted now, and that is how it ended.
  if (!stored && await deps.store.endOrphanedTurns({ chatId: deps.chatId, userId: deps.userId }) > 0) stored = await read();
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
