export type AdminProviderFamily =
  | "anthropic"
  | "gemini"
  | "openai"
  | "openai_compatible"
  | "openrouter";

export type AdminProviderAdapterKind =
  | "anthropic_messages"
  | "gemini_interactions_native"
  | "openai_chat_completions_compatible"
  | "openai_responses_compatible"
  | "openai_responses_native"
  | "openrouter_chat_completions";

export type AdminProviderUnassignedPolicy = "require_assignment" | "use_default";
export type AdminProviderCheckStatus = "available" | "unavailable";

export type AdminProviderConnectionConfiguration = {
  allowPrivateNetwork: boolean;
  apiRoot: string;
  authenticationMode?: "bearer" | "none";
};

export type AdminProviderModelCapabilities = {
  backgroundStreaming?: boolean;
  contextWindow?: number;
  defaultMaxOutputTokens?: number;
  nativeBackground?: boolean;
  nativePdfInput: boolean;
  nativeSearch: boolean;
  parallelToolCalls?: boolean;
  pdf: boolean;
  reasoning: boolean;
  streaming?: boolean;
  toolCalling?: boolean;
  vision: boolean;
};

export type AdminOpenRouterRouting =
  | { mode: "automatic"; providers: [] }
  | { mode: "only_selected"; providers: string[] };

export type AdminProviderModelConfiguration = {
  adapterKind: AdminProviderAdapterKind;
  capabilities: AdminProviderModelCapabilities;
  defaultParams: Record<string, unknown>;
  openRouterRouting?: AdminOpenRouterRouting;
  upstreamModelId: string;
};

export type AdminProviderTestEvidence = {
  detail: "model_missing" | "ok" | "route_missing";
  method: "models_catalog" | "openrouter_account_catalog" | "tiny_generation";
  selectedProviders: string[];
  upstreamModelId: string;
};

export type AdminProviderCredentialTestResult = {
  checkedAt: string;
  connectionDraftVersion: number;
  modelCount: number;
  status: "valid";
};

export type AdminProviderDraftCheck = {
  checkedAt: string;
  connectionDraftVersion: number;
  credentialDraftVersion: number | null;
  credentialId: string;
  credentialVersionId: string | null;
  evidence: AdminProviderTestEvidence;
  fingerprint: string;
  modelDraftVersion: number;
  providerModelId: string;
  status: AdminProviderCheckStatus;
};

export type AdminProviderActiveCheck = {
  checkedAt: string;
  connectionVersion: number;
  credentialId: string;
  credentialVersionId: string;
  evidence: AdminProviderTestEvidence | null;
  latestRefreshError: { code: "provider_refresh_failed"; version: 1 } | null;
  modelVersion: number;
  providerModelId: string;
  refreshFailedAt: string | null;
  status: AdminProviderCheckStatus;
};

export type AdminProviderCredential = {
  activatedAt: string | null;
  activeVersion: {
    activatedAt: string;
    id: string;
    revokedAt: string | null;
    testedAt: string;
    version: number;
  } | null;
  createdAt: string;
  draftSecretConfigured: boolean;
  draftVersion: number;
  enabled: boolean;
  id: string;
  label: string;
  testedAt: string | null;
  updatedAt: string;
};

export type AdminProviderModel = {
  activatedAt: string | null;
  activeConfig: AdminProviderModelConfiguration | null;
  activeVersion: number;
  connectionId: string;
  createdAt: string;
  displayName: string;
  draftConfig: AdminProviderModelConfiguration;
  draftVersion: number;
  enabled: boolean;
  id: string;
  updatedAt: string;
};

export type AdminProviderGroupCredentialAssignment = {
  connectionId: string;
  credentialId: string;
  group: {
    archivedAt: string | null;
    id: string;
    name: string;
  };
  updatedAt: string;
};

export type AdminProviderConnection = {
  activatedAt: string | null;
  activeChecks: AdminProviderActiveCheck[];
  activeConfig: AdminProviderConnectionConfiguration | null;
  activeVersion: number;
  assignments: AdminProviderGroupCredentialAssignment[];
  createdAt: string;
  credentials: AdminProviderCredential[];
  defaultCredentialId: string | null;
  displayName: string;
  draftChecks: AdminProviderDraftCheck[];
  draftConfig: AdminProviderConnectionConfiguration;
  draftVersion: number;
  enabled: boolean;
  family: AdminProviderFamily | "fake";
  id: string;
  models: AdminProviderModel[];
  unassignedPolicy: AdminProviderUnassignedPolicy;
  updatedAt: string;
};

/** Secret mutation requests are write-only. No response DTO contains this shape. */
export type AdminProviderSecretWrite = {
  secret: string;
};

export type AdminProviderDeleteBlocker = {
  count: number;
  kind:
    | "access_grants"
    | "active_child_configuration"
    | "chat_defaults"
    | "code_owned_template"
    | "connection_default"
    | "credentials"
    | "group_assignments"
    | "models"
    | "resource_enabled"
    | "run_profiles"
    | "run_bindings"
    | "search_references"
    | "user_assignments"
    | "user_defaults";
};

export type AdminProviderDeleteResult =
  | { status: "deleted" }
  | { status: "not_found" }
  | { blockers: AdminProviderDeleteBlocker[]; status: "conflict" };

export type AdminOpenRouterDiscoveredModel = {
  contextLength?: number;
  id: string;
  inputModalities: string[];
  name: string;
  outputModalities: string[];
  pricing: Record<string, string>;
  supportedParameters: string[];
};

export type AdminOpenRouterDiscoveredEndpoint = {
  contextLength?: number;
  maxCompletionTokens?: number;
  maxPromptTokens?: number;
  name: string;
  providerName: string;
  quantization?: string;
  supportedParameters: string[];
  tag: string;
};
