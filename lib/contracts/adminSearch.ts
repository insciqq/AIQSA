import type {
  SearchAdapterKind,
  SearchCredentialMode,
  SearchPlanMode,
  SearchProtocol
} from "./search";

export type AdminSearchDraft = {
  adapterKind: SearchAdapterKind;
  credentialMode: SearchCredentialMode;
  maxResults: number;
  protocol: SearchProtocol;
  providerModelId: string | null;
  queryMaxCharacters: number;
  timeoutMs: number;
};

export type AdminSearchTestEvidence = {
  checkedAt: string;
  method: "configuration" | "provider_search";
  normalizedSourceCount: number;
  protocol: SearchProtocol;
  status: "available" | "unavailable";
};

export type AdminSearchIntegration = {
  activeRevision: null | {
    activatedAt: string;
    id: string;
    revisionNumber: number;
  };
  adapterKind: SearchAdapterKind | "none";
  archivedAt: string | null;
  credentialMode: SearchCredentialMode;
  description: string;
  displayName: string;
  draft: AdminSearchDraft;
  draftDirty: boolean;
  draftTestEvidence: AdminSearchTestEvidence | null;
  draftVersion: number;
  enabled: boolean;
  executionModes: SearchPlanMode[];
  id: string;
  providerModel: null | {
    connectionDisplayName: string;
    displayName: string;
    id: string;
    upstreamModelId: string;
  };
  ready: boolean;
  strategyId: string;
  system: boolean;
};

export type AdminSearchProviderModelOption = {
  adapterKind: string;
  connectionDisplayName: string;
  displayName: string;
  enabled: boolean;
  id: string;
  nativeSearch: boolean;
  upstreamModelId: string;
};

export type AdminSearchCatalog = {
  integrations: AdminSearchIntegration[];
  providerModels: AdminSearchProviderModelOption[];
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

function draft(value: unknown): value is AdminSearchDraft {
  if (!isRecord(value)) return false;
  return (
    (value.adapterKind === "answer_provider_hosted" || value.adapterKind === "provider_model_client") &&
    (value.credentialMode === "answer_provider" || value.credentialMode === "provider_model") &&
    Number.isSafeInteger(value.maxResults) &&
    (value.protocol === "gemini_google_search" ||
      value.protocol === "openai_responses_web_search" ||
      value.protocol === "openrouter_perplexity_chat") &&
    nullableString(value.providerModelId) &&
    Number.isSafeInteger(value.queryMaxCharacters) &&
    Number.isSafeInteger(value.timeoutMs)
  );
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

function integration(value: unknown): value is AdminSearchIntegration {
  if (!isRecord(value) || !draft(value.draft) || !evidence(value.draftTestEvidence)) return false;
  const activeRevision = value.activeRevision;
  const providerModel = value.providerModel;
  return (
    (activeRevision === null ||
      (isRecord(activeRevision) && string(activeRevision.activatedAt) && string(activeRevision.id) &&
        Number.isSafeInteger(activeRevision.revisionNumber))) &&
    (value.adapterKind === "none" || value.adapterKind === "answer_provider_hosted" ||
      value.adapterKind === "provider_model_client") &&
    nullableString(value.archivedAt) &&
    (value.credentialMode === "answer_provider" || value.credentialMode === "provider_model") &&
    string(value.description) && string(value.displayName) && typeof value.draftDirty === "boolean" &&
    Number.isSafeInteger(value.draftVersion) && typeof value.enabled === "boolean" &&
    Array.isArray(value.executionModes) && value.executionModes.every((mode) =>
      mode === "all_selected" || mode === "model_choice") &&
    string(value.id) &&
    (providerModel === null ||
      (isRecord(providerModel) && string(providerModel.connectionDisplayName) &&
        string(providerModel.displayName) && string(providerModel.id) &&
        string(providerModel.upstreamModelId))) &&
    typeof value.ready === "boolean" && string(value.strategyId) && typeof value.system === "boolean"
  );
}

function providerModel(value: unknown): value is AdminSearchProviderModelOption {
  return isRecord(value) && string(value.adapterKind) && string(value.connectionDisplayName) &&
    string(value.displayName) && typeof value.enabled === "boolean" && string(value.id) &&
    typeof value.nativeSearch === "boolean" && string(value.upstreamModelId);
}

export function decodeAdminSearchCatalog(value: unknown): AdminSearchCatalog | null {
  if (!isRecord(value) || !isRecord(value.search)) return null;
  const search = value.search;
  if (!Array.isArray(search.integrations) || !search.integrations.every(integration) ||
    !Array.isArray(search.providerModels) || !search.providerModels.every(providerModel)) {
    return null;
  }
  return {
    integrations: search.integrations,
    providerModels: search.providerModels
  };
}
