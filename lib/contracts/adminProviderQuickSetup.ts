export const ADMIN_PROVIDER_QUICK_SETUP_PROVIDERS = [
  "openai",
  "anthropic",
  "gemini",
  "openrouter"
] as const;

export type AdminProviderQuickSetupProviderId =
  (typeof ADMIN_PROVIDER_QUICK_SETUP_PROVIDERS)[number];

export type AdminProviderQuickSetupModelDisplay = Readonly<{
  displayName: string;
}>;

export type AdminProviderQuickSetupState =
  | "advanced_required"
  | "disabled"
  | "needs_attention"
  | "not_configured"
  | "ready";

export type AdminProviderQuickSetupProviderSnapshot = Readonly<{
  model?: AdminProviderQuickSetupModelDisplay;
  provider: AdminProviderQuickSetupProviderId;
  providerDisplayName: string;
  quickSetupAssigned: boolean;
  state: AdminProviderQuickSetupState;
  stateToken: string;
}>;

export type AdminProviderQuickSetupConnectionSummary = Readonly<{
  activeModelCount: number;
  displayName: string;
  enabled: boolean;
  family: string;
  id: string;
}>;

export type AdminProviderQuickSetupSnapshot = Readonly<{
  configuredConnections: AdminProviderQuickSetupConnectionSummary[];
  providers: AdminProviderQuickSetupProviderSnapshot[];
  suggestedProvider: AdminProviderQuickSetupProviderId | null;
}>;

export type AdminProviderQuickSetupSelection = Readonly<{
  candidateId: string;
  policyVersion: number;
}>;

/** The secret is write-only and must never appear in a response DTO. */
export type AdminProviderQuickSetupRequest = Readonly<{
  expectedState: string;
  provider: AdminProviderQuickSetupProviderId;
  secret: string;
  selectedModel?: AdminProviderQuickSetupSelection;
}>;

export type AdminProviderQuickSetupClearRequest = Readonly<{
  expectedState: string;
  provider: AdminProviderQuickSetupProviderId;
}>;

export type AdminProviderQuickSetupCandidate = Readonly<{
  candidateId: string;
  displayName: string;
}>;

export type AdminProviderQuickSetupReadyResult = Readonly<{
  checkedAt: string;
  defaultChanged: boolean;
  model: AdminProviderQuickSetupModelDisplay;
  models: AdminProviderQuickSetupModelDisplay[];
  outcome: "ready";
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

export type AdminProviderQuickSetupClearResult = Readonly<{
  credentialRetained: true;
  outcome: "assignment_cleared";
  provider: AdminProviderQuickSetupProviderId;
  providerDisplayName: string;
}>;

export type AdminProviderQuickSetupErrorCode =
  | "provider_credential_test_failed"
  | "provider_draft_stale"
  | "provider_quick_setup_advanced_required"
  | "provider_quick_setup_selection_invalid"
  | "provider_quick_setup_unsupported_catalog";
