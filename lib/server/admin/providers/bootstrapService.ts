import type { AdminProviderBootstrapResult, AdminProviderConnection } from "../../../contracts/adminProviders";
import {
  adminSearchExecutionDefaults,
  DEEPSEEK_SEARCH_API_QUERY_MAX_CHARACTERS,
  defaultOpenRouterWebSearchSettings,
  type AdminSearchDraft,
  type AdminSearchIntegration,
  type AdminSearchProviderModelOption
} from "../../../contracts/adminSearch";
import { ADMIN_PROVIDER_QUICK_SETUP_PROVIDERS, type AdminProviderQuickSetupProviderId } from "../../../contracts/adminProviderQuickSetup";
import type { createAdminSearchService } from "../search/service";
import type { createAdminModelPolicyService } from "./modelPolicyService";
import type { createAdminSystemModelPolicyService } from "./systemModelPolicyService";
import { adminProviderQuickSetupPolicy } from "./quickSetupPolicy";
import { rerankerPresetsForFamily } from "../../../domain/rerankerModels";
import { DEFAULT_DECISION_FEATURES, JEV_MODEL_ID } from "../../../domain/decisionModels";
import { OPENROUTER_WEB_SEARCH_TECHNICAL_MODELS } from "../../../domain/catalog";

const searchProtocols = {
  anthropic_web_search: "anthropic_web_search", deepseek_search_api: "deepseek_search_api",
  gemini_google_search: "gemini_google_search", openrouter_web_search: "openrouter_web_search",
  perplexity_search: "openrouter_perplexity_chat", web_search: "openai_responses_web_search"
} as const satisfies Record<AdminSearchProviderModelOption["searchKind"], AdminSearchDraft["protocol"]>;

/** A Search source provider setup owns on the connection: its own (the
 * provider's Search, Perplexity Sonar on OpenRouter), the DeepSeek Search API,
 * or OpenRouter's web search. */
type SetupSearch = "deepseek_search_api" | "openrouter_web_search" | "own";

function setupSourceKind(setupSearch: SetupSearch, family: string, kind: AdminSearchIntegration["kind"]): boolean {
  if (setupSearch === "deepseek_search_api") return kind === "deepseek_search_api";
  // An OpenRouter connection's web search is its `web_search` source.
  if (setupSearch === "openrouter_web_search") return kind === "web_search";
  return family === "openrouter" ? kind === "perplexity_search" : kind !== "deepseek_search_api";
}

function setupModelKind(setupSearch: SetupSearch, kind: AdminSearchProviderModelOption["searchKind"]): boolean {
  return setupSearch === "own" ? kind !== "deepseek_search_api" && kind !== "openrouter_web_search" : kind === setupSearch;
}

/** Finish setup through the ordinary, version-fenced owners. Existing
 * destinations stay operator-owned. */
