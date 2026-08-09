import type {
  AdminProviderQuickSetupConnectionSummary,
  AdminProviderQuickSetupProviderId,
  AdminProviderQuickSetupState
} from "../../../contracts/adminProviderQuickSetup";
import type {
  AdminSearchDraft,
  AdminSearchTestEvidence
} from "../../../contracts/adminSearch";
import type { ProviderModelTemplateKey } from "../../../domain/providerTemplates";
import type { AdminProviderQuickSetupPolicyCandidate } from "./quickSetupPolicy";

export type AdminProviderQuickSetupActor = Readonly<{
  sessionId: string;
  userId: string;
}>;

export type AdminProviderQuickSetupInspection = Readonly<{
  actingUserDefault: boolean;
  authorized: boolean;
  configured: boolean;
  fingerprint: string;
  mode: "initial" | "recovery" | "replacement" | null;
  model: null | Readonly<{
    checkedAt: Date | null;
    displayName: string;
    id: string;
    templateKey: ProviderModelTemplateKey;
  }>;
  preservedModels: ReadonlyArray<Readonly<{
    id: string;
    upstreamModelId: string;
  }>>;
  quickSetupAssignment: null | Readonly<{
    credentialId: string;
  }>;
  quickSetupCredential: null | Readonly<{
    draftVersion: number;
    id: string;
  }>;
  provider: AdminProviderQuickSetupProviderId;
  state: AdminProviderQuickSetupState;
}>;

export type AdminProviderQuickSetupCommitPlan = Readonly<{
  actor: AdminProviderQuickSetupActor;
  candidate: AdminProviderQuickSetupPolicyCandidate;
  candidates: readonly AdminProviderQuickSetupPolicyCandidate[];
  checkedAt: Date;
  credential: Readonly<{
    draftVersion: number;
    id: string;
    isNew: boolean;
    versionEnvelope: string;
    versionId: string;
  }>;
  expectedFingerprint: string;
  grants: ReadonlyArray<Readonly<{
    id: string;
    modelId: string;
  }>>;
  mode: "initial" | "recovery" | "replacement";
  now: Date;
  preservedModels: AdminProviderQuickSetupInspection["preservedModels"];
  provider: AdminProviderQuickSetupProviderId;
  search?: Readonly<{
    draft: AdminSearchDraft;
    draftHash: string;
    evidence: AdminSearchTestEvidence;
    grantId: string;
    integrationId: string;
    revisionId: string;
  }>;
}>;

export type AdminProviderQuickSetupCommitResult =
  | "advanced_required"
  | "catalog_unavailable"
  | "stale"
  | Readonly<{
      defaultCredentialChanged: boolean;
      defaultChanged: boolean;
      search?: "needs_attention" | "ready" | null;
      status: "ready";
    }>;

export type AdminProviderQuickSetupClearPlan = Readonly<{
  actor: AdminProviderQuickSetupActor;
  expectedFingerprint: string;
  now: Date;
  provider: AdminProviderQuickSetupProviderId;
}>;

export type AdminProviderQuickSetupClearCommitResult =
  | "advanced_required"
  | "stale"
  | Readonly<{ status: "cleared" }>;

export type AdminProviderQuickSetupRepository = Readonly<{
  clearAssignment(
    plan: AdminProviderQuickSetupClearPlan
  ): Promise<AdminProviderQuickSetupClearCommitResult>;
  commit(plan: AdminProviderQuickSetupCommitPlan): Promise<AdminProviderQuickSetupCommitResult>;
  inspect(input: AdminProviderQuickSetupActor & Readonly<{
    now: Date;
    provider: AdminProviderQuickSetupProviderId;
  }>): Promise<AdminProviderQuickSetupInspection>;
  listConfiguredConnections(input: AdminProviderQuickSetupActor & Readonly<{
    now: Date;
  }>): Promise<AdminProviderQuickSetupConnectionSummary[]>;
}>;
