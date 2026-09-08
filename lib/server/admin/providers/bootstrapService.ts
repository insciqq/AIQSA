import type { AdminProviderBootstrapResult, AdminProviderConnection } from "../../../contracts/adminProviders";
import { adminSearchExecutionDefaults, type AdminSearchDraft } from "../../../contracts/adminSearch";
import { ADMIN_PROVIDER_QUICK_SETUP_PROVIDERS, type AdminProviderQuickSetupProviderId } from "../../../contracts/adminProviderQuickSetup";
import type { createAdminSearchService } from "../search/service";
import type { createAdminModelPolicyService } from "./modelPolicyService";
import type { createAdminSystemModelPolicyService } from "./systemModelPolicyService";
import { adminProviderQuickSetupPolicy } from "./quickSetupPolicy";

/** Finish setup through the ordinary, version-fenced owners. Never change an
 * existing destination, grant file-processing permission, or move stored data. */
export function createAdminProviderBootstrap(input: {
  providers: { listConnections(): Promise<AdminProviderConnection[]> };
  chat: Pick<ReturnType<typeof createAdminModelPolicyService>, "list" | "update">;
  roles: Pick<ReturnType<typeof createAdminSystemModelPolicyService>, "list" | "update">;
  search: Pick<ReturnType<typeof createAdminSearchService>, "list" | "createDraft" | "saveAndCheck">;
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
      const memory = !roles.policy.systemModel ? pick(roles.candidates) : null;
      const pdf = !roles.policy.chatPdfModel
        ? pick(roles.documentCandidates.filter((model) => model.visionInput === "verified")) : null;
      if (memory || pdf) {
        value.signal.throwIfAborted();
        await input.roles.update({ expectedVersion: roles.policy.version, userId: value.userId,
          ...(memory ? { providerModelId: memory.id, reasoningEffort: null } : {}),
          ...(pdf ? { chatPdfProviderModelId: pdf.id, chatPdfReasoningEffort: null } : {}) });
        if (memory) result.defaults.push(`Memory: ${memory.displayName}`);
        if (pdf) result.defaults.push(`Chat PDF: ${pdf.displayName}`);
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
          adapterKind: "provider_model_client", credentialMode: "provider_model", providerModelId: target.id,
          protocol: protocol[target.searchKind], queryMaxCharacters: 500, maxResults: 8,
          timeoutMs: Math.min(60_000, (target.responseTimeoutSeconds ?? 60) * 1_000),
          ...adminSearchExecutionDefaults
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
