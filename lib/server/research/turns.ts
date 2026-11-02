import { modelWithConnectionLabel } from "../../contracts/providerConnectionLabels";
import { RESEARCH_TASK_LIMITS, RESEARCHER_CONTEXT_CLEARING } from "../../contracts/research";
import { CALL_SUBAGENT_TOOL_NAME, normalizeSubagentName, SUBAGENT_BUILT_IN_TYPE, SUBAGENT_ERROR_CODES, SUBAGENT_LIMITS, SUBAGENT_NAME_PATTERN } from "../../contracts/subagents";
import type { SubagentRouteResult } from "../engine/subagents/modelRoutes";
import { withoutResearchBookkeeping } from "../engine/subagents/registry";
import type { HostedSubagentRunner } from "../engine/subagents/runner";
import { prepareRunSubagents, type PrepareRunSubagentsInput, type RunSubagents } from "../engine/subagents/runSubagents";
import type { SubagentModelEntry } from "../engine/subagents/modelCatalog";
import type { EngineTool, EngineToolExecution } from "../engine/toolRegistry";
import type { RunModelConfiguration } from "../runs/runRepositoryContract";
import { harnessToolError } from "../tools/harnessTool";
import type { SubagentBinding, SubagentStopReason, SubagentTypeSnapshot } from "../subagents/ports";
import type { ResearchSubagentOutcome, ResearchSubagentRequest, ResearchVerifierModel } from "./gates";
import type { FrozenVerifierChoice, ResearchVerifierRole, ResearchVerifierRoute } from "./verifierRole";

/**
 * Sub-agent turns the server starts for a gate: the same runner as any
 * sub-agent's (`createSubagentRunner`, never a second engine) on the run's
 * bindings, stores and ledger, through a host of their own so the
 * administrator's verifier model routes only here. It never reaches the
 * catalog the main agent and its sub-agents choose from: an internal role grants
 * users nothing (`agent_docs/PROVIDERS.md`). A gate's turn has no view of the
 * chat's Skills context, no mailbox and no background children, and counts toward
 * the chat's running sub-agents like any other.
 */
export const RESEARCH_VERIFIER_UNAVAILABLE = "research_verifier_unavailable";
export const RESEARCH_RESEARCHER_UNAVAILABLE = "research_researcher_unavailable";

const GATE_TYPE_ID = "research-gate";

/** Far past any round's own calls: a gate's turn records its own call in the round of the draft it checks. */
const GATE_CALL_FIRST_ORDINAL = 10_000;

/** A thread name of this attempt. Admission looks only among this run's threads, so no earlier research's thread is continued. */
export function researchTurnName(name: string, attempt: number): string {
  const suffix = `-${attempt}`;
  const stem = name.toLowerCase().replace(/[^a-z0-9_-]+/gu, "-").replace(/^[^a-z0-9]+/u, "").slice(0, SUBAGENT_LIMITS.nameCharacters - suffix.length)
    .replace(/[^a-z0-9]+$/u, "");
  const full = `${stem || "check"}${suffix}`;
  return SUBAGENT_NAME_PATTERN.test(full) ? full : `check${suffix}`;
}

/** What a model id says after the route it came through: OpenRouter's variants, then any provider or alias prefix. */
const ROUTING_VARIANT = /:(?:beta|exacto|extended|floor|free|nitro|online|thinking)$/u;

/**
 * One model under provider prefixes and routing aliases is no independent check of itself.
 */
export function researchModelIdentity(id: string): string {
  return (id.trim().toLowerCase().replace(ROUTING_VARIANT, "").split(/[/:]/u).at(-1) ?? "").replaceAll(".", "-");
}

export type ResearchTurnsInput = Readonly<{
  /** What the run gave its own sub-agents (`execution.ts`). */
  subagentInput: PrepareRunSubagentsInput;
  /** The policy as the run froze it when it started. */
  verifierChoice: Promise<FrozenVerifierChoice>;
  verifierRole?: ResearchVerifierRole;
  researcherChoice: Promise<FrozenVerifierChoice>;
  researcherRole?: ResearchVerifierRole;
  userMessage: string;
}>;

