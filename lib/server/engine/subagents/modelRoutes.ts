import type { PrismaClient } from "@prisma/client";
import { SUBAGENT_ERROR_CODES } from "../../../contracts/subagents";
import { parameterControlsForModel, type CatalogAdapterKind } from "../../../domain/catalog";
import { canonicalizeMaxOutputTokenParams } from "../../../domain/providerParams";
import { resolveAcceptedRunReasoningEffort } from "../../../domain/runParams";
import { logEvent } from "../../observability";
import { loadProviderAdmissionPlan, ProviderAdmissionError, type AdmissionPrisma } from "../../providerRuntime/admission";
import type { ProviderRuntimeResolver } from "../../providerRuntime/runtimeResolver";
import type { ProviderExecutionSnapshot } from "../../providers/runtimeFactory";
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
  route(input: Readonly<{ chatId: string; effort: string | null; entry: SubagentModelEntry; runId: string; signal?: AbortSignal;
    userId: string }>): Promise<SubagentRouteResult>;
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

type ModelFacts = Readonly<{ adapterKind: string; capabilities: ProviderModelCapabilities; defaultParams: Record<string, unknown>;
  providerFamily: string; reasoningModePath?: boolean; upstreamModelId: string }>;

function controlsFor(facts: ModelFacts) {
  const dialect = subagentParameterDialect(facts.adapterKind, facts.providerFamily);
  return { controls: parameterControlsForModel({ adapterKind: facts.adapterKind as CatalogAdapterKind, defaultParams: facts.defaultParams,
    modelCapabilities: facts.capabilities, modelId: facts.upstreamModelId, provider: dialect,
    supportsReasoningMode: facts.adapterKind === "openai_responses_native" || facts.reasoningModePath === true }), dialect };
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

type CatalogPrisma = AdmissionPrisma & Pick<PrismaClient, "$transaction">;

/**
 * The production catalog: the model's answer role admitted for the run's
 * owner exactly as an answer model is (entitlement, connection, credential,
 * verified tool calling), its binding recorded once on the run, its adapter
 * from the runtime resolver that reads that binding.
 */
export function createPrismaSubagentModelCatalog(input: Readonly<{ prisma: CatalogPrisma; runtime: ProviderRuntimeResolver }>):
  SubagentModelCatalog {
  const unavailable = { code: SUBAGENT_ERROR_CODES.modelUnavailable, ok: false } as const;
  return {
    async route({ effort, entry, runId, userId }) {
      try {
        const plan = await loadProviderAdmissionPlan(input.prisma, { providerConnectionId: entry.connectionId,
          providerModelId: entry.providerModelId, requiresClientToolCoexistence: true, searchPlan: { mode: "all_selected", optionIds: [] },
          userId });
        const role = plan.answer;
        const configuration = role.modelConfiguration;
        if (configuration.capabilities.toolCalling !== true) return unavailable;
        const facts: ModelFacts = { adapterKind: configuration.adapterKind, capabilities: configuration.capabilities,
          defaultParams: configuration.defaultParams, providerFamily: role.snapshot.providerFamily,
          reasoningModePath: Boolean(configuration.reasoningRequestMapping?.modePath), upstreamModelId: role.snapshot.model.upstreamModelId };
        const { controls } = controlsFor(facts);
        const base = { ...canonicalizeMaxOutputTokenParams({ ...configuration.defaultParams }),
          maxOutputTokens: controls.maxOutputTokens.defaultValue,
          ...(controls.temperature.supported ? { temperature: controls.temperature.defaultValue } : {}) };
        const params = paramsForEffort(facts, base, effort);
        if (!params) return { code: SUBAGENT_ERROR_CODES.effortUnsupported, ok: false };
        const bindingKey = subagentBindingKey(entry);
        const recorded = await input.prisma.$transaction(async (tx) => {
          const run = await tx.modelRun.findFirst({ select: { id: true },
            where: { id: runId, status: { in: ["queued", "streaming", "in_progress"] }, userId } });
          if (!run) return false;
          const existing = await tx.providerRunBinding.findUnique({ select: { id: true },
            where: { modelRunId_bindingKey: { bindingKey, modelRunId: runId } } });
          // The run keeps the binding its first use admitted.
          if (existing) return true;
          await tx.providerRunBinding.create({ data: { bindingKey, connectionId: role.snapshot.connectionId,
            credentialId: role.snapshot.credentialId, credentialSource: role.credentialSource,
            credentialVersionId: role.snapshot.credentialVersionId, executionSnapshot: json(role.snapshot), modelRunId: runId,
            providerModelId: role.snapshot.providerModelId, role: "answer" } });
          return true;
        });
        if (!recorded) return unavailable;
        const runtime = await input.runtime.resolve(runId, "answer", bindingKey);
        return { ok: true, route: { adapter: runtime.adapter, request: { modelCapabilities: configuration.capabilities,
          modelId: role.snapshot.model.upstreamModelId, params, provider: role.snapshot.providerFamily, reasoningEffort: effort },
        snapshot: role.snapshot, timeoutMs: runtime.responseTimeoutMs } };
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
