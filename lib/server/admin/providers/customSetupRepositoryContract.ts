import type {
  AdminProviderCustomAuthenticationMode,
  AdminProviderCustomSetupReadyResult
} from "../../../contracts/adminProviderCustomSetup";
import type { AdminProviderTestEvidence } from "../../../contracts/adminProviders";
import type {
  AdminSearchDraft,
  AdminSearchTestEvidence
} from "../../../contracts/adminSearch";
import type {
  ProviderConnectionConfiguration,
  ProviderModelConfiguration
} from "../../providers/providerConfiguration";

export type AdminProviderCustomSetupActor = Readonly<{
  sessionId: string;
  userId: string;
}>;

export type AdminProviderCustomConnectionConfiguration =
  ProviderConnectionConfiguration & Readonly<{
    authenticationMode: AdminProviderCustomAuthenticationMode;
  }>;

export type AdminProviderCustomSetupCommitPlan = Readonly<{
  actor: AdminProviderCustomSetupActor;
  checkedAt: Date;
  connection: Readonly<{
    configuration: AdminProviderCustomConnectionConfiguration;
    displayName: string;
    id: string;
  }>;
  credential: Readonly<{
    id: string;
    label: string;
    secretEnvelope: string | null;
    versionId: string;
  }>;
  models: ReadonlyArray<Readonly<{
    configuration: ProviderModelConfiguration;
    displayName: string;
    evidence: AdminProviderTestEvidence;
    grantId: string;
    id: string;
  }>>;
  now: Date;
  search?: Readonly<{
    client: Readonly<{
      draft: AdminSearchDraft;
      draftHash: string;
      id: string;
      revisionId: string;
      strategyId: string;
    }>;
    description: string;
    displayName: string;
    evidence: AdminSearchTestEvidence;
    grantId: string;
    hosted: Readonly<{
      draft: AdminSearchDraft;
      draftHash: string;
      id: string;
      revisionId: string;
      strategyId: string;
    }>;
    optionId: string;
    optionRowId: string;
  }>;
}>;

export type AdminProviderCustomSetupCommitResult =
  | "catalog_unavailable"
  | "forbidden"
  | "stale"
  | Readonly<{
      defaultChanged: boolean;
      search?: "needs_attention" | "ready" | null;
      status: "ready";
    }>;

export type AdminProviderCustomSetupRepository = Readonly<{
  commit(
    plan: AdminProviderCustomSetupCommitPlan
  ): Promise<AdminProviderCustomSetupCommitResult>;
}>;

export type AdminProviderCustomSetupSafeResult = Pick<
  AdminProviderCustomSetupReadyResult,
  | "authenticationMode"
  | "checkedAt"
  | "connectionDisplayName"
  | "connectionId"
  | "defaultChanged"
  | "modelDisplayName"
  | "models"
  | "outcome"
  | "providerModelId"
  | "search"
>;
