import type { Prisma } from "@prisma/client";
import { normalizeImageGenerationParameters, type ImageGenerationParameters } from "../../contracts/imageGeneration";
import type { ImageModelUnavailableReason } from "../../contracts/imageModels";
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

/** Personal runs use the initiating user's effective choice; Project runs use
 * the administrator default and never read personal preferences. */
export type ImageModelScope = Readonly<{ kind: "personal"; userId: string }> | Readonly<{ kind: "project" }>;

export type ImageModelResolution =
  | Readonly<{ ok: true; plan: AcceptedImageGenerationPlan; providerModelId: string; source: "organization" | "personal" }>
  | Readonly<{ ok: false; reason: "not_configured"; providerModelId: null; source: "organization" }>
  | Readonly<{ ok: false; reason: ImageModelUnavailableReason; providerModelId: string; source: "organization" | "personal" }>;

export type ImageModelPublicationResolution =
  | Readonly<{ ok: true; plan: AcceptedImageGenerationPlan }>
  | Readonly<{ ok: false; reason: ImageModelUnavailableReason }>;

type ImageRoleDatabase = AdmissionPrisma & Pick<Prisma.TransactionClient, "systemModelPolicy" | "userSettings">;

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

/** The same model, authority revision, policy version and parameters. */
export function sameAcceptedImageGenerationPlan(left: AcceptedImageGenerationPlan, right: AcceptedImageGenerationPlan): boolean {
  const sorted = (parameters: ImageGenerationParameters) => JSON.stringify(Object.entries(parameters).sort(([a], [b]) => a.localeCompare(b)));
  return left.version === right.version && left.policyVersion === right.policyVersion &&
    (Object.keys(left.authority) as (keyof SearchProbeBinding)[]).every((key) => left.authority[key] === right.authority[key]) &&
    Object.keys(left.authority).length === Object.keys(right.authority).length &&
    sorted(left.parameters) === sorted(right.parameters);
}

/** Admission failures only say why; a published model never borrows another
 * model, key or parameter set. */
async function unavailableReason(db: AdmissionPrisma, providerModelId: string, error: ProviderAdmissionError): Promise<ImageModelUnavailableReason> {
  if (error.code.startsWith("credential_")) return "credential_unavailable";
  const model = await db.providerModel.findUnique({ where: { id: providerModelId }, select: {
    enabled: true, activeVersion: true, activatedAt: true, modelClass: true,
    connection: { select: { enabled: true, activeVersion: true, activatedAt: true } }
  } });
  return model?.enabled && model.activeVersion > 0 && model.activatedAt && model.modelClass === "image" &&
    model.connection.enabled && model.connection.activeVersion > 0 && model.connection.activatedAt
    ? "verification_required" : "model_unavailable";
}

export function createImageModelRoleResolver(
  db: ImageRoleDatabase,
  loadRole = loadInstallationImageProviderRole
) {
  /** One published model with the administrator's parameters over its defaults. */
  async function resolvePublished(
    publication: Readonly<{ providerModelId: string; paramsJson: unknown }>, policyVersion: number
  ): Promise<ImageModelPublicationResolution> {
    try {
      const role = await loadRole(db, { providerModelId: publication.providerModelId });
      const model = role.configuration;
      if (!model.image) return { ok: false, reason: "model_unavailable" };
      let parameters: ImageGenerationParameters;
      try {
        parameters = normalizeImageGenerationParameters({ ...model.defaultParams,
          ...(publication.paramsJson as Record<string, unknown>) }, model.image, model.upstreamModelId);
      } catch { return { ok: false, reason: "parameters_invalid" }; }
      return { ok: true, plan: { version: 1, policyVersion, authority: role.authority, snapshot: role.snapshot, parameters } };
    } catch (error) {
      if (error instanceof ProviderAdmissionError) {
        return { ok: false, reason: await unavailableReason(db, publication.providerModelId, error) };
      }
      throw error;
    }
  }

  async function resolveFor(scope: ImageModelScope): Promise<ImageModelResolution> {
    const publication = { select: { providerModelId: true, paramsJson: true } } as const;
    const [policy, settings] = await Promise.all([
      db.systemModelPolicy.findUnique({ where: { id: "installation" },
        select: { version: true, imagePublication: publication } }),
      scope.kind === "personal"
        ? db.userSettings.findUnique({ where: { userId: scope.userId }, select: { imagePublication: publication } })
        : Promise.resolve(null)
    ]);
    const personal = settings?.imagePublication ?? null;
    const target = personal ?? policy?.imagePublication ?? null;
    const source = personal ? "personal" as const : "organization" as const;
    if (!policy || !target) return { ok: false, reason: "not_configured", providerModelId: null, source: "organization" };
    const resolved = await resolvePublished(target, policy.version);
    return resolved.ok
      ? { ok: true, plan: resolved.plan, providerModelId: target.providerModelId, source }
      : { ok: false, reason: resolved.reason, providerModelId: target.providerModelId, source };
  }

  return {
    resolveFor,
    resolvePublished,
    /** The administrator default, as before per-user choices; callers that
     * know the run scope use `resolveFor`. */
    async resolve(): Promise<AcceptedImageGenerationPlan | null> {
      const resolved = await resolveFor({ kind: "project" });
      return resolved.ok ? resolved.plan : null;
    }
  };
}
