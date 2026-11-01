import type { ModelRunStatus, Prisma, PrismaClient } from "@prisma/client";
import type { ResearchRole } from "../../contracts/research";
import { parameterControlsForModel, type CatalogAdapterKind } from "../../domain/catalog";
import { canonicalizeMaxOutputTokenParams } from "../../domain/providerParams";
import { logEvent } from "../observability";
import { loadInstallationAnswerProviderRole, ProviderAdmissionError, type AdmissionPrisma, type ProviderAdmissionRole } from "../providerRuntime/admission";
import type { ProviderRuntimeResolver } from "../providerRuntime/runtimeResolver";
import { SYSTEM_MODEL_ABSENT, SYSTEM_MODEL_UNAVAILABLE, type SystemModelRoleResolution } from "../providerRuntime/systemModelRole";
import { supportsConfiguredReasoningEffort } from "../providers/providerModelCapabilities";
import { normalizeProviderExecutionSnapshot } from "../providers/runtimeFactory";
import { json } from "../runs/prismaRepositoryShared";
import { paramsForEffort, subagentParameterDialect, type ModelFacts, type SubagentModelRoute } from "../engine/subagents/modelRoutes";

/**
 * Research roles are administrator choices on installation credentials. The
 * existing verifier columns hold the checks role so upgrades keep its choice.
 * Not set, the run keeps its ordinary models; set but unusable, nothing runs in
 * its place. A run freezes the choice when it starts, and its first use
 * records the binding on the run, so the run keeps it whatever changes after.
 */
export const RESEARCH_VERIFIER_BINDING_KEY = "research_verifier";
export const RESEARCH_RESEARCHER_BINDING_KEY = "research_researcher";

const ROLE_FIELDS = {
  checks: { bindingKey: RESEARCH_VERIFIER_BINDING_KEY, effort: "researchVerifierReasoningEffort", model: "researchVerifierProviderModelId" },
  researcher: { bindingKey: RESEARCH_RESEARCHER_BINDING_KEY, effort: "researchResearcherReasoningEffort", model: "researchResearcherProviderModelId" }
} as const;

const ROLE_SELECT = { researchResearcherProviderModelId: true, researchResearcherReasoningEffort: true,
  researchVerifierProviderModelId: true, researchVerifierReasoningEffort: true, version: true } as const;

/** Research roles run sub-agent turns, so their models must call tools like any chat model. */
export function researchVerifierEligible(role: Pick<ProviderAdmissionRole, "modelConfiguration">): boolean {
  return role.modelConfiguration.capabilities.toolCalling === true;
}

/** The role's readiness, for the administrator's form (`systemModelPolicyService.ts`). */
export function createResearchVerifierRoleResolver(
  db: AdmissionPrisma & Pick<Prisma.TransactionClient, "systemModelPolicy">,
  loadRole = loadInstallationAnswerProviderRole,
  researchRole: ResearchRole = "checks"
) {
  const fields = ROLE_FIELDS[researchRole];
  return {
    async resolve(): Promise<SystemModelRoleResolution> {
      const policy = await db.systemModelPolicy.findUnique({
        select: ROLE_SELECT,
        where: { id: "installation" }
      });
      const providerModelId = policy?.[fields.model];
      if (!policy || !providerModelId) return { ok: false, code: SYSTEM_MODEL_ABSENT };
      try {
        const role = await loadRole(db, { providerModelId });
        const effort = policy[fields.effort] ?? null;
        if (!researchVerifierEligible(role) || effort !== null &&
          !supportsConfiguredReasoningEffort(role.snapshot.model, role.snapshot.providerFamily, effort)) {
          return { ok: false, code: SYSTEM_MODEL_UNAVAILABLE };
        }
        return { ok: true, credentialScope: "installation", policyVersion: policy.version, providerModelId, reasoningEffort: effort, role };
      } catch (error) {
        if (error instanceof ProviderAdmissionError) return { ok: false, code: SYSTEM_MODEL_UNAVAILABLE };
        throw error;
      }
    }
  };
}

/** What a run froze of the policy when it started. */
export type FrozenVerifierChoice =
  | Readonly<{ kind: "not_set" }>
  | Readonly<{ effort: string | null; kind: "set"; providerModelId: string }>
  /** The policy could not be read, so no one knows what the administrator chose: nothing runs in its place. */
  | Readonly<{ kind: "unreadable" }>;

/** A research model's route on a run, with the facts a sub-agent turn binds. */
export type ResearchVerifierRoute = Readonly<{ connectionName: string | null; displayName: string; route: SubagentModelRoute }>;

/** A research role's port on the engine. */
export type ResearchVerifierRole = Readonly<{
  /** Read when the run starts; a failure reads as `unreadable`, never as not set. */
  frozenChoice(): Promise<FrozenVerifierChoice>;
  /** The route of what the run froze, recording its binding once; null when it can no longer be admitted. Any other failure throws: it may pass. */
  route(input: Readonly<{ effort: string | null; providerModelId: string; runId: string; userId: string }>): Promise<ResearchVerifierRoute | null>;
}>;

