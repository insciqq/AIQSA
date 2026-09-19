import type { Prisma } from "@prisma/client";
import { decisionFeatureEnabled } from "../../domain/decisionModels";
import type { DecisionFeature } from "../../contracts/semanticDecisions";
import { loadInstallationDecisionProviderRole, ProviderAdmissionError,
  type AdmissionPrisma, type DecisionProviderAdmissionRole } from "./admission";

export type DecisionModelRoleResolution = Readonly<{
  ok: false;
  code: "decision_model_absent" | "decision_feature_disabled" | "decision_model_unavailable";
  selectedProviderModelId: string | null;
}> | Readonly<{
  ok: true;
  credentialScope: "installation";
  policyVersion: number;
  providerModelId: string;
  role: DecisionProviderAdmissionRole;
}>;

export function createDecisionModelRoleResolver(
  db: AdmissionPrisma & Pick<Prisma.TransactionClient, "systemModelPolicy">,
  dependencies: Readonly<{ loadRole?: typeof loadInstallationDecisionProviderRole }> = {}
) {
  const loadRole = dependencies.loadRole ?? loadInstallationDecisionProviderRole;
  return {
    async resolve(feature?: DecisionFeature): Promise<DecisionModelRoleResolution> {
      const policy = await db.systemModelPolicy.findUnique({
        select: { decisionProviderModelId: true, decisionFeaturesJson: true, version: true }, where: { id: "installation" }
      });
      if (!policy?.decisionProviderModelId) return { ok: false, code: "decision_model_absent", selectedProviderModelId: null };
      const providerModelId = policy.decisionProviderModelId;
      if (feature && !decisionFeatureEnabled(policy.decisionFeaturesJson, feature)) {
        return { ok: false, code: "decision_feature_disabled", selectedProviderModelId: providerModelId };
      }
      try {
        const role = await loadRole(db, { providerModelId });
        return { ok: true, credentialScope: "installation", policyVersion: policy.version, providerModelId, role };
      } catch (error) {
        if (!(error instanceof ProviderAdmissionError)) throw error;
        return { ok: false, code: "decision_model_unavailable", selectedProviderModelId: providerModelId };
      }
    }
  };
}
