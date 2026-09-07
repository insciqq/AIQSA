import type {
  AdminProviderActiveCheck,
  AdminProviderCheckRun,
  AdminProviderConnection,
  AdminProviderCredential,
  AdminProviderModel
} from "@/lib/contracts/adminProviders";

/** Small content-safe catalog fixtures shared by the Providers tests. */

export const FIXTURE_NOW = "2026-09-07T12:51:00.000Z";

export function fixtureCredential(
  overrides: Partial<AdminProviderCredential> & { id: string; label: string }
): AdminProviderCredential {
  return {
    activatedAt: "2026-08-12T12:00:00.000Z",
    activeVersion: {
      activatedAt: "2026-08-12T12:00:00.000Z",
      id: `${overrides.id}-version`,
      revokedAt: null,
      testedAt: "2026-08-12T12:00:00.000Z",
      version: 1
    },
    createdAt: "2026-08-12T12:00:00.000Z",
    draftSecretConfigured: false,
    draftVersion: 1,
    enabled: true,
    testedAt: "2026-08-12T12:00:00.000Z",
    updatedAt: "2026-08-12T12:00:00.000Z",
    ...overrides
  };
}

export function fixtureModel(
  overrides: Partial<AdminProviderModel> & { connectionId: string; displayName: string; id: string }
): AdminProviderModel {
  const config = {
    adapterKind: "openai_responses_native" as const,
    answerSelectable: true,
    capabilities: {
      nativePdfInput: false,
      nativeSearch: false,
      pdf: false,
      reasoning: false,
      vision: false
    },
    defaultParams: {},
    modelClass: "answer" as const,
    upstreamModelId: overrides.displayName.toLowerCase().replaceAll(" ", "-")
  };
  return {
    activatedAt: FIXTURE_NOW,
    activeConfig: config,
    activeVersion: 1,
    createdAt: FIXTURE_NOW,
    draftConfig: config,
    draftVersion: 1,
    enabled: true,
    modelClass: "answer",
    updatedAt: FIXTURE_NOW,
    ...overrides
  };
}

export function fixtureCheck(
  overrides: Partial<AdminProviderActiveCheck> & { credentialId: string; providerModelId: string }
): AdminProviderActiveCheck {
  return {
    checkedAt: FIXTURE_NOW,
    connectionVersion: 1,
    credentialVersionId: `${overrides.credentialId}-version`,
    evidence: null,
    latestRefreshError: null,
    modelVersion: 1,
    refreshFailedAt: null,
    status: "available",
    ...overrides
  };
}

export function fixtureCheckRun(
  overrides: Partial<AdminProviderCheckRun> & { credentialId: string; id: string }
): AdminProviderCheckRun {
  return {
    current: null,
    done: 0,
    failed: [],
    finishedAt: null,
    inFlight: [],
    reason: "credential",
    startedAt: FIXTURE_NOW,
    state: "running",
    total: 0,
    ...overrides
  };
}

export function fixtureConnection(
  overrides: Partial<AdminProviderConnection> & { displayName: string; id: string }
): AdminProviderConnection {
  const family = overrides.family ?? "openai";
  const configuration = {
    allowPrivateNetwork: false,
    apiRoot: family === "openai_compatible" ? "https://codex-lb.example.test/v1" : "https://api.openai.com/v1",
    authenticationMode: "bearer" as const,
    responseTimeoutSeconds: 300
  };
  return {
    activatedAt: FIXTURE_NOW,
    activeChecks: [],
    activeConfig: configuration,
    activeVersion: 1,
    assignments: [],
    createdAt: FIXTURE_NOW,
    credentials: [],
    defaultCredentialId: null,
    draftChecks: [],
    draftConfig: configuration,
    draftVersion: 1,
    enabled: true,
    family,
    models: [],
    unassignedPolicy: "use_default",
    updatedAt: FIXTURE_NOW,
    userAssignments: [],
    ...overrides
  };
}

/** OpenAI with one working default key and two models on. */
export function workingConnection(): AdminProviderConnection {
  return fixtureConnection({
    credentials: [fixtureCredential({ id: "cred-primary", label: "Primary" })],
    defaultCredentialId: "cred-primary",
    displayName: "OpenAI",
    id: "conn-openai",
    models: [
      fixtureModel({ connectionId: "conn-openai", displayName: "GPT-5.6 Terra", id: "model-terra" }),
      fixtureModel({ connectionId: "conn-openai", displayName: "GPT-5.6 Luna", id: "model-luna" })
    ]
  });
}
