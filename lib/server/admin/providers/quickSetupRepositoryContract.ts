import type {
  AdminProviderQuickSetupProviderId
} from "../../../contracts/adminProviderQuickSetup";
import type {
  AdminSearchDraft,
  AdminSearchTestEvidence
} from "../../../contracts/adminSearch";
import type { ProviderModelTemplateKey } from "../../../domain/providerTemplates";
import type { AdminProviderTestEvidence } from "../../../contracts/adminProviders";
import type { ProviderConnectionConfiguration } from "../../providers/providerConfiguration";
import type { AdminProviderQuickSetupPolicyCandidate } from "./quickSetupPolicy";

/** The first key of a connection created by a setup is `Primary` (PRD 5.4); rotated keys keep the label the admin typed. */
export const ADMIN_PROVIDER_SETUP_CREDENTIAL_LABEL = "Primary";

type AdminProviderQuickSetupState =
  | "advanced_required"
  | "disabled"
  | "needs_attention"
  | "not_configured"
  | "ready";

export type AdminProviderQuickSetupActor = Readonly<{
  sessionId: string;
  userId: string;
}>;

export type AdminProviderQuickSetupInspection = Readonly<{
  actingUserDefault: boolean;
  authorized: boolean;
  /** Whether the family's canonical (template) connection row exists. */
  canonicalConnection: boolean;
  configured: boolean;
  /** Display names of every connection of this family, for distinct naming. */
  connectionNames: readonly string[];
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
  /** Name for a canonical connection created by this commit; ignored otherwise. */
  connectionDisplayName?: string;
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
  modelChecks: ReadonlyArray<Readonly<{
    evidence: AdminProviderTestEvidence;
    modelId: string;
  }>>;
  now: Date;
  preservedModels: AdminProviderQuickSetupInspection["preservedModels"];
  provider: AdminProviderQuickSetupProviderId;
  rerankerChecks: ReadonlyArray<Readonly<{
    evidence: AdminProviderTestEvidence;
    providerModelId: string;
    status: "available" | "unavailable";
  }>>;
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

/**
 * A separate connection of a built-in family (PRD 5.3): a fresh graph with
 * generated ids and no template identity, so the family's canonical Quick
 * setup stays untouched. Search sources and OpenRouter reranker presets are
 * canonical-only and never part of this plan.
 */
export type AdminProviderQuickSetupAdditionalPlan = Readonly<{
  actor: AdminProviderQuickSetupActor;
  checkedAt: Date;
  connection: Readonly<{
    configuration: ProviderConnectionConfiguration;
    displayName: string;
    id: string;
  }>;
  credential: Readonly<{
    id: string;
    label: string;
    versionEnvelope: string;
    versionId: string;
  }>;
  expectedFingerprint: string;
  models: ReadonlyArray<Readonly<{
    candidate: AdminProviderQuickSetupPolicyCandidate;
    evidence: AdminProviderTestEvidence;
    grantId: string;
    id: string;
  }>>;
  now: Date;
  provider: AdminProviderQuickSetupProviderId;
}>;

export type AdminProviderQuickSetupAdditionalCommitResult =
  | "advanced_required"
  | "catalog_unavailable"
  | "stale"
  | Readonly<{ status: "ready" }>;

export type AdminProviderQuickSetupRepository = Readonly<{
  commit(plan: AdminProviderQuickSetupCommitPlan): Promise<AdminProviderQuickSetupCommitResult>;
  commitAdditional(
    plan: AdminProviderQuickSetupAdditionalPlan
  ): Promise<AdminProviderQuickSetupAdditionalCommitResult>;
  inspect(input: AdminProviderQuickSetupActor & Readonly<{
    now: Date;
    provider: AdminProviderQuickSetupProviderId;
  }>): Promise<AdminProviderQuickSetupInspection>;
}>;
