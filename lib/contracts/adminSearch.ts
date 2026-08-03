import type {
  SearchAdapterKind,
  SearchCredentialMode,
  SearchPlan,
  SearchPlanMode,
  SearchProtocol
} from "./search";

/** Server-owned physical configuration. The Control Center derives it from a
 * friendly provider-model choice and never presents its transport fields. */
export type AdminSearchDraft = {
  adapterKind: SearchAdapterKind;
  credentialMode: SearchCredentialMode;
  maxResults: number;
  maxOutputTokens: number;
  maxSearchCallsPerAnswer: number;
  protocol: SearchProtocol;
  providerModelId: string | null;
  queryMaxCharacters: number;
  reasoningPolicy: AdminSearchReasoningPolicy;
  timeoutMs: number;
};

export type AdminSearchReasoningPolicy = "lowest_supported" | "provider_default";

export const adminSearchExecutionDefaults = Object.freeze({
  maxOutputTokens: 4_096,
  maxSearchCallsPerAnswer: 2,
  reasoningPolicy: "lowest_supported" as const
});

export const adminSearchExecutionLimits = Object.freeze({
  maxOutputTokens: Object.freeze({ maximum: 32_768, minimum: 1_024 }),
  maxSearchCallsPerAnswer: Object.freeze({ maximum: 4, minimum: 1 })
});

export type AdminSearchTestEvidence = {
  checkedAt: string;
  method: "configuration" | "provider_search";
  normalizedSourceCount: number;
  protocol: SearchProtocol;
  status: "available" | "unavailable";
};

export type AdminSearchKind = "gemini_google_search" | "perplexity_search" | "web_search";
export type AdminSearchReadiness = "ready" | "setup_required" | "source_unavailable";
export type AdminSearchBroaderModelSetup = "not_applicable" | "ready" | "setup_required";

/** One administrator-visible Search source. Physical hosted and generated-query
 * implementations stay aggregated behind this parent identity. */
export type AdminSearchIntegration = {
  archivedAt: string | null;
  broaderModelSetup: AdminSearchBroaderModelSetup;
  configurable: boolean;
  configuration: AdminSearchDraft | null;
  configurationActive: boolean;
  description: string;
  displayName: string;
  draftDirty: boolean;
  draftTestEvidence: AdminSearchTestEvidence | null;
  draftVersion: number;
  enabled: boolean;
  executionModes: SearchPlanMode[];
  id: string;
  kind: AdminSearchKind;
  providerModel: null | {
    connectionDisplayName: string;
    connectionId: string;
    displayName: string;
    id: string;
  };
  ready: boolean;
  readiness: AdminSearchReadiness;
  sourceConnectionId: string;
  strategyId: string;
  system: boolean;
};

export type AdminSearchProviderModelOption = {
  connectionDisplayName: string;
  connectionId: string;
  displayName: string;
  enabled: boolean;
  id: string;
  searchReasoningSupported: boolean;
  searchKind: "perplexity_search" | "web_search";
};

export type AdminSearchCatalog = {
  integrations: AdminSearchIntegration[];
  policy: AdminSearchPolicy;
  providerModels: AdminSearchProviderModelOption[];
};

export type AdminSearchPolicy = {
  defaultPlan: SearchPlan;
  updatedAt: string;
  version: number;
};

