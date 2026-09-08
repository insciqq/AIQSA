import type { SystemModelVerificationRole } from "../../../contracts/adminSystemModelPolicy";
import type {
  AdminProviderCheckStatus,
  AdminProviderConnection,
  AdminProviderDeleteResult,
  AdminProviderFamily,
  AdminProviderTestEvidence,
  AdminProviderUnassignedPolicy
} from "../../../contracts/adminProviders";
import type {
  ProviderConnectionConfiguration,
  ProviderModelConfiguration
} from "../../providers/providerConfiguration";

export type ProviderDraftMutationResult = "not_found" | "stale" | "updated";

export type ProviderCredentialSecretSource =
  | {
      draftVersion: number;
      envelope: string;
      kind: "draft";
    }
  | {
      envelope: string;
      kind: "active";
      versionId: string;
    };

export type ProviderDiscoveryCandidate = Readonly<{
  connection: {
    configuration: unknown;
    family: string;
    id: string;
  };
  credential: {
    id: string;
    /** Null is valid only for an explicit active no-auth compatible credential. */
    source: ProviderCredentialSecretSource | null;
  };
}>;

export type ProviderActiveRefreshCandidate = Readonly<{
  connection: {
    configuration: unknown;
    displayName: string;
    family: string;
    id: string;
    version: number;
  };
  credential: {
    /** Null only for an explicitly configured no-auth compatible endpoint. */
    envelope: string | null;
    id: string;
    versionId: string;
  };
  model: {
    configuration: unknown;
    displayName: string;
    id: string;
    version: number;
  };
}>;

export type LockedProviderCredentialVersion = Readonly<{
  credentialId: string;
  id: string;
  revokedAt: Date | null;
  secretEnvelope: string | null;
}>;

export type StoredProviderDraftCheck = Readonly<{
  checkedAt: Date;
  connectionDraftVersion: number;
  credentialDraftVersion: number | null;
  credentialId: string;
  credentialVersionId: string | null;
  evidence: AdminProviderTestEvidence;
  fingerprint: string;
  modelDraftVersion: number;
  providerModelId: string;
  status: AdminProviderCheckStatus;
}>;

export type ProviderActivationCandidate = Readonly<{
  connection: {
    activeConfiguration: unknown | null;
    configuration: unknown;
    displayName: string;
    draftVersion: number;
    family: string;
    id: string;
  };
  credentials: ReadonlyArray<{
    activeVersion: null | {
      envelope: string;
      id: string;
      version: number;
    };
    draftSecretEnvelope: string | null;
    draftVersion: number;
    enabled: boolean;
    id: string;
  }>;
  draftChecks: readonly StoredProviderDraftCheck[];
  models: ReadonlyArray<{
    configuration: unknown;
    displayName: string;
    draftVersion: number;
    id: string;
  }>;
}>;

export type ProviderActivationWrite = Readonly<{
  checks: StoredProviderDraftCheck[];
  connection: {
    configuration: ProviderConnectionConfiguration;
    draftVersion: number;
    enable: boolean;
    id: string;
  };
  credentials: ReadonlyArray<
    | {
        checkedAt: Date;
        id: string;
        kind: "active";
        testEvidence: Record<string, unknown>;
        versionId: string;
      }
    | {
        checkedAt: Date;
        draftVersion: number;
        id: string;
        kind: "draft";
        testEvidence: Record<string, unknown>;
        versionEnvelope: string;
        versionId: string;
      }
  >;
  models: ReadonlyArray<{
    configuration: ProviderModelConfiguration;
    draftVersion: number;
    id: string;
  }>;
  now: Date;
}>;

export type ProviderDisableTarget = "connection" | "credential" | "model";

/** What one model's `Test & Save` (PRD B2) reads before its scoped activation. */
export type ProviderModelActivationCandidate = Readonly<{
  connection: {
    activeVersion: number;
    /** The key the inline check runs with; null when none is set or usable. */
    defaultCredential: { id: string; usable: boolean } | null;
    draftConfiguration: unknown;
    draftVersion: number;
    family: string;
    id: string;
  };
  model: {
    configuration: unknown;
    displayName: string;
    draftVersion: number;
    id: string;
  };
}>;

/**
 * Narrow activation of exactly one model draft: its draft becomes the active
 * configuration while every other model, key and connection draft stays as
 * it is. A connection that was never activated takes its current draft
 * configuration live at the same time so the model can be checked and used.
 */
export type ProviderModelActivationWrite = Readonly<{
  connection: {
    activateDraft: { configuration: ProviderConnectionConfiguration; draftVersion: number } | null;
    id: string;
  };
  enable: boolean;
  model: {
    configuration: ProviderModelConfiguration;
    draftVersion: number;
    id: string;
  };
  now: Date;
}>;

/**
 * One tested key becomes the active version of exactly one credential. A
 * `new` credential row is created enabled; a `rotate` write replaces the
 * active version of an existing credential only while its draft version is
 * still the expected one. Connection and model drafts are never touched, and
 * the credential becomes the connection default only when none is set.
 */
