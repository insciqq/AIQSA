import type { ProviderReasoningRequestMapping } from "./providerReasoningRequestMapping";

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

export const ADMIN_PROVIDER_RESPONSE_TIMEOUT_DEFAULT_SECONDS = 300;
export const ADMIN_PROVIDER_RESPONSE_TIMEOUT_MAX_SECONDS = 900;
export const ADMIN_PROVIDER_RESPONSE_TIMEOUT_MIN_SECONDS = 5;

export type AdminProviderConnectionConfiguration = {
  allowPrivateNetwork: boolean;
  apiRoot: string;
  authenticationMode?: "bearer" | "none";
  /** Whole seconds. Older cached payloads may omit this and inherit 300. */
  responseTimeoutSeconds?: number;
};

export type AdminProviderModelCapabilities = {
  backgroundStreaming?: boolean;
  contextWindow?: number;
  defaultMaxOutputTokens?: number;
  nativeBackground?: boolean;
  /** Administrator-declared support for OpenAI-compatible image generation.
   * AIQSA records this for future image workflows; the current run pipeline
   * does not expose image generation as a runnable tool. */
  nativeImageGeneration?: boolean;
  nativePdfInput: boolean;
  nativeSearch: boolean;
  parallelToolCalls?: boolean;
  pdf: boolean;
  reasoning: boolean;
  defaultReasoningEffort?: string;
  defaultReasoningMode?: string;
  reasoningEfforts?: string[];
  reasoningModes?: string[];
  streaming?: boolean;
  /** Opts a compatible Chat endpoint into `stream_options.include_usage`. */
  streamUsage?: boolean;
  toolCalling?: boolean;
  vision: boolean;
};

export type AdminOpenRouterRouting =
  | { mode: "automatic"; providers: [] }
  | { mode: "only_selected"; providers: string[] };

export type AdminProviderModelConfiguration = {
  adapterKind: AdminProviderAdapterKind;
  answerSelectable: boolean;
  capabilities: AdminProviderModelCapabilities;
  defaultParams: Record<string, unknown>;
  openRouterRouting?: AdminOpenRouterRouting;
  reasoningRequestMapping?: ProviderReasoningRequestMapping;
  /** Whole seconds; omission means inherit the connection value. */
  responseTimeoutSeconds?: number;
  upstreamModelId: string;
};

export type AdminProviderReasoningRequestMapping = ProviderReasoningRequestMapping;

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

export type AdminProviderUserCredentialAssignment = {
  connectionId: string;
  credentialId: string;
  updatedAt: string;
  user: {
    displayName: string;
    email: string | null;
    id: string;
    status: "active" | "denied" | "disabled" | "pending";
  };
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
  /** Optional for backward-compatible decoding of older catalog snapshots. */
  userAssignments?: AdminProviderUserCredentialAssignment[];
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
    | "assistant_revisions"
    | "chat_defaults"
    | "code_owned_template"
    | "connection_default"
    | "credentials"
    | "group_assignments"
    | "installation_default"
    | "models"
    | "resource_enabled"
    | "run_bindings"
    | "search_references"
    | "search_revision_references"
    | "system_model"
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

export type AdminCompatibleDiscoveredCapabilities = {
  contextWindow?: number;
  defaultMaxOutputTokens?: number;
  defaultReasoningEffort?: string;
  defaultReasoningMode?: string;
  reasoning?: boolean;
  reasoningEfforts?: string[];
  reasoningModes?: string[];
};

/** A compatible endpoint catalog exposes a validated id plus only bounded,
 * non-secret capability hints. Administrators still choose the wire protocol
 * and hosted tools explicitly. */
export type AdminCompatibleDiscoveredModel = {
  capabilities: AdminCompatibleDiscoveredCapabilities;
  id: string;
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