export function createAdminProviderBootstrap(input: {
  providers: { listConnections(): Promise<AdminProviderConnection[]> };
  chat: Pick<ReturnType<typeof createAdminModelPolicyService>, "list" | "update">;
  roles: Pick<ReturnType<typeof createAdminSystemModelPolicyService>, "list" | "update" | "adoptChatTitle" | "adoptDecisionModel">;
  search: Pick<ReturnType<typeof createAdminSearchService>, "checkedOnCurrentBinding" | "list" | "createDraft" | "saveAndCheck">;
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
          // A first default is published with the model's own defaults.
          ...(image ? { imageProviderModelId: image.id, imageModels: [...(roles.policy.imageModels ?? [])
            .filter((model) => model.id !== image.id).map((model) => ({ providerModelId: model.id, parameters: model.parameters })),
          { providerModelId: image.id, parameters: {} }] } : {}),
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
      const target = !roles.policy.chatTitleModel ? pick(roles.titleCandidates) : undefined;
      // Titles take reasoning Off where the exact deployment supports it, else its lowest named level.
      const effort = target ? ["none", "low"].find((entry) => target.reasoningEfforts.includes(entry)) : undefined;
      if (target && effort) {
        value.signal.throwIfAborted();
        if (await input.roles.adoptChatTitle({ expectedVersion: roles.policy.version,
          providerModelId: target.id, reasoningEffort: effort, userId: value.userId })) {
          result.defaults.push(`Chat titles: ${target.displayName}`);
        }
      }
    } catch {
      value.signal.throwIfAborted();
      result.state = "partial";
    }
    // Setup owns the connection's own Search; a DeepSeek connection's is the
    // DeepSeek Search API (its hosted Search is retired, operator decision
    // 2026-10-24), and an OpenRouter connection also gets OpenRouter's web
    // search beside its Perplexity Sonar source. Each is checked and
    // published on its own.
    const setupSearches: readonly SetupSearch[] = connection.family === "deepseek" ? ["deepseek_search_api"]
      : connection.family === "openrouter" ? ["own", "openrouter_web_search"] : ["own"];
    for (const setupSearch of setupSearches) {
      const searchApi = setupSearch === "deepseek_search_api";
      const webSearch = setupSearch === "openrouter_web_search";
      let name: string | null = null;
      try {
        value.signal.throwIfAborted();
        const search = await input.search.list({ userId: value.userId });
        const existing = search.integrations.find((source) => source.sourceConnectionId === connection.id &&
          setupSourceKind(setupSearch, connection.family, source.kind));
        // An off switch, also one set before any setup, and an unfinished
        // Search edit remain owned by the operator, even when a different key
        // was just saved. Setup never pays for a check it cannot publish.
        if (existing && (existing.archivedAt || !existing.enabled || existing.configurationActive && existing.draftDirty)) continue;
        const models = search.providerModels.filter((model) => model.enabled && setupModelKind(setupSearch, model.searchKind));
        // OpenRouter's web search starts only on a template technical model,
        // in the template's order; its check then proves that model.
        const target = webSearch
          ? OPENROUTER_WEB_SEARCH_TECHNICAL_MODELS.flatMap(({ upstreamModelId }) => pick(models.filter((model) =>
            connection.models.some((entry) => entry.id === model.id && entry.activeConfig?.upstreamModelId === upstreamModelId))) ?? [])[0]
          : pick(models);
        if (!target) continue;
        name = existing?.displayName ??
          `${connection.displayName} ${searchApi ? "Search API" : webSearch ? "Web Search" : "Search"}`;
        const draft: AdminSearchDraft = existing?.configurationActive && existing.configuration
          ? existing.configuration : {
            ...adminSearchExecutionDefaults,
            adapterKind: "provider_model_client", credentialMode: "provider_model", providerModelId: target.id,
            protocol: searchProtocols[target.searchKind],
            ...(searchApi ? { queryMaxCharacters: DEEPSEEK_SEARCH_API_QUERY_MAX_CHARACTERS } : {}),
            ...(webSearch ? { openRouterWebSearch: defaultOpenRouterWebSearchSettings() } : {}),
            timeoutMs: Math.min(adminSearchExecutionDefaults.timeoutMs,
              (target.responseTimeoutSeconds ?? adminSearchExecutionDefaults.timeoutMs / 1_000) * 1_000)
          };
        value.signal.throwIfAborted();
        // A working source whose last check passed on this exact configuration,
        // model and key needs no new paid check: setup also runs when an
        // unrelated model of the connection is checked or saved.
        if (existing?.configurationActive && existing.ready && existing.readiness === "ready" &&
          await input.search.checkedOnCurrentBinding({ id: existing.id, userId: value.userId })) {
          if (result.search === "skipped") result.search = "ready";
          (result.searchResults ??= []).push({ name, status: "ready" });
          continue;
        }
        if (existing?.configurationActive) {
          await input.search.saveAndCheck({ description: existing.description, displayName: existing.displayName,
            draft, expectedDraftVersion: existing.draftVersion, id: existing.id, signal: value.signal, userId: value.userId });
        } else {
          await input.search.createDraft({ bootstrap: true, check: true, displayName: name, draft, signal: value.signal,
            userId: value.userId, description: searchApi
              ? `Web results with source links from the ${connection.displayName} Search API.`
              : webSearch
                ? `Web results with source links through ${connection.displayName} web search.`
                : `Web search through ${connection.displayName}.` });
        }
        if (result.search === "skipped") result.search = "ready";
        (result.searchResults ??= []).push({ name, status: "ready" });
      } catch {
        value.signal.throwIfAborted();
        result.search = "failed";
        result.state = "partial";
        if (name) (result.searchResults ??= []).push({ name, status: "failed" });
      }
    }
    return result;
  };
}