export type AdminSearchCatalogResponse = {
  search: AdminSearchCatalog;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function string(value: unknown): value is string {
  return typeof value === "string";
}

function nullableString(value: unknown): value is string | null {
  return value === null || string(value);
}

function boundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

export function decodeAdminSearchDraft(value: unknown): AdminSearchDraft | null {
  if (!isRecord(value)) return null;
  const maxOutputTokens = value.maxOutputTokens ?? adminSearchExecutionDefaults.maxOutputTokens;
  const maxSearchCallsPerAnswer = value.maxSearchCallsPerAnswer ??
    adminSearchExecutionDefaults.maxSearchCallsPerAnswer;
  const reasoningPolicy = value.reasoningPolicy ?? adminSearchExecutionDefaults.reasoningPolicy;
  if (!(
    (value.adapterKind === "answer_provider_hosted" || value.adapterKind === "provider_model_client") &&
    (value.credentialMode === "answer_provider" || value.credentialMode === "provider_model") &&
    Number.isSafeInteger(value.maxResults) &&
    boundedInteger(
      maxOutputTokens,
      adminSearchExecutionLimits.maxOutputTokens.minimum,
      adminSearchExecutionLimits.maxOutputTokens.maximum
    ) &&
    boundedInteger(
      maxSearchCallsPerAnswer,
      adminSearchExecutionLimits.maxSearchCallsPerAnswer.minimum,
      adminSearchExecutionLimits.maxSearchCallsPerAnswer.maximum
    ) &&
    (value.protocol === "gemini_google_search" ||
      value.protocol === "openai_responses_web_search" ||
      value.protocol === "openrouter_perplexity_chat") &&
    nullableString(value.providerModelId) &&
    Number.isSafeInteger(value.queryMaxCharacters) &&
    (reasoningPolicy === "lowest_supported" || reasoningPolicy === "provider_default") &&
    Number.isSafeInteger(value.timeoutMs)
  )) return null;
  return {
    adapterKind: value.adapterKind,
    credentialMode: value.credentialMode,
    maxOutputTokens,
    maxResults: Number(value.maxResults),
    maxSearchCallsPerAnswer,
    protocol: value.protocol,
    providerModelId: value.providerModelId,
    queryMaxCharacters: Number(value.queryMaxCharacters),
    reasoningPolicy,
    timeoutMs: Number(value.timeoutMs)
  };
}

function evidence(value: unknown): value is AdminSearchTestEvidence | null {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  return (
    string(value.checkedAt) &&
    (value.method === "configuration" || value.method === "provider_search") &&
    Number.isSafeInteger(value.normalizedSourceCount) &&
    (value.protocol === "gemini_google_search" ||
      value.protocol === "openai_responses_web_search" ||
      value.protocol === "openrouter_perplexity_chat") &&
    (value.status === "available" || value.status === "unavailable")
  );
}

function integration(value: unknown): boolean {
  if (!isRecord(value) || !evidence(value.draftTestEvidence)) return false;
  const providerModel = value.providerModel;
  return (
    nullableString(value.archivedAt) &&
    (value.broaderModelSetup === "not_applicable" || value.broaderModelSetup === "ready" ||
      value.broaderModelSetup === "setup_required") &&
    typeof value.configurable === "boolean" &&
    (value.configuration === null || decodeAdminSearchDraft(value.configuration) !== null) &&
    typeof value.configurationActive === "boolean" &&
    string(value.description) && string(value.displayName) && typeof value.draftDirty === "boolean" &&
    Number.isSafeInteger(value.draftVersion) && typeof value.enabled === "boolean" &&
    Array.isArray(value.executionModes) && value.executionModes.every((mode) =>
      mode === "all_selected" || mode === "model_choice") &&
    string(value.id) &&
    (value.kind === "gemini_google_search" || value.kind === "perplexity_search" ||
      value.kind === "web_search") &&
    (providerModel === null ||
      (isRecord(providerModel) && string(providerModel.connectionDisplayName) &&
        string(providerModel.connectionId) && string(providerModel.displayName) &&
        string(providerModel.id))) &&
    typeof value.ready === "boolean" &&
    (value.readiness === "ready" || value.readiness === "setup_required" ||
      value.readiness === "source_unavailable") &&
    string(value.sourceConnectionId) && string(value.strategyId) &&
    typeof value.system === "boolean"
  );
}

function providerModel(value: unknown): boolean {
  return isRecord(value) && string(value.connectionDisplayName) && string(value.connectionId) &&
    string(value.displayName) && typeof value.enabled === "boolean" && string(value.id) &&
    (value.searchReasoningSupported === undefined ||
      typeof value.searchReasoningSupported === "boolean") &&
    (value.searchKind === "perplexity_search" || value.searchKind === "web_search");
}

function policy(value: unknown): value is AdminSearchPolicy {
  if (!isRecord(value) || !string(value.updatedAt) ||
    !Number.isSafeInteger(value.version) || Number(value.version) < 1 ||
    !isRecord(value.defaultPlan)) {
    return false;
  }
  const plan = value.defaultPlan;
  return (plan.mode === "all_selected" || plan.mode === "model_choice") &&
    Array.isArray(plan.optionIds) && plan.optionIds.length <= 3 &&
    plan.optionIds.every(string) && new Set(plan.optionIds).size === plan.optionIds.length;
}

export function decodeAdminSearchCatalog(value: unknown): AdminSearchCatalog | null {
  if (!isRecord(value) || !isRecord(value.search)) return null;
  const search = value.search;
  if (!Array.isArray(search.integrations) || !search.integrations.every(integration) ||
    !policy(search.policy) ||
    !Array.isArray(search.providerModels) || !search.providerModels.every(providerModel)) {
    return null;
  }
  return {
    integrations: search.integrations.map((value) => {
      const item = value as AdminSearchIntegration;
      return {
        ...item,
        configuration: item.configuration === null
          ? null
          : decodeAdminSearchDraft(item.configuration)!
      };
    }),
    policy: search.policy as AdminSearchPolicy,
    providerModels: search.providerModels.map((value) => ({
      ...(value as Omit<AdminSearchProviderModelOption, "searchReasoningSupported">),
      searchReasoningSupported: isRecord(value) && value.searchReasoningSupported === true
    }))
  };
}
