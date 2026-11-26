import { formatCheckedAt } from "@/components/admin/providers/providerListView";
import {
  adminSearchExecutionDefaults,
  adminSearchExecutionLimits,
  DEEPSEEK_SEARCH_API_QUERY_MAX_CHARACTERS,
  defaultOpenRouterWebSearchSettings,
  type AdminSearchCatalog,
  type AdminSearchDraft,
  type AdminSearchIntegration,
  type AdminSearchPolicy,
  type AdminSearchProviderModelOption
} from "@/lib/contracts/adminSearch";
import { SEARCH_ENGINE_DEFAULT_ORDER } from "@/lib/domain/search";

/**
 * Presentation rules for the Search page (PRD 5.6): one status word per
 * source, its part in the installation's Search (engine or backup), and the
 * plain-language result of its last check. Everything derives from the admin
 * catalog.
 */

export type SearchStatusTone = "critical" | "neutral" | "ok" | "warn";

export type SearchSourceStatus = Readonly<{
  kind: "archived" | "disabled" | "setup_needed" | "source_unavailable" | "working";
  label: "Archived" | "Disabled" | "Setup needed" | "Source unavailable" | "Working";
  tone: SearchStatusTone;
}>;

export function searchSourceStatus(source: AdminSearchIntegration): SearchSourceStatus {
  if (source.archivedAt) return { kind: "archived", label: "Archived", tone: "neutral" };
  if (!source.enabled) return { kind: "disabled", label: "Disabled", tone: "neutral" };
  if (source.readiness === "source_unavailable") {
    return { kind: "source_unavailable", label: "Source unavailable", tone: "critical" };
  }
  if (source.readiness === "setup_required" || (source.configurable && !source.configurationActive)) {
    return { kind: "setup_needed", label: "Setup needed", tone: "warn" };
  }
  return { kind: "working", label: "Working", tone: "ok" };
}

/** Why a source cannot be the engine yet, pointing at the action that exists for it; null when it can. */
export function searchEngineSetupDetail(source: AdminSearchIntegration): string | null {
  if (source.archivedAt || !source.enabled) return null;
  if (!source.ready) {
    if (source.configurable) return "Choose an enabled Search model in Configure so it can search.";
    // A built-in without its own route yet: provider setup adds it with the key.
    return source.kind === "deepseek_search_api"
      ? "Adding a key on its provider page sets it up. Add source can also set it up with one of that connection's models."
      : "Adding a key on its provider page sets it up.";
  }
  if (!searchEngineEligible(source)) {
    return source.configurable
      ? "Only GPT answers on this connection can search with it now. Choose a working Search model in Configure so it can be the engine."
      : "Only GPT answers on this connection can search with it now.";
  }
  return null;
}

export function searchModelLabel(source: AdminSearchIntegration): string {
  if (!source.providerModel) return "Managed with its provider";
  // The API searches; the model only routes its connection's key.
  return source.kind === "deepseek_search_api"
    ? `${source.providerModel.connectionDisplayName} Search API, key via ${source.providerModel.displayName}`
    : `${source.providerModel.displayName} on ${source.providerModel.connectionDisplayName}`;
}

export type SearchCheckSummary = Readonly<{
  checkedAt: string | null;
  detail: string;
  tone: SearchStatusTone;
}>;

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The last live check in plain words: when it ran and what it found. */
export function searchCheckSummary(source: AdminSearchIntegration, now = new Date()): SearchCheckSummary {
  const evidence = source.draftTestEvidence?.method === "provider_search" ? source.draftTestEvidence : null;
  if (!evidence) return { checkedAt: null, detail: "Not checked yet", tone: "neutral" };
  const when = formatCheckedAt(evidence.checkedAt, now);
  if (evidence.status !== "available") {
    return { checkedAt: evidence.checkedAt, detail: `Checked ${when} · no sources found`, tone: "warn" };
  }
  return {
    checkedAt: evidence.checkedAt,
    detail: evidence.normalizedSourceCount > 0
      ? `Checked ${when} · working, ${plural(evidence.normalizedSourceCount, "source")} found`
      : `Checked ${when} · working`,
    tone: "ok"
  };
}

