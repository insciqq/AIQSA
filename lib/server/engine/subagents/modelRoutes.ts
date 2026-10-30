import type { ModelRunStatus, PrismaClient } from "@prisma/client";
import { SUBAGENT_ERROR_CODES } from "../../../contracts/subagents";
import { parameterControlsForModel, type CatalogAdapterKind } from "../../../domain/catalog";
import { canonicalizeMaxOutputTokenParams } from "../../../domain/providerParams";
import { resolveAcceptedRunReasoningEffort } from "../../../domain/runParams";
import { logEvent } from "../../observability";
import { loadProviderAdmissionPlan, ProviderAdmissionError, type AdmissionPrisma } from "../../providerRuntime/admission";
import type { ProviderRuntimeResolver } from "../../providerRuntime/runtimeResolver";
import { normalizeProviderExecutionSnapshot, type ProviderExecutionSnapshot } from "../../providers/runtimeFactory";
import type { ProviderAdapter, ProviderModelCapabilities, ProviderRunRequest } from "../../providers/types";
import { json } from "../../runs/prismaRepositoryShared";
import type { RunModelConfiguration } from "../../runs/runRepositoryContract";
import type { SubagentModelEntry } from "./modelCatalog";

/**
 * The execution route of a sub-agent's model: the parent run's own (its
 * adapter, snapshot and request, with an effort a call or type chose), or a
 * model from the run's frozen list (`modelCatalog.ts`), whose snapshot and
 * credential binding are built at the thread's first use through the same
 * admission and runtime resolver as the answer model's, then kept on the run
 * (`ProviderRunBinding`, key `subagent:<connection>:<model>`), so every later
 * turn of the run uses the binding it first resolved. A model that can no
 * longer be admitted (its connection, credential or entitlement is gone) is
 * refused with `subagent_model_unavailable`, never replaced by another.
 */
export type SubagentModelRoute = Readonly<{
  adapter: ProviderAdapter;
  /** The request fields this model sends: its identity, params and capabilities. */
  request: Readonly<Pick<ProviderRunRequest, "modelCapabilities" | "modelId" | "params" | "provider">> &
    Readonly<{ reasoningEffort: string | null }>;
  snapshot: ProviderExecutionSnapshot;
  /** The longest one request of this model may take. */
  timeoutMs: number;
}>;

export type SubagentRouteResult =
  | Readonly<{ ok: true; route: SubagentModelRoute }>
  | Readonly<{ code: typeof SUBAGENT_ERROR_CODES.effortUnsupported | typeof SUBAGENT_ERROR_CODES.modelUnavailable; ok: false }>;

/**
 * Builds the route of a frozen model other than the parent's. Owner: this
 * engine task; the profiles task resolves a type's model through the same
 * port. Implementations recheck the run and its owner.
 */
export interface SubagentModelCatalog {
  route(input: Readonly<{ chatId: string; effort: string | null; entry: SubagentModelEntry;
    /**
     * A background turn's own run, which runs on after its parent `runId` answered: it may only read the binding the
     * parent's call recorded while the parent was active, and only while this run itself is active.
     */
    hostRunId?: string;
    runId: string; signal?: AbortSignal; userId: string }>): Promise<SubagentRouteResult>;
}

