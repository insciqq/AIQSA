import type { Prisma } from "@prisma/client";
import type { AdmissionPrisma } from "./admission";
import { createVisionModelRoleResolver } from "./visionModelRole";
import { applySystemModelReasoningEffort } from "./systemModelRole";
import { searchProbeBinding, type SearchProbeBinding } from "../search/probeBinding";
import { normalizeProviderExecutionSnapshot, type ProviderExecutionSnapshot } from "../providers/runtimeFactory";
import { supportsConfiguredReasoningEffort } from "../providers/providerModelCapabilities";

export type AcceptedVisionAnalysisPlan = Readonly<
  | { version: 1; available: false; code: "vision_model_absent" | "vision_model_unavailable" }
  | { version: 1; available: true; policyVersion: number; authority: SearchProbeBinding;
      snapshot: ProviderExecutionSnapshot; reasoningEffort: string | null; verifiedVisionInput: true }
>;
export type AvailableVisionAnalysisPlan = Extract<AcceptedVisionAnalysisPlan, { available: true }>;

export function decodeAcceptedVisionAnalysisPlan(value: unknown): AcceptedVisionAnalysisPlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) return null;
  if (raw.available === false) return Object.keys(raw).every(key => ["version", "available", "code"].includes(key)) &&
    (raw.code === "vision_model_absent" || raw.code === "vision_model_unavailable")
    ? { version: 1, available: false, code: raw.code } : null;
  if (raw.available !== true || Object.keys(raw).some(key => !["version", "available", "policyVersion", "authority", "snapshot", "reasoningEffort", "verifiedVisionInput"].includes(key)) ||
    !Number.isSafeInteger(raw.policyVersion) || Number(raw.policyVersion) < 1 || raw.verifiedVisionInput !== true ||
    !(raw.reasoningEffort === null || typeof raw.reasoningEffort === "string")) return null;
  try {
    const authority = searchProbeBinding(raw.authority);
    const snapshot = normalizeProviderExecutionSnapshot(raw.snapshot);
    if (!authority || snapshot.model.adapterKind === "fake" || snapshot.model.modelClass !== "answer" ||
      !snapshot.model.capabilities.vision || snapshot.connectionId !== authority.connectionId ||
      snapshot.providerModelId !== authority.providerModelId || snapshot.credentialId !== authority.credentialId ||
      snapshot.credentialVersionId !== authority.credentialVersionId || raw.reasoningEffort !== null &&
      !supportsConfiguredReasoningEffort(snapshot.model, snapshot.providerFamily, raw.reasoningEffort)) return null;
    return { version: 1, available: true, policyVersion: Number(raw.policyVersion), authority, snapshot,
      reasoningEffort: raw.reasoningEffort, verifiedVisionInput: true };
  } catch { return null; }
}

export function createVisionAnalysisPlanResolver(db: AdmissionPrisma & Pick<Prisma.TransactionClient, "systemModelPolicy">,
  resolve = createVisionModelRoleResolver(db).resolve) {
  return async (): Promise<AcceptedVisionAnalysisPlan> => {
    const resolution = await resolve();
    if (!resolution.ok) return { version: 1, available: false,
      code: resolution.code === "system_model_absent" ? "vision_model_absent" : "vision_model_unavailable" };
    const plan = decodeAcceptedVisionAnalysisPlan({ version: 1, available: true, policyVersion: resolution.policyVersion,
      authority: resolution.role.authority, snapshot: applySystemModelReasoningEffort(resolution.role.snapshot, resolution.reasoningEffort),
      reasoningEffort: resolution.reasoningEffort, verifiedVisionInput: resolution.role.verifiedVisionInput });
    return plan ?? { version: 1, available: false, code: "vision_model_unavailable" };
  };
}