export function createResearchTurns(input: ResearchTurnsInput) {
  const base = input.subagentInput;
  const { snapshot, admittedRequest } = base;
  const store = base.engine.subagentThreads;
  const runners = new Map<"main" | "verifier" | "gap_judge" | "researcher", Promise<RunSubagents | null>>();
  let gateCalls = 0;
  const researcherNames = new Set<string>();
  const gateRegistry: PrepareRunSubagentsInput["buildRegistry"] = async (agentInput) => withoutResearchBookkeeping(await base.buildRegistry(agentInput));

  /**
   * One host per kind of turn: the same parts as the run's own sub-agents, without what a gate's turn has no use for. The
   * verifier's is independent whatever model it runs on: none of the chat's or an Assistant's instructions, and none of what
   * the user wrote, which the main agent read too. Link authority stays the answer's (`followupTexts`, the page-reader session).
   */
  const hosted = (kind: "main" | "verifier" | "gap_judge" | "researcher", route: ResearchVerifierRoute | null) => {
    let runner = runners.get(kind);
    if (!runner) {
      const { backgroundParts: _background, ports, ...parts } = base;
      void _background;
      // Image viewing needs the role model's own proof, never the chat model's.
      const { workspaceImageView: _parentView, ...roleRequest } = admittedRequest;
      void _parentView;
      const entry: SubagentModelEntry | null = route ? { connectionId: route.route.snapshot.connectionId,
        ...(route.connectionName ? { connectionName: route.connectionName } : {}), contextWindow: route.route.request.modelCapabilities.contextWindow ?? null,
        defaultEffort: route.route.request.reasoningEffort, displayName: route.displayName, imageInput: false, providerFamily: route.route.snapshot.providerFamily,
        providerModelId: route.route.snapshot.providerModelId, reasoningEfforts: route.route.request.reasoningEffort ? [route.route.request.reasoningEffort] : [],
        upstreamModelId: route.route.snapshot.model.upstreamModelId } : null;
      const independent = kind === "verifier";
      const researcher = kind === "researcher";
      const types = ports?.types;
      // The installation role owns model and effort, including when a custom type or an earlier turn chose its own.
      const researcherStore = researcher && store ? { ...store, admitForeground: async (scope: Parameters<typeof store.admitForeground>[0]) => {
        const admitted = await store.admitForeground(scope);
        if (admitted.kind === "admitted") researcherNames.add(scope.name);
        return admitted;
      }, find: async (scope: Parameters<typeof store.find>[0]) => {
        const found = await store.find(scope);
        return found ? { ...found, latest: found.latest ? { ...found.latest, modelSource: "parent" as const, effortSource: "parent" as const } : null } : null;
      } } : store;
      runner = prepareRunSubagents({ ...parts,
        // Every kind but a researcher is a gate's turn, whatever groups its request names.
        ...researcher ? {} : { buildRegistry: gateRegistry },
        // Read at each use, not frozen by the spread: a research run's turn ends later once its plan is released.
        get deadlineAt() { return base.deadlineAt; },
        ...(route ? { adapter: route.route.adapter, answerTimeoutMs: route.route.timeoutMs,
          modelConfiguration: route.route.snapshot.model as RunModelConfiguration, snapshot: route.route.snapshot } : {}),
        admittedRequest: { ...route ? roleRequest : admittedRequest, subagentModels: { models: entry ? [entry] : [], version: 1 },
          ...(route ? route.route.request : {}),
          ...independent ? { prompt: { ...admittedRequest.prompt.baseline ? { baseline: admittedRequest.prompt.baseline } : {}, developer: null, system: null } } : {} },
        ...independent ? { userFollowups: async () => [] } : {},
        backgroundAllowed: false,
        // No turn the server routes starts children: a researcher's ran for minutes, recorded nothing and its parent redid the work.
        childrenAllowed: false,
        engine: { ...base.engine, ...(researcherStore ? { subagentThreads: researcherStore } : {}),
          subagentModels: { route: async (): Promise<SubagentRouteResult> => route ? { ok: true, route: route.route }
          : { code: SUBAGENT_ERROR_CODES.modelUnavailable, ok: false } } },
        ...(researcher ? { ports: { ...ports, ...(types ? { types: { ...types, resolve: async (scope: Parameters<typeof types.resolve>[0]) => {
          // With no role a researcher is the built-in sub-agent (`researcherCall`), and no custom type is one, a legacy "built-in" included.
          if (!route) return { kind: "unavailable" as const };
          const resolved = await types.resolve(scope);
          return resolved.kind === "found" ? { ...resolved, type: { ...resolved.type, providerModelId: null, reasoningEffort: null } } : resolved;
        } } } : {}) } } : ports?.browserIdentity ? { ports: { browserIdentity: ports.browserIdentity } } : {}),
        // A researcher's old pages leave its context past a mark, and each of its turns is a short task with its own budget, on a role or
        // not; a gate's turn reads what it was given, and its calls are the server's check.
        ...researcher ? { resultClearing: RESEARCHER_CONTEXT_CLEARING, turnToolCalls: RESEARCH_TASK_LIMITS.toolCalls } : {},
        runContextItems: researcher ? base.runContextItems : [],
        // A gate is the server's check and its calls are not the model's budget to spend.
        toolState: researcher ? base.toolState : { calls: 0 } });
      runners.set(kind, runner);
    }
    return runner;
  };

  /** A route or a refusal holds for the run; a failure to resolve one holds for no one, so the next attempt asks again. */
  const frozenRoute = (frozen: Promise<FrozenVerifierChoice>, role: ResearchVerifierRole | undefined) => {
    let resolved: Promise<ResearchVerifierRoute | "main" | null> | null = null;
    return async () => {
      resolved ??= (async () => {
        const choice = await frozen;
        if (choice.kind === "not_set") return "main" as const;
        if (choice.kind !== "set" || !role) return null;
        return role.route({ effort: choice.effort, providerModelId: choice.providerModelId, runId: base.runId, userId: base.scope.userId });
      })();
      try {
        return await resolved;
      } catch (error) {
        resolved = null;
        throw error;
      }
    };
  };
  const verifierRoute = frozenRoute(input.verifierChoice, input.verifierRole);
  const researcherRoute = frozenRoute(input.researcherChoice, input.researcherRole);

  const mainBinding = (): SubagentBinding => ({ effortSource: "parent", modelId: snapshot.model.upstreamModelId, modelSource: "parent",
    provider: snapshot.connectionId, providerModelId: snapshot.providerModelId, reasoningEffort: admittedRequest.reasoningEffort ?? null });

  const startRefusal = async (): Promise<Readonly<{ code: string; message: string }> | null> => {
    for (const [route, code, label] of [[researcherRoute, RESEARCH_RESEARCHER_UNAVAILABLE, "researchers"],
      [verifierRoute, RESEARCH_VERIFIER_UNAVAILABLE, "research checks"]] as const) {
      if (await route().catch(() => null) === null) return { code, message: `Research could not start: the model assigned to ${label} is unavailable. ` +
        "Tell the user. An administrator must check its model, connection, default key and reasoning effort in Defaults & roles." };
    }
    return null;
  };

  /** A message to a background sub-agent already running on the branch goes to its mailbox as in any run: it starts no researcher. */
  const toRunningBackground = async (execution: EngineToolExecution): Promise<boolean> => {
    const name = normalizeSubagentName(execution.call.arguments.name);
    if (!store || name === null) return false;
    const found = await store.find({ branchRunIds: [...base.branchRunIds, base.runId], chatId: base.chatId, name, userId: base.scope.userId });
    return found?.active?.mode === "background";
  };

  return {
    startRefusal,
    runningInBackground: toRunningBackground,
    async researcherCall(tool: EngineTool, execution: EngineToolExecution) {
      if (execution.call.name !== CALL_SUBAGENT_TOOL_NAME && !researcherNames.has(normalizeSubagentName(execution.call.arguments.name) ?? "")) return tool.execute(execution);
      // The research wrapper sends these the ordinary way before its gating (`run.ts`); this holds for any other caller.
      if (execution.call.name === CALL_SUBAGENT_TOOL_NAME && await toRunningBackground(execution)) return tool.execute(execution);
      const refused = await startRefusal();
      if (refused) return harnessToolError(execution.call, refused.code, refused.message);
      const route = await researcherRoute();
      if (!route) return harnessToolError(execution.call, RESEARCH_RESEARCHER_UNAVAILABLE, "The assigned researcher model is unavailable; nothing started. Tell the user.");
      // Not set, the role runs on the chat's model: the same host, with no role model to route to.
      const onRole = route === "main" ? null : route;
      const prepared = await hosted("researcher", onRole);
      const call = prepared?.tools.find((entry) => entry.definition.name === execution.call.name);
      if (!call) return harnessToolError(execution.call, "subagent_unavailable", "Research sub-agents are unavailable; nothing started.");
      if (execution.call.name !== CALL_SUBAGENT_TOOL_NAME) return call.execute(execution);
      const { model: _model, effort: _effort, ...args } = execution.call.arguments;
      void _model;
      void _effort;
      // With no role, the built-in sub-agent on the chat's frozen model and effort, whatever the user's default or the call names:
      // the method's brief is a researcher's instructions, and a custom type's model is no researcher's to choose.
      if (!onRole) return call.execute({ ...execution, call: { ...execution.call, arguments: { ...args, type: SUBAGENT_BUILT_IN_TYPE } } });
      return call.execute({ ...execution, call: { ...execution.call, arguments: { ...args,
        model: onRole.route.snapshot.providerModelId, ...(onRole.route.request.reasoningEffort ? { effort: onRole.route.request.reasoningEffort } : {}) } } });
    },
    async verifierModel(): Promise<ResearchVerifierModel> {
      const route = await verifierRoute();
      if (route === null) return { kind: "unavailable" };
      if (route === "main") return { kind: "main_model", label: admittedRequest.modelId };
      const label = modelWithConnectionLabel(route.displayName, route.connectionName);
      // The role names the model that wrote the report, here or over another connection: no one independent checks it.
      const { snapshot: chosen } = route.route;
      const same = chosen.providerModelId === snapshot.providerModelId || researchModelIdentity(chosen.model.upstreamModelId) === researchModelIdentity(snapshot.model.upstreamModelId);
      return { kind: same ? "main_model" : "role", label };
    },
    async run(request: ResearchSubagentRequest, turn: Readonly<{ attempt: number; round: number; signal: AbortSignal }>): Promise<ResearchSubagentOutcome> {
      if (!store) return { code: "subagent_unavailable", kind: "refused" };
      const route = request.model === "verifier" ? await verifierRoute() : "main";
      if (route === null) return { code: RESEARCH_VERIFIER_UNAVAILABLE, kind: "refused" };
      const onRole = route !== "main";
      const binding: SubagentBinding = onRole ? { effortSource: "call", modelId: route.route.snapshot.model.upstreamModelId, modelSource: "call",
        provider: route.route.snapshot.connectionId, providerModelId: route.route.snapshot.providerModelId, reasoningEffort: route.route.request.reasoningEffort } : mainBinding();
      // The gap judge needs the user's constraints and follow-ups; choosing the checks model does not make it a blind verifier.
      const kind = request.name === "gap-judge" ? "gap_judge" : request.model;
      const prepared = await hosted(kind, onRole ? route : null);
      if (!prepared) return { code: "subagent_unavailable", kind: "refused" };
      const name = researchTurnName(request.name, turn.attempt);
      // A call has one turn (`SubagentTurn`'s unique parent call), and one draft may go through several gates' turns, so each
      // records its own call: the answer's steps and the thread's brief read it as any sub-agent's. It enters no conversation.
      const ordinal = GATE_CALL_FIRST_ORDINAL + gateCalls;
      gateCalls += 1;
      const begun = await base.engine.toolCalls.begin({ arguments: { message: request.brief, name }, chatId: base.chatId, ordinal,
        providerCallId: `research_gate_${ordinal}`, roundIndex: turn.round, runId: base.runId, toolName: CALL_SUBAGENT_TOOL_NAME, userId: base.scope.userId });
      if (begun.kind !== "running") return { code: "subagent_unavailable", kind: "refused" };
      const parentToolCallId = begun.row.id;
      const settle = async (state: "complete" | "error") => {
        await base.engine.toolCalls.settle({ callId: parentToolCallId, result: { name: CALL_SUBAGENT_TOOL_NAME, status: state }, runId: base.runId, state }).catch(() => false);
      };
      // Only this run's threads: an earlier answer's research has threads of these names, and continuing one would hand it that context.
      const admitted = await store.admitForeground({ binding, branchRunIds: [base.runId], chatId: base.chatId, definitionId: null, definitionRevisionId: null, name,
        parentRunId: base.runId, parentToolCallId, typeName: null, userId: base.scope.userId });
      if (admitted.kind === "refused") {
        await settle("error");
        return { code: admitted.code, kind: "refused" };
      }
      // Only its tools and instructions are read: nothing of this type is stored (`definitionId` above).
      const type: SubagentTypeSnapshot = { definitionId: GATE_TYPE_ID, description: "", instructions: request.instructions, name: GATE_TYPE_ID,
        providerModelId: binding.providerModelId, reasoningEffort: binding.reasoningEffort, revisionId: GATE_TYPE_ID, toolGroups: request.tools };
      const runner: HostedSubagentRunner = prepared.runner;
      const started = { binding, brief: request.brief, chatId: base.chatId, deadlineAt: new Date(base.deadlineAt), hostRunId: base.runId, mode: "foreground" as const,
        name, parentRunId: base.runId, parentToolCallId, signal: turn.signal, threadId: admitted.thread.id, turnId: admitted.turn.id,
        type, userId: base.scope.userId, userMessage: kind === "verifier" ? "" : input.userMessage };
      try {
        const handle = admitted.continued ? await runner.continue(started) : await runner.start(started);
        const result = await runner.wait(handle, turn.signal);
        await settle("complete");
        return { kind: "ended", result };
      } catch (error) {
        await settle("error");
        throw error;
      }
    },
    /** Ends what a gate started; resolves once its turns ended. */
    async stopAll(reason: SubagentStopReason): Promise<void> {
      await Promise.all([...runners.values()].map(async (runner) => (await runner.catch(() => null))?.runner.stopAll(reason)));
    }
  };
}