/** `Working · DeepSeek V4.1 Flash on OpenRouter · checked today 12:51` for the page header. */
export function searchHeaderStatus(source: AdminSearchIntegration, now = new Date()): string {
  const check = searchCheckSummary(source, now);
  return [
    searchSourceStatus(source).label,
    searchModelLabel(source),
    check.checkedAt ? `checked ${formatCheckedAt(check.checkedAt, now)}` : "not checked yet"
  ].join(" · ");
}

export function durationLabel(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1_000);
  return seconds >= 60 && seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} sec`;
}

/* The installation's engine */

/** Sources the engine or the backup may be (the server's rule): live, turned on, and able to search for every
 * model, which a source can only through its own Search model. */
export function searchEngineEligible(source: AdminSearchIntegration): boolean {
  return source.enabled && !source.archivedAt && source.executionModes.includes("all_selected");
}

export function searchEngineCandidates(catalog: AdminSearchCatalog): AdminSearchIntegration[] {
  return catalog.integrations.filter(searchEngineEligible);
}

export type SearchEngineRole = "backup" | "engine" | null;

/** The source's part in the installation's Search: the engine (chosen, or picked by the default order) or the
 * backup the administrator chose. */
export function searchEngineRole(source: AdminSearchIntegration, policy: AdminSearchPolicy): SearchEngineRole {
  if (source.strategyId === (policy.engineOptionId ?? policy.resolved?.engineOptionId ?? null)) return "engine";
  if (policy.backupOptionId && source.strategyId === policy.backupOptionId) return "backup";
  return null;
}

/** The role in words; null for a source that is neither, which GPT answers may still use inside their own answer. */
export function searchEngineRoleLabel(role: SearchEngineRole, policy: AdminSearchPolicy): string | null {
  if (role === "engine") return policy.engineOptionId ? "Engine" : "Engine (automatic)";
  return role === "backup" ? "Backup" : null;
}

const DEFAULT_ORDER_LABELS: Readonly<Record<string, string>> = {
  anthropic_web_search: "Anthropic web search",
  deepseek_search_api: "DeepSeek Search API",
  gemini_google_search: "Gemini Google Search",
  openai_responses_web_search: "OpenAI web search",
  openrouter_web_search: "OpenRouter"
};

/** `SEARCH_ENGINE_DEFAULT_ORDER` in words, for the Automatic choice. */
export function searchDefaultOrderText(): string {
  return SEARCH_ENGINE_DEFAULT_ORDER.map((entry) => {
    const label = DEFAULT_ORDER_LABELS[entry.protocol] ?? entry.protocol;
    return entry.openRouterEngine ? `${label} with ${openRouterEngineLabel(entry.openRouterEngine)}` : label;
  }).join(", ");
}

const OPENROUTER_ENGINE_LABELS: Readonly<Record<string, string>> = {
  exa: "Exa",
  parallel: "Parallel",
  perplexity: "Perplexity"
};

export function openRouterEngineLabel(engine: string): string {
  return OPENROUTER_ENGINE_LABELS[engine] ?? engine;
}

export function openRouterModeLabel(mode: string): string {
  return mode.charAt(0).toLocaleUpperCase() + mode.slice(1);
}

/* Source form */

export type SearchSourceForm = {
  description: string;
  displayName: string;
  draft: AdminSearchDraft;
  executionInputs: {
    maxOutputTokens: string;
  };
};

export const DEFAULT_SEARCH_DESCRIPTION = "Web search available in chat.";

export function executionInputValues(
  draft: Pick<AdminSearchDraft, "maxOutputTokens">
): SearchSourceForm["executionInputs"] {
  return {
    maxOutputTokens: draft.maxOutputTokens === null ? "" : String(draft.maxOutputTokens)
  };
}

function boundedInputInteger(
  value: string,
  limits: Readonly<{ maximum: number; minimum: number }>
): number | null {
  const parsed = Number(value);
  return value.trim() && Number.isSafeInteger(parsed) &&
    parsed >= limits.minimum && parsed <= limits.maximum
    ? parsed
    : null;
}

export function searchExecutionValidation(form: SearchSourceForm): Readonly<{
  maxOutputTokens: string | null;
  valid: boolean;
}> {
  if (form.draft.adapterKind !== "provider_model_client") {
    return { maxOutputTokens: null, valid: true };
  }
  // Results-only engines have no model reply to limit, so the field is hidden.
  const maxOutputTokens = searchProtocolResultsOnly(form.draft.protocol) ? undefined : boundedInputInteger(
    form.executionInputs.maxOutputTokens,
    adminSearchExecutionLimits.maxOutputTokens
  );
  return {
    maxOutputTokens: form.executionInputs.maxOutputTokens.trim() && maxOutputTokens === null ? "Enter a whole number of at least 16, or leave blank for Auto." : null,
    valid: !form.executionInputs.maxOutputTokens.trim() || maxOutputTokens !== null
  };
}

/** Engines that return results rather than a model's reply: the DeepSeek Search API and OpenRouter's web search,
 * whose Search model only runs the search. The reply limit does not apply to them. */
export function searchProtocolResultsOnly(protocol: AdminSearchDraft["protocol"]): boolean {
  return protocol === "deepseek_search_api" || protocol === "openrouter_web_search";
}

export function searchFormsEqual(left: SearchSourceForm, right: SearchSourceForm): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function draftForModel(
  model: AdminSearchProviderModelOption,
  current?: Pick<
    AdminSearchDraft,
    | "maxOutputTokens"
    | "openRouterWebSearch"
    | "queryMaxCharacters"
    | "reasoningPolicy"
    | "timeoutMs"
  >
): AdminSearchDraft {
  const queryMaxCharacters = current?.queryMaxCharacters ?? adminSearchExecutionDefaults.queryMaxCharacters;
  const searchApi = model.searchKind === "deepseek_search_api";
  const webSearch = model.searchKind === "openrouter_web_search";
  return {
    adapterKind: "provider_model_client",
    credentialMode: "provider_model",
    // A results-only engine generates no reply; its hidden limit stays Auto.
    maxOutputTokens: searchApi || webSearch
      ? adminSearchExecutionDefaults.maxOutputTokens
      : current?.maxOutputTokens ?? adminSearchExecutionDefaults.maxOutputTokens,
    // OpenRouter's web search keeps its engine when its technical model changes.
    ...(webSearch ? { openRouterWebSearch: current?.openRouterWebSearch ?? defaultOpenRouterWebSearchSettings() } : {}),
    protocol: webSearch
      ? "openrouter_web_search"
      : model.searchKind === "gemini_google_search"
        ? "gemini_google_search"
        : model.searchKind === "anthropic_web_search"
          ? "anthropic_web_search"
          : model.searchKind === "deepseek_search_api"
            ? "deepseek_search_api"
            : "openai_responses_web_search",
    providerModelId: model.id,
    queryMaxCharacters: searchApi
      ? Math.min(queryMaxCharacters, DEEPSEEK_SEARCH_API_QUERY_MAX_CHARACTERS)
      : queryMaxCharacters,
    reasoningPolicy: current?.reasoningPolicy ?? adminSearchExecutionDefaults.reasoningPolicy,
    timeoutMs: current?.timeoutMs ?? adminSearchExecutionDefaults.timeoutMs
  };
}

export function emptySearchForm(): SearchSourceForm {
  const draft: AdminSearchDraft = {
    adapterKind: "provider_model_client",
    credentialMode: "provider_model",
    maxOutputTokens: adminSearchExecutionDefaults.maxOutputTokens,
    protocol: "openai_responses_web_search",
    providerModelId: null,
    queryMaxCharacters: adminSearchExecutionDefaults.queryMaxCharacters,
    reasoningPolicy: adminSearchExecutionDefaults.reasoningPolicy,
    timeoutMs: adminSearchExecutionDefaults.timeoutMs
  };
  return {
    description: DEFAULT_SEARCH_DESCRIPTION,
    displayName: "",
    draft,
    executionInputs: executionInputValues(draft)
  };
}

export function searchFormFrom(source: AdminSearchIntegration): SearchSourceForm {
  const draft = source.configuration ? { ...source.configuration } : emptySearchForm().draft;
  return {
    description: source.description,
    displayName: source.displayName,
    draft,
    executionInputs: executionInputValues(draft)
  };
}

/** The stored kind of a source built on a model of this Search kind: OpenRouter's web search is a `web_search`
 * source of its OpenRouter connection. */
function sourceKindFor(searchKind: AdminSearchProviderModelOption["searchKind"]): AdminSearchIntegration["kind"] {
  if (searchKind === "deepseek_search_api") return searchKind;
  return searchKind === "gemini_google_search" ? "gemini_google_search" : "web_search";
}

/** Models a manual source can be built on: enabled OpenRouter models for
 * OpenRouter's web search, and DeepSeek models carrying
 * their connection's key for the DeepSeek Search API, whose connection has no
 * live, configured source of that kind yet. A built-in source that provider
 * setup skipped, such as one switched off before its key was added, is
 * completed here and keeps its identity. */
export function manuallyAddableModels(catalog: AdminSearchCatalog): AdminSearchProviderModelOption[] {
  return catalog.providerModels.filter((model) =>
    model.enabled &&
    (model.searchKind === "deepseek_search_api" || model.searchKind === "openrouter_web_search") &&
    !catalog.integrations.some((source) =>
      source.archivedAt === null && source.configurable && source.kind === sourceKindFor(model.searchKind) &&
      source.sourceConnectionId === model.connectionId));
}

/** A model can be listed once per Search kind (its own Search, the DeepSeek Search API, OpenRouter's web search), so
 * a choice is keyed by both. */
export function searchModelOptionKey(model: Pick<AdminSearchProviderModelOption, "id" | "searchKind">): string {
  return `${model.searchKind}:${model.id}`;
}

/** The choice a configuration names among `options`: its model under the configuration's own protocol. */
export function selectedSearchModel(
  draft: Pick<AdminSearchDraft, "protocol" | "providerModelId">,
  options: readonly AdminSearchProviderModelOption[]
): AdminSearchProviderModelOption | undefined {
  const candidates = options.filter((model) => model.id === draft.providerModelId);
  return candidates.find((model) => draftForModel(model).protocol === draft.protocol) ?? candidates[0];
}

/** The model choice as the Search model field lists it. */
export function searchModelOptionLabel(model: AdminSearchProviderModelOption): string {
  if (model.searchKind === "deepseek_search_api") {
    return `${model.connectionDisplayName} Search API · key via ${model.displayName}`;
  }
  return model.searchKind === "openrouter_web_search"
    ? `${model.connectionDisplayName} web search · ${model.displayName}`
    : `${model.connectionDisplayName} · ${model.displayName}`;
}

/** Models the Configure sheet may pick: same connection, same Search kind. */
export function configurableModels(
  source: Pick<AdminSearchIntegration, "kind" | "sourceConnectionId">,
  providerModels: readonly AdminSearchProviderModelOption[]
): AdminSearchProviderModelOption[] {
  return providerModels.filter((model) =>
    model.connectionId === source.sourceConnectionId &&
    (source.kind === model.searchKind ||
      (source.kind === "web_search" &&
        (model.searchKind === "anthropic_web_search" || model.searchKind === "openrouter_web_search"))));
}

export function sourceIdentityFor(model: AdminSearchProviderModelOption): Readonly<{
  description: string;
  displayName: string;
}> {
  const sourceName = model.connectionDisplayName.trim();
  if (model.searchKind === "deepseek_search_api") {
    return {
      description: sourceName
        ? `Web results with source links from the ${sourceName} Search API.`
        : DEFAULT_SEARCH_DESCRIPTION,
      displayName: sourceName ? `${sourceName} Search API` : ""
    };
  }
  if (model.searchKind === "openrouter_web_search") {
    // As provider setup names it (`bootstrapService.ts`).
    return {
      description: sourceName
        ? `Web results with source links through ${sourceName} web search.`
        : DEFAULT_SEARCH_DESCRIPTION,
      displayName: sourceName ? `${sourceName} Web Search` : ""
    };
  }
  return {
    description: sourceName ? `Web search through ${sourceName}.` : DEFAULT_SEARCH_DESCRIPTION,
    displayName: sourceName ? `${sourceName} Search` : ""
  };
}