/** The parameter dialect a model's params are written in (as `runPreparation.ts` admits them). */
export function subagentParameterDialect(adapterKind: string, providerFamily: string): string {
  if (providerFamily === "deepseek") return "deepseek";
  if (providerFamily === "gemini") return "gemini";
  if (adapterKind === "anthropic_messages") return "anthropic";
  if (adapterKind === "openrouter_chat_completions") return "openrouter";
  if (adapterKind === "fake") return "fake";
  return "openai";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Params with this reasoning effort, in the dialect `resolveAcceptedRunReasoningEffort` reads back. */
export function paramsWithReasoningEffort(dialect: string, params: Readonly<Record<string, unknown>>, effort: string):
  Record<string, unknown> {
  const next: Record<string, unknown> = { ...params };
  if (dialect === "anthropic") {
    delete next.output_config;
    next.outputConfig = { ...(isRecord(params.outputConfig) ? params.outputConfig : {}), effort };
    return next;
  }
  if (dialect === "openrouter") {
    if (typeof params.verbosity === "string") {
      next.verbosity = effort;
      return next;
    }
    const reasoning = isRecord(params.reasoning) ? { ...params.reasoning } : {};
    if (effort === "none") {
      next.reasoning = { ...reasoning, enabled: false };
      delete (next.reasoning as Record<string, unknown>).effort;
      return next;
    }
    delete reasoning.enabled;
    next.reasoning = { ...reasoning, effort };
    return next;
  }
  next.reasoning = { ...(isRecord(params.reasoning) ? params.reasoning : {}), effort };
  return next;
}

export type ModelFacts = Readonly<{ adapterKind: string; capabilities: ProviderModelCapabilities; defaultParams: Record<string, unknown>;
  providerFamily: string; reasoningModePath?: boolean; upstreamModelId: string }>;

function controlsFor(facts: ModelFacts) {
  const dialect = subagentParameterDialect(facts.adapterKind, facts.providerFamily);
  return { controls: parameterControlsForModel({ adapterKind: facts.adapterKind as CatalogAdapterKind, defaultParams: facts.defaultParams,
    modelCapabilities: facts.capabilities, modelId: facts.upstreamModelId, provider: dialect,
    supportsReasoningMode: facts.adapterKind === "openai_responses_native" || facts.reasoningModePath === true }), dialect };
}

/** The efforts a model's reasoning control offers, as its route checks them; empty without one. */
export function modelEffortOptions(facts: ModelFacts): readonly string[] {
  const control = controlsFor(facts).controls.reasoningEffort;
  return control.supported ? [...control.options] : [];
}

/**
 * `params` set to `effort` (null keeps them) when the model's reasoning
 * control offers it and the params read back as exactly that effort; null
 * otherwise, so an effort is never sent in a shape the model would not take.
 */
export function paramsForEffort(facts: ModelFacts, params: Readonly<Record<string, unknown>>, effort: string | null):
  Record<string, unknown> | null {
  if (effort === null) return { ...params };
  const { controls, dialect } = controlsFor(facts);
  if (!controls.reasoningEffort.supported || !(controls.reasoningEffort.options as readonly string[]).includes(effort)) return null;
  const next = paramsWithReasoningEffort(dialect, params, effort);
  const read = resolveAcceptedRunReasoningEffort({ controls, params: next, provider: dialect });
  return read.ok && read.reasoningEffort === effort ? next : null;
}

/** The parent's own route, with an effort a call or a type chose for this turn. */
export function parentSubagentRoute(input: Readonly<{
  adapter: ProviderAdapter;
  effort: string | null;
  modelConfiguration: RunModelConfiguration;
  request: ProviderRunRequest;
  snapshot: ProviderExecutionSnapshot;
  timeoutMs: number;
}>): SubagentRouteResult {
  const admitted = input.request.reasoningEffort ?? null;
  const params = input.effort === admitted ? { ...input.request.params } : paramsForEffort({
    adapterKind: input.modelConfiguration.adapterKind, capabilities: input.modelConfiguration.capabilities,
    defaultParams: input.modelConfiguration.defaultParams, providerFamily: input.snapshot.providerFamily,
    reasoningModePath: Boolean(input.modelConfiguration.reasoningRequestMapping?.modePath),
    upstreamModelId: input.snapshot.model.upstreamModelId
  }, input.request.params, input.effort);
  if (!params) return { code: SUBAGENT_ERROR_CODES.effortUnsupported, ok: false };
  return { ok: true, route: { adapter: input.adapter, request: { modelCapabilities: input.request.modelCapabilities,
    modelId: input.request.modelId, params, provider: input.request.provider, reasoningEffort: input.effort },
  snapshot: input.snapshot, timeoutMs: input.timeoutMs } };
}

export function subagentBindingKey(entry: Pick<SubagentModelEntry, "connectionId" | "providerModelId">): string {
  return `subagent:${entry.connectionId}:${entry.providerModelId}`;
}

type CatalogPrisma = AdmissionPrisma & Pick<PrismaClient, "$transaction" | "modelRun" | "providerRunBinding">;

/**
 * The production catalog. The first use of a model in a run admits its
 * answer role for the run's owner exactly as an answer model is admitted
 * (entitlement, connection, credential, verified tool calling) and records
 * its binding once per run, connection and model; every use, that one and
 * later ones with any effort, derives the route from that stored execution
 * snapshot, and the runtime resolver reads the same binding, so a model's
 * fields and its credential always come from one admission.
 */
export function createPrismaSubagentModelCatalog(input: Readonly<{ prisma: CatalogPrisma; runtime: ProviderRuntimeResolver }>):
  SubagentModelCatalog {
  const unavailable = { code: SUBAGENT_ERROR_CODES.modelUnavailable, ok: false } as const;
  const active = { in: ["queued", "streaming", "in_progress"] as ModelRunStatus[] };
  return {
    async route({ chatId, effort, entry, hostRunId, runId, userId }) {
      try {
        const bindingKey = subagentBindingKey(entry);
        const background = hostRunId !== undefined && hostRunId !== runId;
        // A background turn's own active run, started by this parent's call; the parent itself may have answered.
        const owned = background
          ? await input.prisma.modelRun.findFirst({ select: { id: true }, where: { chatId, id: hostRunId, status: active,
            subagentTurn: { is: { mode: "background", parentRunId: runId } }, userId } })
          : await input.prisma.modelRun.findFirst({ select: { id: true }, where: { id: runId, status: active, userId } });
        if (!owned) return unavailable;
        const stored = () => input.prisma.providerRunBinding.findUnique({ select: { executionSnapshot: true },
          where: { modelRunId_bindingKey: { bindingKey, modelRunId: runId } } });
        let binding = await stored();
        // The parent's call admitted the model before the background turn was (`call_subagent` resolves its route first),
        // so a background run reads that binding and never admits a model of its own.
        if (!binding && background) return unavailable;
        if (!binding) {
          const role = (await loadProviderAdmissionPlan(input.prisma, { providerConnectionId: entry.connectionId,
            providerModelId: entry.providerModelId, requiresClientToolCoexistence: true, searchPlan: { mode: "all_selected", optionIds: [] },
            userId })).answer;
          if (role.modelConfiguration.capabilities.toolCalling !== true) return unavailable;
          const data = { bindingKey, connectionId: role.snapshot.connectionId, credentialId: role.snapshot.credentialId,
            credentialSource: role.credentialSource, credentialVersionId: role.snapshot.credentialVersionId,
            executionSnapshot: json(role.snapshot), modelRunId: runId, providerModelId: role.snapshot.providerModelId, role: "answer" as const };
          const recorded = await input.prisma.$transaction(async (tx) => {
            const run = await tx.modelRun.findFirst({ select: { id: true }, where: { id: runId, status: active, userId } });
            if (!run) return false;
            // Two first uses at once meet the binding's unique key: the one that wrote it wins, the other reads it.
            await tx.providerRunBinding.createMany({ data: [data], skipDuplicates: true });
            return true;
          });
          if (!recorded) return unavailable;
          binding = await stored();
          if (!binding) return unavailable;
        }
        const snapshot = normalizeProviderExecutionSnapshot(binding.executionSnapshot);
        const model = snapshot.model;
        if (model.capabilities.toolCalling !== true) return unavailable;
        const facts: ModelFacts = { adapterKind: model.adapterKind, capabilities: model.capabilities, defaultParams: model.defaultParams,
          providerFamily: snapshot.providerFamily,
          reasoningModePath: "reasoningRequestMapping" in model && Boolean(model.reasoningRequestMapping?.modePath),
          upstreamModelId: model.upstreamModelId };
        const { controls } = controlsFor(facts);
        const base = { ...canonicalizeMaxOutputTokenParams({ ...model.defaultParams }),
          maxOutputTokens: controls.maxOutputTokens.defaultValue,
          ...(controls.temperature.supported ? { temperature: controls.temperature.defaultValue } : {}) };
        const params = paramsForEffort(facts, base, effort);
        if (!params) return { code: SUBAGENT_ERROR_CODES.effortUnsupported, ok: false };
        const runtime = await input.runtime.resolve(runId, "answer", bindingKey);
        return { ok: true, route: { adapter: runtime.adapter, request: { modelCapabilities: model.capabilities,
          modelId: model.upstreamModelId, params, provider: snapshot.providerFamily, reasoningEffort: effort },
        snapshot, timeoutMs: runtime.responseTimeoutMs } };
      } catch (error) {
        if (!(error instanceof ProviderAdmissionError)) {
          logEvent("service_operation", { action: "degrade", code: "subagent_model_unavailable", error, outcome: "degraded",
            run_id: runId, stage: "prepare", subsystem: "database" });
        }
        return unavailable;
      }
    }
  };
}
