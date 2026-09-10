import type { Prisma } from "@prisma/client";
import { normalizeImageGenerationParameters, type ImageGenerationParameters } from "../../contracts/imageGeneration";
import { type AdmissionPrisma, loadInstallationImageProviderRole, ProviderAdmissionError } from "./admission";
import { normalizeProviderExecutionSnapshot, type ProviderExecutionSnapshot } from "../providers/runtimeFactory";
import { searchProbeBinding, type SearchProbeBinding } from "../search/probeBinding";

export type AcceptedImageGenerationPlan = {
  version: 1;
  policyVersion: number;
  authority: SearchProbeBinding;
  snapshot: ProviderExecutionSnapshot;
  parameters: ImageGenerationParameters;
};

export function decodeAcceptedImageGenerationPlan(value: unknown): AcceptedImageGenerationPlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !["version", "policyVersion", "authority", "snapshot", "parameters"].includes(key)) ||
    raw.version !== 1 || !Number.isSafeInteger(raw.policyVersion) || Number(raw.policyVersion) < 1) return null;
  try {
    const authority = searchProbeBinding(raw.authority);
    const snapshot = normalizeProviderExecutionSnapshot(raw.snapshot);
    if (!authority || snapshot.model.adapterKind === "fake" || snapshot.model.modelClass !== "image" || !snapshot.model.image ||
      snapshot.connectionId !== authority.connectionId || snapshot.providerModelId !== authority.providerModelId ||
      snapshot.credentialId !== authority.credentialId || snapshot.credentialVersionId !== authority.credentialVersionId) return null;
    return { version: 1, policyVersion: Number(raw.policyVersion), authority, snapshot,
      parameters: normalizeImageGenerationParameters(raw.parameters, snapshot.model.image, snapshot.model.upstreamModelId) };
  } catch { return null; }
}

export function createImageModelRoleResolver(
  db: AdmissionPrisma & Pick<Prisma.TransactionClient, "systemModelPolicy">,
  loadRole = loadInstallationImageProviderRole
) {
  return {
    async resolve(): Promise<AcceptedImageGenerationPlan | null> {
      const policy = await db.systemModelPolicy.findUnique({
        select: { imageProviderModelId: true, imageParamsJson: true, version: true }, where: { id: "installation" }
      });
      if (!policy?.imageProviderModelId) return null;
      try {
        const role = await loadRole(db, { providerModelId: policy.imageProviderModelId });
        const model = role.configuration;
        if (!model.image) return null;
        const parameters = normalizeImageGenerationParameters({ ...model.defaultParams,
          ...(policy.imageParamsJson as Record<string, unknown>) }, model.image, model.upstreamModelId);
        return { version: 1, policyVersion: policy.version, authority: role.authority, snapshot: role.snapshot, parameters };
      } catch (error) {
        if (error instanceof ProviderAdmissionError || error instanceof Error && error.message === "image_parameters_invalid") return null;
        throw error;
      }
    }
  };
}
