import type { AdminProviderBootstrapResult, AdminProviderConnection } from "../../../contracts/adminProviders";
import { adminSearchExecutionDefaults, type AdminSearchDraft } from "../../../contracts/adminSearch";
import { ADMIN_PROVIDER_QUICK_SETUP_PROVIDERS, type AdminProviderQuickSetupProviderId } from "../../../contracts/adminProviderQuickSetup";
import type { createAdminSearchService } from "../search/service";
import type { createAdminModelPolicyService } from "./modelPolicyService";
import type { createAdminSystemModelPolicyService } from "./systemModelPolicyService";
import { adminProviderQuickSetupPolicy } from "./quickSetupPolicy";
import type { createAdminKnowledgeProfileService } from "../knowledge/profileService";
import { embeddingPresetsForFamily } from "../../../domain/embeddingModels";
import { rerankerPresetsForFamily } from "../../../domain/rerankerModels";
import { DEFAULT_DECISION_FEATURES, JEV_MODEL_ID } from "../../../domain/decisionModels";

/** Finish setup through the ordinary, version-fenced owners. Existing
 * destinations stay operator-owned; an empty Knowledge profile adopts vision. */
export function createAdminProviderBootstrap(input: {
  providers: { listConnections(): Promise<AdminProviderConnection[]> };
  chat: Pick<ReturnType<typeof createAdminModelPolicyService>, "list" | "update">;
  roles: Pick<ReturnType<typeof createAdminSystemModelPolicyService>, "list" | "update" | "updateMemory" | "adoptChatTitle" | "adoptDecisionModel">;
  search: Pick<ReturnType<typeof createAdminSearchService>, "list" | "createDraft" | "saveAndCheck">;
  knowledge: Pick<ReturnType<typeof createAdminKnowledgeProfileService>, "list" | "activate">;
}) {
  return async function complete(value: {
    connectionId: string; credentialId: string; signal: AbortSignal; userId: string;
  }): Promise<AdminProviderBootstrapResult> {
    const result: AdminProviderBootstrapResult = { defaults: [], search: "skipped", state: "completed" };
    value.signal.throwIfAborted();
    const connection = (await input.providers.listConnections()).find(({ id }) => id === value.connectionId);
    if (!connection?.enabled || !connection.activeConfig || connection.defaultCredentialId !== value.credentialId) return result;
    const credential = connection.credentials.find(({ id }) => id === value.credentialId);
    if (!credential?.enabled || !credential.activeVersion || credential.activeVersion.revokedAt) return result;
    const eligible = new Set(connection.models.filter((model) => model.enabled && model.activeConfig &&
      connection.activeChecks.some((check) => check.providerModelId === model.id &&
        check.connectionVersion === connection.activeVersion && check.modelVersion === model.activeVersion &&
        check.credentialId === credential.id && check.credentialVersionId === credential.activeVersion!.id &&
        check.status === "available" && check.evidence?.compatibility?.modelAccess === "verified"))
      .map(({ id }) => id));
    const policy = ADMIN_PROVIDER_QUICK_SETUP_PROVIDERS.includes(connection.family as AdminProviderQuickSetupProviderId)
      ? adminProviderQuickSetupPolicy(connection.family as AdminProviderQuickSetupProviderId) : null;
    const preferred = policy?.candidates.find(({ recommended }) => recommended)?.configuration.upstreamModelId;
    const preferredId = connection.models.find((model) => model.activeConfig?.upstreamModelId === preferred)?.id;
    const pick = <T extends { id: string; connectionId: string }>(models: readonly T[]) => {
      const candidates = models.filter((model) => model.connectionId === connection.id && eligible.has(model.id));
      return candidates.find(({ id }) => id === preferredId) ?? candidates[0];
    };
    // Independent saves can fail independently. Their owners recheck the
    // administrator, version and live deployment inside publication.
    try {
      const chat = await input.chat.list();
      const target = pick(chat.candidates);
      if (!chat.policy.defaultModel && target) {
        value.signal.throwIfAborted();
        await input.chat.update({ expectedVersion: chat.policy.version, providerModelId: target.id,
          reasoningEffort: null, userId: value.userId });
        result.defaults.push(`Chat: ${target.displayName}`);
      }
    } catch {
      value.signal.throwIfAborted();
      result.state = "partial";
    }
    try {
      const roles = await input.roles.list();
      const image = !roles.policy.imageModel ? pick(roles.imageCandidates ?? []) : null;
      const system = !roles.policy.systemModel ? pick(roles.candidates) : null;
      const pdf = !roles.policy.chatPdfModel
        ? pick(roles.documentCandidates.filter((model) => model.visionInput === "verified")) : null;
      const rerankerUpstream = rerankerPresetsForFamily(connection.family).find((preset) => preset.default)?.upstreamModelId;
      const rerankerId = connection.models.find((model) => model.activeConfig?.upstreamModelId === rerankerUpstream)?.id;
      const reranker = !roles.policy.rerankerModel
        ? pick(roles.rerankerCandidates.filter((model) => model.id === rerankerId)) : null;
      if (connection.family === "openrouter" && !roles.policy.rerankerModel && !reranker) result.state = "partial";
      if (system || pdf || reranker || image) {
        value.signal.throwIfAborted();
        await input.roles.update({ expectedVersion: roles.policy.version, userId: value.userId,
          ...(image ? { imageProviderModelId: image.id, imageParameters: {} } : {}),
          ...(system ? { providerModelId: system.id, reasoningEffort: null } : {}),
          ...(pdf ? { chatPdfProviderModelId: pdf.id, chatPdfReasoningEffort: null } : {}),
          ...(reranker ? { rerankerProviderModelId: reranker.id } : {}) });
        if (system) result.defaults.push(`System model: ${system.displayName}`);
        if (pdf) result.defaults.push(`Page-image reader: ${pdf.displayName}`);
        if (reranker) result.defaults.push(`Reranking: ${reranker.displayName}`);
        if (image) result.defaults.push(`Image generation: ${image.displayName}`);
      }
    } catch {
      value.signal.throwIfAborted();
      result.state = "partial";
    }
    if (connection.family === "openrouter" && DEFAULT_DECISION_FEATURES.length) {
      try {
        const roles = await input.roles.list();
        const model = connection.models.find((entry) => entry.activeConfig?.upstreamModelId === JEV_MODEL_ID &&
          eligible.has(entry.id) && roles.decisionCandidates?.some((candidate) => candidate.id === entry.id));
        if (model && !roles.policy.decisionModel) {
          value.signal.throwIfAborted();
          if (await input.roles.adoptDecisionModel({ expectedVersion: roles.policy.version, providerModelId: model.id, userId: value.userId })) {
            result.defaults.push(`Relevance checks: ${model.displayName}`);
          }
        }
      } catch {
        value.signal.throwIfAborted();
        // The independently optional role cannot prevent ordinary setup.
        result.state = "partial";
      }
    }
    try {
      const roles = await input.roles.list();
      const memory = roles.memoryPolicy.assignmentSource === "unassigned"
        ? roles.memoryPolicy.recommendations?.find((entry) => entry.unavailableReason === null &&
          entry.connectionId === connection.id && entry.providerModelId && eligible.has(entry.providerModelId)) : null;
      if (memory) {
        value.signal.throwIfAborted();
        await input.roles.updateMemory({ expectedVersion: roles.memoryPolicy.version,
          providerModelId: memory.providerModelId, reasoningEffort: memory.reasoningEffort,
          recommendationId: memory.id, assignmentSource: "BOOTSTRAP", userId: value.userId });
        result.defaults.push(`Memory: ${memory.displayName}`);
      } else if (roles.memoryPolicy.assignmentSource === "unassigned") {
        result.state = "partial";
      }
    } catch {
      value.signal.throwIfAborted();
      result.state = "partial";
    }
    try {
      const roles = await input.roles.list();
      const recommendation = !roles.policy.chatTitleModel ? roles.memoryPolicy.recommendations?.find((entry) =>
        entry.unavailableReason === null && entry.connectionId === connection.id && entry.providerModelId &&
        eligible.has(entry.providerModelId) && roles.titleCandidates.some((model) => model.id === entry.providerModelId)) : null;
      const target = roles.titleCandidates.find((model) => model.id === recommendation?.providerModelId);
      if (target && recommendation) {
        // Use the qualified utility shortlist, not an arbitrary answer model.
        // Titles prefer reasoning Off when the exact deployment supports it.
        const effort = target.reasoningEfforts.includes("none") ? "none" : recommendation.reasoningEffort;
        if (target.reasoningEfforts.includes(effort)) {
          value.signal.throwIfAborted();
          if (await input.roles.adoptChatTitle({ expectedVersion: roles.policy.version,
            providerModelId: target.id, reasoningEffort: effort, userId: value.userId })) {
            result.defaults.push(`Chat titles: ${target.displayName}`);
          }
        }
      }
    } catch {
      value.signal.throwIfAborted();
      result.state = "partial";
    }
    try {
      value.signal.throwIfAborted();
      const knowledge = await input.knowledge.list();
      if (!knowledge.activeRevision) {
        const preferredEmbedding = embeddingPresetsForFamily(connection.family).find((preset) => preset.default)?.upstreamModelId;
        const embeddingId = connection.models.find((model) => model.activeConfig?.upstreamModelId === preferredEmbedding)?.id;
        const embeddings = knowledge.availableDestinations.filter((model) => eligible.has(model.deploymentId));
        const embedding = embeddings.find((model) => model.deploymentId === embeddingId) ?? embeddings[0];
        const document = knowledge.availablePdfDestinations.find((model) => model.vision && eligible.has(model.deploymentId));
        if (embedding && document) {
          value.signal.throwIfAborted();
          await input.knowledge.activate({ deploymentId: embedding.deploymentId,
            documentDeploymentId: document.deploymentId, pdfProcessingMode: "system_model_vision",
            expectedVersion: knowledge.version, signal: value.signal, userId: value.userId });
          result.defaults.push(`Knowledge: ${embedding.modelDisplayName} · ${document.modelDisplayName}`);
        } else if (connection.family === "openrouter") result.state = "partial";
      }
    } catch {
      value.signal.throwIfAborted();
      result.state = "partial";
    }
    try {
      value.signal.throwIfAborted();
      const search = await input.search.list({ userId: value.userId });
      const existing = search.integrations.find((source) => source.sourceConnectionId === connection.id);
      // An established off switch and an unfinished Search edit remain owned
      // by the operator, even when a different key was just saved.
      if (existing?.archivedAt || existing?.configurationActive && (!existing.enabled || existing.draftDirty)) return result;
      const target = pick(search.providerModels.filter(({ enabled }) => enabled));
      if (!target) return result;
      const protocol = {
        anthropic_web_search: "anthropic_web_search", deepseek_web_search: "deepseek_responses_web_search",
        gemini_google_search: "gemini_google_search", perplexity_search: "openrouter_perplexity_chat",
        web_search: "openai_responses_web_search"
      } as const;
      const draft: AdminSearchDraft = existing?.configurationActive && existing.configuration
        ? existing.configuration : {
          ...adminSearchExecutionDefaults,
          adapterKind: "provider_model_client", credentialMode: "provider_model", providerModelId: target.id,
          protocol: protocol[target.searchKind],
          timeoutMs: Math.min(adminSearchExecutionDefaults.timeoutMs,
            (target.responseTimeoutSeconds ?? adminSearchExecutionDefaults.timeoutMs / 1_000) * 1_000)
        };
      value.signal.throwIfAborted();
      if (existing?.configurationActive) {
        await input.search.saveAndCheck({ description: existing.description, displayName: existing.displayName,
          draft, expectedDraftVersion: existing.draftVersion, id: existing.id, signal: value.signal, userId: value.userId });
      } else {
        await input.search.createDraft({ bootstrap: true, check: true, description: `Web search through ${connection.displayName}.`,
          displayName: `${connection.displayName} Search`, draft, signal: value.signal, userId: value.userId });
      }
      result.search = "ready";
    } catch {
      value.signal.throwIfAborted();
      result.search = "failed";
      result.state = "partial";
    }
    return result;
  };
}
