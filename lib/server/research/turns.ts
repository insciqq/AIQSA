import { modelWithConnectionLabel } from "../../contracts/providerConnectionLabels";
import { CALL_SUBAGENT_TOOL_NAME, SUBAGENT_ERROR_CODES, SUBAGENT_LIMITS, SUBAGENT_NAME_PATTERN } from "../../contracts/subagents";
import type { SubagentRouteResult } from "../engine/subagents/modelRoutes";
import type { HostedSubagentRunner } from "../engine/subagents/runner";
import { prepareRunSubagents, type PrepareRunSubagentsInput, type RunSubagents } from "../engine/subagents/runSubagents";
import type { SubagentModelEntry } from "../engine/subagents/modelCatalog";
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

const GATE_TYPE_ID = "research-gate";

/** Far past any round's own calls: a gate's turn records its own call in the round of the draft it checks. */
const GATE_CALL_FIRST_ORDINAL = 10_000;

/** A thread name of this run and attempt, so no earlier research's thread is continued and no later reader is anchored on it. */
export function researchTurnName(name: string, runId: string, attempt: number): string {
  const run = runId.replace(/[^a-z0-9]/giu, "").toLowerCase().slice(0, 8) || "run";
  const suffix = `-${run}-${attempt}`;
  const stem = name.toLowerCase().replace(/[^a-z0-9_-]+/gu, "-").replace(/^[^a-z0-9]+/u, "").slice(0, SUBAGENT_LIMITS.nameCharacters - suffix.length)
    .replace(/[^a-z0-9]+$/u, "");
  const full = `${stem || "check"}${suffix}`;
  return SUBAGENT_NAME_PATTERN.test(full) ? full : `check${suffix}`;
}

export type ResearchTurnsInput = Readonly<{
  /** What the run gave its own sub-agents (`execution.ts`). */
  subagentInput: PrepareRunSubagentsInput;
  /** The policy as the run froze it when it started. */
  verifierChoice: Promise<FrozenVerifierChoice>;
  verifierRole?: ResearchVerifierRole;
  userMessage: string;
}>;

export function createResearchTurns(input: ResearchTurnsInput) {
  const base = input.subagentInput;
  const { snapshot, admittedRequest } = base;
  const store = base.engine.subagentThreads;
  const runners = new Map<"main" | "verifier", Promise<RunSubagents | null>>();
  let gateCalls = 0;

  /** One host per model: the same parts as the run's own sub-agents, without what a gate's turn has no use for. */
  const hosted = (kind: "main" | "verifier", route: ResearchVerifierRoute | null) => {
    let runner = runners.get(kind);
    if (!runner) {
      const { backgroundParts: _background, ports, ...parts } = base;
      void _background;
      const entry: SubagentModelEntry | null = route ? { connectionId: route.route.snapshot.connectionId,
        ...(route.connectionName ? { connectionName: route.connectionName } : {}), contextWindow: route.route.request.modelCapabilities.contextWindow ?? null,
        defaultEffort: null, displayName: route.displayName, imageInput: false, providerFamily: route.route.snapshot.providerFamily,
        providerModelId: route.route.snapshot.providerModelId, reasoningEfforts: [], upstreamModelId: route.route.snapshot.model.upstreamModelId } : null;
      runner = prepareRunSubagents({ ...parts,
        admittedRequest: { ...admittedRequest, subagentModels: { models: entry ? [entry] : [], version: 1 } },
        backgroundAllowed: false,
        engine: { ...base.engine, subagentModels: { route: async (): Promise<SubagentRouteResult> => route ? { ok: true, route: route.route }
          : { code: SUBAGENT_ERROR_CODES.modelUnavailable, ok: false } } },
        ...(ports?.browserIdentity ? { ports: { browserIdentity: ports.browserIdentity } } : {}),
        runContextItems: [],
        // A gate is the server's check and its calls are not the model's budget to spend.
        toolState: { calls: 0 } });
      runners.set(kind, runner);
    }
    return runner;
  };

  let resolved: Promise<ResearchVerifierRoute | "main" | null> | null = null;
  const verifierRoute = () => resolved ??= (async () => {
    const choice = await input.verifierChoice;
    if (choice.kind === "not_set") return "main" as const;
    if (choice.kind !== "set" || !input.verifierRole) return null;
    return input.verifierRole.route({ effort: choice.effort, providerModelId: choice.providerModelId, runId: base.runId, userId: base.scope.userId });
  })();

  const mainBinding = (): SubagentBinding => ({ effortSource: "parent", modelId: snapshot.model.upstreamModelId, modelSource: "parent",
    provider: snapshot.connectionId, providerModelId: snapshot.providerModelId, reasoningEffort: admittedRequest.reasoningEffort ?? null });

  return {
    async verifierModel(): Promise<ResearchVerifierModel> {
      const route = await verifierRoute();
      if (route === null) return { kind: "unavailable" };
      if (route === "main") return { kind: "main_model", label: admittedRequest.modelId };
      return { kind: "role", label: modelWithConnectionLabel(route.displayName, route.connectionName) };
    },
    async run(request: ResearchSubagentRequest, turn: Readonly<{ attempt: number; round: number; signal: AbortSignal }>): Promise<ResearchSubagentOutcome> {
      if (!store) return { code: "subagent_unavailable", kind: "refused" };
      const route = request.model === "verifier" ? await verifierRoute() : "main";
      if (route === null) return { code: RESEARCH_VERIFIER_UNAVAILABLE, kind: "refused" };
      const onRole = route !== "main";
      const binding: SubagentBinding = onRole ? { effortSource: "call", modelId: route.route.snapshot.model.upstreamModelId, modelSource: "call",
        provider: route.route.snapshot.connectionId, providerModelId: route.route.snapshot.providerModelId, reasoningEffort: route.route.request.reasoningEffort } : mainBinding();
      const prepared = await hosted(onRole ? "verifier" : "main", onRole ? route : null);
      if (!prepared) return { code: "subagent_unavailable", kind: "refused" };
      const name = researchTurnName(request.name, base.runId, turn.attempt);
      const branchRunIds = [...base.branchRunIds, base.runId];
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
      const admitted = await store.admitForeground({ binding, branchRunIds, chatId: base.chatId, definitionId: null, definitionRevisionId: null, name,
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
        type, userId: base.scope.userId, userMessage: input.userMessage };
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
