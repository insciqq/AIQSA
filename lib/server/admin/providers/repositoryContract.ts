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

export type ProviderDraftTestCandidate = Readonly<{
  connection: {
    configuration: unknown;
    displayName: string;
    draftVersion: number;
    family: string;
    id: string;
  };
  credential: {
    id: string;
    source: ProviderCredentialSecretSource;
  };
  model: {
    configuration: unknown;
    displayName: string;
    draftVersion: number;
    id: string;
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
    envelope: string;
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
    configuration: unknown;
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
  models: ReadonlyArray<{
    configuration: unknown;
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

export type AdminProviderRepository = Readonly<{
  activateConnectionCas(input: ProviderActivationWrite): Promise<ProviderDraftMutationResult>;
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
  createCredential(input: {
    connectionId: string;
    draftSecretEnvelope: string;
    id: string;
    label: string;
  }): Promise<"created" | "connection_not_found">;
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
  loadDraftTestCandidate(input: {
    connectionId: string;
    credentialId: string;
    providerModelId: string;
  }): Promise<ProviderDraftTestCandidate | null>;
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
  storeDraftCheckCas(
    candidate: ProviderDraftTestCandidate,
    check: StoredProviderDraftCheck
  ): Promise<"stale" | "stored">;
  storeActiveRefreshCas(input: {
    candidate: ProviderActiveRefreshCandidate;
    checkedAt: Date;
    evidence: AdminProviderTestEvidence;
    status: AdminProviderCheckStatus;
  }): Promise<"stale" | "stored">;
  updateConnectionDraft(input: {
    configuration: ProviderConnectionConfiguration;
    connectionId: string;
    displayName: string;
    expectedDraftVersion: number;
    unassignedPolicy: AdminProviderUnassignedPolicy;
  }): Promise<ProviderDraftMutationResult>;
  updateCredentialDraft(input: {
    credentialId: string;
    draftSecretEnvelope: string | null;
    expectedDraftVersion: number;
  }): Promise<ProviderDraftMutationResult>;
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
