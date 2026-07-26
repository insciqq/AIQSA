import type { AdminProviderModelCapabilities } from "./adminProviders";

export const ADMIN_PROVIDER_CUSTOM_AUTHENTICATION_MODES = [
  "bearer",
  "none"
] as const;

export type AdminProviderCustomAuthenticationMode =
  (typeof ADMIN_PROVIDER_CUSTOM_AUTHENTICATION_MODES)[number];

export const ADMIN_PROVIDER_CUSTOM_DEFAULT_CAPABILITIES = {
  contextWindow: 8_192,
  defaultMaxOutputTokens: 1_024,
  nativePdfInput: false,
  nativeSearch: false,
  parallelToolCalls: false,
  pdf: false,
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
  modelId: string;
  secret?: string;
}>;

export type AdminProviderCustomSetupReadyResult = Readonly<{
  authenticationMode: AdminProviderCustomAuthenticationMode;
  checkedAt: string;
  connectionDisplayName: string;
  connectionId: string;
  defaultChanged: boolean;
  modelDisplayName: string;
  outcome: "ready";
  providerModelId: string;
}>;

export type AdminProviderCustomSetupErrorCode =
  | "provider_custom_setup_catalog_unavailable"
  | "provider_custom_setup_stale"
  | "provider_custom_setup_test_failed";
