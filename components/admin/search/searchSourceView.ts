import { formatCheckedAt } from "@/components/admin/providers/providerListView";
import {
  adminSearchExecutionDefaults,
  adminSearchExecutionLimits,
  DEEPSEEK_SEARCH_API_QUERY_MAX_CHARACTERS,
  type AdminSearchCatalog,
  type AdminSearchDraft,
  type AdminSearchIntegration,
  type AdminSearchProviderModelOption
} from "@/lib/contracts/adminSearch";
import { isSearchCombinationCompatible } from "@/lib/domain/catalogMatrix";
import type { SearchPlanMode } from "@/lib/domain/search";

/**
 * Presentation rules for the Search page (PRD 5.6): one status word per
 * source, the chat models it reaches, and the plain-language result of its
 * last check. Everything derives from the admin catalog.
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

/** Which chat models can use this source, as one short phrase for the list. */
export function searchModelsReach(source: AdminSearchIntegration): string {
  if (source.kind === "gemini_google_search") return "Gemini models";
  if (!source.ready) return "No Search model yet";
  if (source.kind === "perplexity_search" || source.kind === "deepseek_search_api" ||
    source.broaderModelSetup === "ready") {
    return "All chat models";
  }
  return "This provider's models";
}

/** The longer explanation of the reach for the source page. */
export function searchModelsReachDetail(source: AdminSearchIntegration): string | null {
  if (source.kind === "gemini_google_search") {
    return "Google Search runs inside Gemini answers; other chat models cannot use it.";
  }
  if (!source.ready) {
    return "Choose an enabled Search model in Configure so chats can use this source.";
  }
  if (source.kind !== "perplexity_search" && source.broaderModelSetup === "setup_required") {
    return "Only this provider's own chat models can use it now. Choose a working Search model in Configure to open it to every chat model.";
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

/** `Working · Sonar on OpenRouter · checked today 12:51` for the page header. */
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

/* Recommended Search plan */

export type SearchPlanOption = Readonly<{
  executionModes: SearchPlanMode[];
  kind: "gemini_google_search" | "perplexity_tool_search" | "web_search";
  strategyId: string;
}>;

export function planKind(source: AdminSearchIntegration): SearchPlanOption["kind"] {
  if (source.kind === "deepseek_search_api") return "web_search";
  return source.kind === "perplexity_search" ? "perplexity_tool_search" : source.kind;
}

/** Sources a plan may name: enabled, working, not archived. */
export function selectablePlanSources(catalog: AdminSearchCatalog): AdminSearchIntegration[] {
  return catalog.integrations.filter((source) =>
    source.enabled && source.ready && !source.archivedAt);
}

export function planCompatible(
  optionIds: readonly string[],
  options: readonly SearchPlanOption[],
  mode: SearchPlanMode
): boolean {
  return (mode !== "all_selected" || optionIds.every((optionId) =>
    options.find((option) => option.strategyId === optionId)
      ?.executionModes.includes("all_selected"))) &&
    isSearchCombinationCompatible(optionIds, options, mode);
}

/* Source form */

export type SearchSourceForm = {
  description: string;
  displayName: string;
  draft: AdminSearchDraft;
  executionInputs: {
    maxOutputTokens: string;
    maxSearchCallsPerAnswer: string;
  };
};

export const DEFAULT_SEARCH_DESCRIPTION = "Web search available in chat.";

export function executionInputValues(
  draft: Pick<AdminSearchDraft, "maxOutputTokens" | "maxSearchCallsPerAnswer">
): SearchSourceForm["executionInputs"] {
  return {
    maxOutputTokens: draft.maxOutputTokens === null ? "" : String(draft.maxOutputTokens),
    maxSearchCallsPerAnswer: String(draft.maxSearchCallsPerAnswer)
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
  maxSearchCallsPerAnswer: string | null;
  valid: boolean;
}> {
  if (form.draft.adapterKind !== "provider_model_client") {
    return { maxOutputTokens: null, maxSearchCallsPerAnswer: null, valid: true };
  }
  // The raw results API has no model reply to limit, so the field is hidden.
  const maxOutputTokens = form.draft.protocol === "deepseek_search_api" ? undefined : boundedInputInteger(
    form.executionInputs.maxOutputTokens,
    adminSearchExecutionLimits.maxOutputTokens
  );
  const maxSearchCallsPerAnswer = boundedInputInteger(
    form.executionInputs.maxSearchCallsPerAnswer,
    adminSearchExecutionLimits.maxSearchCallsPerAnswer
  );
  return {
    maxOutputTokens: form.executionInputs.maxOutputTokens.trim() && maxOutputTokens === null ? "Enter a whole number of at least 16, or leave blank for Auto." : null,
    maxSearchCallsPerAnswer: maxSearchCallsPerAnswer === null
      ? `Enter a whole number from ${adminSearchExecutionLimits.maxSearchCallsPerAnswer.minimum} to ${adminSearchExecutionLimits.maxSearchCallsPerAnswer.maximum}.`
      : null,
    valid: (!form.executionInputs.maxOutputTokens.trim() || maxOutputTokens !== null) && maxSearchCallsPerAnswer !== null
  };
}

export function searchFormsEqual(left: SearchSourceForm, right: SearchSourceForm): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function draftForModel(
  model: AdminSearchProviderModelOption,
  current?: Pick<
    AdminSearchDraft,
    | "maxOutputTokens"
    | "maxResults"
    | "maxSearchCallsPerAnswer"
    | "queryMaxCharacters"
    | "reasoningPolicy"
    | "timeoutMs"
  >
): AdminSearchDraft {
  const queryMaxCharacters = current?.queryMaxCharacters ?? adminSearchExecutionDefaults.queryMaxCharacters;
  const searchApi = model.searchKind === "deepseek_search_api";
  return {
    adapterKind: "provider_model_client",
    credentialMode: "provider_model",
    // The raw results API generates no reply; its hidden limit stays Auto.
    maxOutputTokens: searchApi
      ? adminSearchExecutionDefaults.maxOutputTokens
      : current?.maxOutputTokens ?? adminSearchExecutionDefaults.maxOutputTokens,
    maxResults: current?.maxResults ?? adminSearchExecutionDefaults.maxResults,
    maxSearchCallsPerAnswer: current?.maxSearchCallsPerAnswer ??
      adminSearchExecutionDefaults.maxSearchCallsPerAnswer,
    protocol: model.searchKind === "perplexity_search"
      ? "openrouter_perplexity_chat"
      : model.searchKind === "gemini_google_search"
        ? "gemini_google_search"
        : model.searchKind === "anthropic_web_search"
          ? "anthropic_web_search"
          : model.searchKind === "deepseek_web_search"
            ? "deepseek_responses_web_search"
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
    maxResults: adminSearchExecutionDefaults.maxResults,
    maxSearchCallsPerAnswer: adminSearchExecutionDefaults.maxSearchCallsPerAnswer,
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

/** Models a manual source can be built on: enabled Perplexity models, and
 * DeepSeek models carrying their connection's key for the DeepSeek Search
 * API, whose connection has no live source of that kind yet. */
export function manuallyAddableModels(catalog: AdminSearchCatalog): AdminSearchProviderModelOption[] {
  return catalog.providerModels.filter((model) =>
    model.enabled &&
    (model.searchKind === "perplexity_search" || model.searchKind === "deepseek_search_api") &&
    !catalog.integrations.some((source) =>
      source.archivedAt === null && source.kind === model.searchKind &&
      source.sourceConnectionId === model.connectionId));
}

/** The model choice as the Search model field lists it. */
export function searchModelOptionLabel(model: AdminSearchProviderModelOption): string {
  return model.searchKind === "deepseek_search_api"
    ? `${model.connectionDisplayName} Search API · key via ${model.displayName}`
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
      (source.kind === "web_search" && (model.searchKind === "anthropic_web_search" ||
        model.searchKind === "deepseek_web_search"))));
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
  return {
    description: sourceName ? `Web search through ${sourceName}.` : DEFAULT_SEARCH_DESCRIPTION,
    displayName: sourceName ? `${sourceName} Search` : ""
  };
}