type RolePrisma = AdmissionPrisma & Pick<PrismaClient, "$transaction" | "modelRun" | "providerRunBinding" | "systemModelPolicy">;

const ACTIVE = { in: ["queued", "streaming", "in_progress"] as ModelRunStatus[] };

export function createResearchVerifierRole(input: Readonly<{ loadRole?: typeof loadInstallationAnswerProviderRole; prisma: RolePrisma;
  role?: ResearchRole; runtime: ProviderRuntimeResolver }>): ResearchVerifierRole {
  const loadRole = input.loadRole ?? loadInstallationAnswerProviderRole;
  const fields = ROLE_FIELDS[input.role ?? "checks"];
  return {
    async frozenChoice() {
      try {
        const policy = await input.prisma.systemModelPolicy.findUnique({
          select: ROLE_SELECT, where: { id: "installation" } });
        const providerModelId = policy?.[fields.model];
        return providerModelId
          ? { effort: policy?.[fields.effort] ?? null, kind: "set", providerModelId }
          : { kind: "not_set" };
      } catch (error) {
        logEvent("service_operation", { action: "degrade", code: `${fields.bindingKey}_unreadable`, error, outcome: "degraded", stage: "read",
          subsystem: "database" });
        return { kind: "unreadable" };
      }
    },
    async route({ effort, providerModelId, runId, userId }) {
      try {
        const stored = () => input.prisma.providerRunBinding.findUnique({ select: { executionSnapshot: true },
          where: { modelRunId_bindingKey: { bindingKey: fields.bindingKey, modelRunId: runId } } });
        let binding = await stored();
        if (!binding) {
          const role = await loadRole(input.prisma, { providerModelId });
          if (!researchVerifierEligible(role) || effort !== null &&
            !supportsConfiguredReasoningEffort(role.snapshot.model, role.snapshot.providerFamily, effort)) return null;
          const data = { bindingKey: fields.bindingKey, connectionId: role.snapshot.connectionId, credentialId: role.snapshot.credentialId,
            credentialSource: role.credentialSource, credentialVersionId: role.snapshot.credentialVersionId, executionSnapshot: json(role.snapshot),
            modelRunId: runId, providerModelId: role.snapshot.providerModelId, role: "answer" as const };
          const recorded = await input.prisma.$transaction(async (tx) => {
            const run = await tx.modelRun.findFirst({ select: { id: true }, where: { id: runId, status: ACTIVE, userId } });
            if (!run) return false;
            await tx.providerRunBinding.createMany({ data: [data], skipDuplicates: true });
            return true;
          });
          if (!recorded) return null;
          binding = await stored();
          if (!binding) return null;
        }
        const snapshot = normalizeProviderExecutionSnapshot(binding.executionSnapshot);
        const model = snapshot.model;
        const names = await input.prisma.providerModel.findUnique({ select: { connection: { select: { displayName: true } }, displayName: true },
          where: { id: snapshot.providerModelId } });
        const facts: ModelFacts = { adapterKind: model.adapterKind, capabilities: model.capabilities, defaultParams: model.defaultParams,
          providerFamily: snapshot.providerFamily, reasoningModePath: "reasoningRequestMapping" in model && Boolean(model.reasoningRequestMapping?.modePath),
          upstreamModelId: model.upstreamModelId };
        const controls = parameterControlsForModel({ adapterKind: facts.adapterKind as CatalogAdapterKind, defaultParams: facts.defaultParams,
          modelCapabilities: facts.capabilities, modelId: facts.upstreamModelId, provider: subagentParameterDialect(facts.adapterKind, facts.providerFamily),
          supportsReasoningMode: facts.adapterKind === "openai_responses_native" || facts.reasoningModePath === true });
        const params = paramsForEffort(facts, { ...canonicalizeMaxOutputTokenParams({ ...model.defaultParams }),
          maxOutputTokens: controls.maxOutputTokens.defaultValue,
          ...(controls.temperature.supported ? { temperature: controls.temperature.defaultValue } : {}) }, effort);
        if (!params) return null;
        const runtime = await input.runtime.resolve(runId, "answer", fields.bindingKey);
        return { connectionName: names?.connection?.displayName ?? null, displayName: names?.displayName ?? model.upstreamModelId, route: { adapter: runtime.adapter, request: { modelCapabilities: model.capabilities,
          modelId: model.upstreamModelId, params, provider: snapshot.providerFamily, reasoningEffort: effort }, snapshot, timeoutMs: runtime.responseTimeoutMs } };
      } catch (error) {
        if (error instanceof ProviderAdmissionError) return null;
        logEvent("service_operation", { action: "degrade", code: `${fields.bindingKey}_unavailable`, error, outcome: "degraded", run_id: runId,
          stage: "prepare", subsystem: "database" });
        throw error;
      }
    }
  };
}
