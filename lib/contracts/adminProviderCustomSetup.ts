import type {
  AdminCompatibleDiscoveredModel,
  AdminProviderModelCapabilities
} from "./adminProviders";
import type { ProviderReasoningRequestMapping } from "./providerReasoningRequestMapping";

export const ADMIN_PROVIDER_CUSTOM_AUTHENTICATION_MODES = [
  "bearer",
  "none"
] as const;

export type AdminProviderCustomAuthenticationMode =
  (typeof ADMIN_PROVIDER_CUSTOM_AUTHENTICATION_MODES)[number];

export const ADMIN_PROVIDER_CUSTOM_PROTOCOLS = ["chat_completions", "responses"] as const;
export type AdminProviderCustomProtocol =
  (typeof ADMIN_PROVIDER_CUSTOM_PROTOCOLS)[number];

/** A multi-model bootstrap performs one paid tiny-generation test per model. */
export const MAX_ADMIN_PROVIDER_CUSTOM_SETUP_MODELS = 32;

export const ADMIN_PROVIDER_CUSTOM_DEFAULT_CAPABILITIES = {
  contextWindow: 8_192,
  defaultMaxOutputTokens: 1_024,
  nativePdfInput: false,
  nativeImageGeneration: false,
  nativeSearch: false,
  parallelToolCalls: false,
  pdf: true,
  reasoning: false,
  streaming: true,
  toolCalling: false,
  vision: false
} as const satisfies AdminProviderModelCapabilities;

/** The optional secret is write-only and must never appear in a response DTO. */
export type AdminProviderCustomSetupRequest = Readonly<{
  allowPrivateNetwork: boolean;
  apiRoot: string;
  authenticationMode: AdminProviderCustomAuthenticationMode;
  capabilities?: AdminProviderModelCapabilities;
  confirmPaidRequest: true;
  connectionDisplayName?: string;
  defaultParams?: Record<string, unknown>;
  modelDisplayName?: string;
  /** Manual fallback. Exactly one of modelId or modelIds is accepted. */
  modelId?: string;
  /** Explicit ids selected from discovery, in default-preference order. */
  modelIds?: string[];
  protocol: AdminProviderCustomProtocol;
  reasoningRequestMapping?: ProviderReasoningRequestMapping;
  responseTimeoutSeconds: number;
  secret?: string;
}>;

export type AdminProviderCustomDiscoveryRequest = Readonly<{
  allowPrivateNetwork: boolean;
  apiRoot: string;
  authenticationMode: AdminProviderCustomAuthenticationMode;
  responseTimeoutSeconds: number;
  secret?: string;
}>;

export type AdminProviderCustomDiscoveredModel = Readonly<AdminCompatibleDiscoveredModel>;

export type AdminProviderCustomDiscoveryResult = Readonly<{
  checkedAt: string;
  modelCount: number;
  models: AdminProviderCustomDiscoveredModel[];
  source: "models_catalog";
  status: "valid";
}>;

export type AdminProviderCustomSetupReadyResult = Readonly<{
  authenticationMode: AdminProviderCustomAuthenticationMode;
  checkedAt: string;
  connectionDisplayName: string;
  connectionId: string;
  defaultChanged: boolean;
  modelDisplayName: string;
  models: ReadonlyArray<Readonly<{
    modelDisplayName: string;
    providerModelId: string;
  }>>;
  outcome: "ready";
  providerModelId: string;
  search: null | Readonly<{
    displayName: string;
    status: "needs_attention" | "ready";
  }>;
}>;

export type AdminProviderCustomSetupErrorCode =
  | "provider_custom_setup_catalog_unavailable"
  | "provider_custom_setup_stale"
  | "provider_custom_setup_test_failed";
