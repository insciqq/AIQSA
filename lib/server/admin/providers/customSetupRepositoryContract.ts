import type {
  AdminProviderCustomAuthenticationMode,
  AdminProviderCustomSetupReadyResult
} from "../../../contracts/adminProviderCustomSetup";
import type { AdminProviderTestEvidence } from "../../../contracts/adminProviders";
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
  evidence: AdminProviderTestEvidence;
  grantId: string;
  model: Readonly<{
    configuration: ProviderModelConfiguration;
    displayName: string;
    id: string;
  }>;
  now: Date;
}>;

export type AdminProviderCustomSetupCommitResult =
  | "catalog_unavailable"
  | "forbidden"
  | "stale"
  | Readonly<{
      defaultChanged: boolean;
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
  | "outcome"
  | "providerModelId"
>;