export type ProviderCredentialActivationWrite = Readonly<{
  checkedAt: Date;
  connectionId: string;
  expectedConnectionVersion: number;
  expectedConnectionDraftVersion: number;
  /** Catalog access is published with the key; capability checks follow separately. */
  modelChecks: readonly ProviderCatalogAccessCheck[];
  credential:
    | { id: string; kind: "new"; label: string }
    | { expectedDraftVersion: number; id: string; kind: "rotate" };
  now: Date;
  testEvidence: Record<string, unknown>;
  versionEnvelope: string;
  versionId: string;
}>;

export type ProviderCatalogAccessCheck = Readonly<{
  evidence: AdminProviderTestEvidence;
  modelVersion: number;
  providerModelId: string;
  status: AdminProviderCheckStatus;
}>;

export type ProviderConnectionSettingsWrite = Readonly<{
  configuration: ProviderConnectionConfiguration;
  connectionId: string;
  displayName: string;
  expectedActiveVersion: number;
  expectedDraftVersion: number;
  /** Every current non-revoked credential is fenced, including disabled keys. */
  credentials: readonly Readonly<{
    credentialId: string;
    expectedDraftVersion: number;
    expectedVersionId: string;
    modelChecks: readonly ProviderCatalogAccessCheck[];
    replacement: { envelope: string; versionId: string } | null;
    testEvidence: Record<string, unknown>;
  }>[];
  now: Date;
  unassignedPolicy: AdminProviderUnassignedPolicy;
}>;

export type ProviderCredentialActivationResult =
  | "connection_not_found"
  | "credential_not_found"
  | "label_taken"
  | "stale"
  | "updated";

export type AdminProviderRepository = Readonly<{
  activateConnectionCas(input: ProviderActivationWrite): Promise<ProviderDraftMutationResult>;
  activateCredentialCas(
    input: ProviderCredentialActivationWrite
  ): Promise<ProviderCredentialActivationResult>;
  activateModelCas(input: ProviderModelActivationWrite): Promise<ProviderDraftMutationResult>;
  saveConnectionSettingsCas(input: ProviderConnectionSettingsWrite): Promise<ProviderDraftMutationResult>;
  assignGroupCredential(input: {
    connectionId: string;
    credentialId: string;
    groupId: string;
  }): Promise<"assigned" | "credential_not_found" | "group_not_found">;
  createConnection(input: {
    configuration: ProviderConnectionConfiguration;
    displayName: string;
    family: AdminProviderFamily;
    id: string;
    unassignedPolicy: AdminProviderUnassignedPolicy;
  }): Promise<void>;
  createModel(input: {
    configuration: ProviderModelConfiguration;
    connectionId: string;
    displayName: string;
    family: AdminProviderFamily;
    id: string;
  }): Promise<"connection_not_found" | "created" | "family_mismatch">;
  deleteConnection(connectionId: string): Promise<AdminProviderDeleteResult>;
  deleteCredential(credentialId: string): Promise<AdminProviderDeleteResult>;
  deleteModel(modelId: string): Promise<AdminProviderDeleteResult>;
  disable(target: ProviderDisableTarget, id: string): Promise<"disabled" | "not_found">;
  enable(target: ProviderDisableTarget, id: string): Promise<"enabled" | "not_found">;
  listConnections(): Promise<AdminProviderConnection[]>;
  loadActiveRefreshCandidate(input: {
    connectionId: string;
    credentialId: string;
    providerModelId: string;
  }): Promise<ProviderActiveRefreshCandidate | null>;
  loadActivationCandidate(connectionId: string): Promise<ProviderActivationCandidate | null>;
  loadDiscoveryCandidate(input: {
    connectionId: string;
    credentialId: string;
  }): Promise<ProviderDiscoveryCandidate | null>;
  loadModelActivationCandidate(input: {
    connectionId: string;
    modelId: string;
  }): Promise<ProviderModelActivationCandidate | null>;
  renameCredential(input: {
    credentialId: string;
    label: string;
  }): Promise<"not_found" | "updated">;
  revokeCredentialVersion(input: {
    clearSecret: boolean;
    credentialId: string;
    now: Date;
    versionId: string;
  }): Promise<"not_found" | "revoked">;
  revokeGroupCredential(input: {
    connectionId: string;
    groupId: string;
  }): Promise<"not_found" | "revoked">;
  recordActiveRefreshFailureCas(input: {
    candidate: ProviderActiveRefreshCandidate;
    failedAt: Date;
  }): Promise<"stale" | "stored">;
  setDefaultCredential(input: {
    connectionId: string;
    credentialId: string | null;
  }): Promise<"credential_not_found" | "not_found" | "updated">;
  storeActiveRefreshCas(input: {
    capabilityRole?: SystemModelVerificationRole;
    candidate: ProviderActiveRefreshCandidate;
    checkedAt: Date;
    evidence: AdminProviderTestEvidence;
    status: AdminProviderCheckStatus;
  }): Promise<"stale" | "stored">;
  updateModelDraft(input: {
    configuration: ProviderModelConfiguration;
    displayName: string;
    expectedDraftVersion: number;
    family: AdminProviderFamily;
    modelId: string;
  }): Promise<ProviderDraftMutationResult | "family_mismatch" | "model_class_mismatch">;
  withLockedCredential<Value>(
    credentialId: string,
    credentialVersionId: string,
    consume: (version: LockedProviderCredentialVersion) => Value
  ): Promise<Value | null>;
}>;
