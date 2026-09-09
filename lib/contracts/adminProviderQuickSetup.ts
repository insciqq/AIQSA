import type { AdminProviderCheckRun } from "./adminProviders";

export const ADMIN_PROVIDER_QUICK_SETUP_PROVIDERS = [
  "openai",
  "anthropic",
  "gemini",
  "deepseek",
  "openrouter"
] as const;

export type AdminProviderQuickSetupProviderId =
  (typeof ADMIN_PROVIDER_QUICK_SETUP_PROVIDERS)[number];

export type AdminProviderQuickSetupModelDisplay = Readonly<{
  displayName: string;
}>;

export type AdminProviderQuickSetupProviderSnapshot = Readonly<{
  /** The code-owned models a setup turns on when the key's catalog has them, in policy order. */
  candidateModels: AdminProviderQuickSetupModelDisplay[];
  provider: AdminProviderQuickSetupProviderId;
  providerDisplayName: string;
  stateToken: string;
}>;

export type AdminProviderQuickSetupSnapshot = Readonly<{
  providers: AdminProviderQuickSetupProviderSnapshot[];
}>;

export type AdminProviderQuickSetupSelection = Readonly<{
  candidateId: string;
  policyVersion: number;
}>;

/** Endpoint settings for a separate connection (PRD 5.3 Advanced). */
export type AdminProviderQuickSetupConnectionOverrides = Readonly<{
  allowPrivateNetwork: boolean;
  apiRoot: string;
  responseTimeoutSeconds: number;
}>;

/**
 * The secret is write-only and must never appear in a response DTO.
 *
 * Without `connectionDisplayName` and `configuration` the setup targets the
 * family's canonical connection (creating, recovering or replacing its key).
 * `connectionDisplayName` names the connection the setup creates; when the
 * canonical connection already exists, or when `configuration` overrides the
 * vendor endpoint, the setup adds a separate connection of the family with
 * that name instead and never returns `selection_required`.
 */
export type AdminProviderQuickSetupRequest = Readonly<{
  configuration?: AdminProviderQuickSetupConnectionOverrides;
  connectionDisplayName?: string;
  expectedState: string;
  provider: AdminProviderQuickSetupProviderId;
  secret: string;
  selectedModel?: AdminProviderQuickSetupSelection;
}>;

export type AdminProviderQuickSetupCandidate = Readonly<{
  candidateId: string;
  displayName: string;
}>;

export type AdminProviderQuickSetupReadyResult = Readonly<{
  checkedAt: string;
  /** The connection the key and models now live on. */
  connectionId: string;
  defaultCredentialChanged: boolean;
  defaultChanged: boolean;
  model: AdminProviderQuickSetupModelDisplay;
  models: AdminProviderQuickSetupModelDisplay[];
  outcome: "ready" | "partial" | "cancelled";
  checkRun?: AdminProviderCheckRun;
  provider: AdminProviderQuickSetupProviderId;
  providerDisplayName: string;
  search?: null | Readonly<{
    displayName: string;
    status: "needs_attention" | "ready";
  }>;
}>;

export type AdminProviderQuickSetupSelectionRequiredResult = Readonly<{
  candidates: AdminProviderQuickSetupCandidate[];
  checkedAt: string;
  expectedState: string;
  outcome: "selection_required";
  policyVersion: number;
  provider: AdminProviderQuickSetupProviderId;
  providerDisplayName: string;
}>;

export type AdminProviderQuickSetupResult =
  | AdminProviderQuickSetupReadyResult
  | AdminProviderQuickSetupSelectionRequiredResult;

export type AdminProviderQuickSetupErrorCode =
  | "provider_credential_test_failed"
  | "provider_draft_stale"
  | "provider_quick_setup_advanced_required"
  | "provider_quick_setup_name_taken"
  | "provider_quick_setup_selection_invalid"
  | "provider_quick_setup_unsupported_catalog";
