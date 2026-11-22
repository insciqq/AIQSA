import type { Prisma } from "@prisma/client";
import { ProviderConfigurationError } from "../providers/providerConfiguration";
import {
  type AdmissionPrisma,
  type EmbeddingProviderAdmissionRole,
  loadInstallationEmbeddingProviderRole,
  ProviderAdmissionError
} from "./admission";

/**
 * The installation's past-chat embedding role (`SystemModelPolicy.embeddingProviderModelId`), resolved on the
 * connection's installation credential. Only this column is read: the role never borrows another role's model
 * (`agent_docs/PROVIDERS.md`). "Not set", "set but unusable" and a usable model stay three distinct answers, and an
 * unusable one names a content-free code instead of being replaced.
 */

/** A model counts as an embedding model only when installation admission accepts it: the embedding model class with
 * its embedding configuration, and an available check with embedding evidence on the exact active connection, model
 * revision and default credential version (`loadInstallationEmbeddingProviderRole`). */
export type EmbeddingModelAdmission =
  | Readonly<{ ok: true; role: EmbeddingProviderAdmissionRole }>
  | Readonly<{ ok: false; code: string }>;

export type EmbeddingModelRoleResolution =
  | Readonly<{ kind: "unset"; policyVersion: number | null }>
  | Readonly<{ kind: "unavailable"; providerModelId: string; code: string; policyVersion: number }>
  | Readonly<{ kind: "model"; providerModelId: string; policyVersion: number; role: EmbeddingProviderAdmissionRole }>;

export type EmbeddingRoleLoader = typeof loadInstallationEmbeddingProviderRole;

export type EmbeddingModelRolePrisma = AdmissionPrisma & Pick<Prisma.TransactionClient, "systemModelPolicy">;

const CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;

/** Admit one model for the role; an admission or configuration refusal becomes its code, anything else is thrown. */
export async function admitInstallationEmbeddingModel(
  db: AdmissionPrisma,
  providerModelId: string,
  loadRole: EmbeddingRoleLoader = loadInstallationEmbeddingProviderRole
): Promise<EmbeddingModelAdmission> {
  try {
    return { ok: true, role: await loadRole(db, { providerModelId }) };
  } catch (error) {
    if (error instanceof ProviderAdmissionError) {
      return { code: CODE_PATTERN.test(error.code) ? error.code : "model_not_available", ok: false };
    }
    if (error instanceof ProviderConfigurationError ||
      error instanceof Error && error.message === "provider_execution_snapshot_invalid") {
      return { code: "model_not_available", ok: false };
    }
    throw error;
  }
}

export type EmbeddingModelRoleResolver = Readonly<{
  /** The assigned model id, or null when the role is not set. */
  assigned(): Promise<string | null>;
  resolve(): Promise<EmbeddingModelRoleResolution>;
}>;

export function createEmbeddingModelRoleResolver(
  db: EmbeddingModelRolePrisma,
  dependencies: Readonly<{ loadRole?: EmbeddingRoleLoader }> = {}
): EmbeddingModelRoleResolver {
  const loadRole = dependencies.loadRole ?? loadInstallationEmbeddingProviderRole;
  const readPolicy = () => db.systemModelPolicy.findUnique({
    select: { embeddingProviderModelId: true, version: true },
    where: { id: "installation" }
  });

  return Object.freeze({
    async assigned() {
      return (await readPolicy())?.embeddingProviderModelId ?? null;
    },
    async resolve(): Promise<EmbeddingModelRoleResolution> {
      const policy = await readPolicy();
      const providerModelId = policy?.embeddingProviderModelId ?? null;
      if (!policy || providerModelId === null) return { kind: "unset", policyVersion: policy?.version ?? null };
      const admitted = await admitInstallationEmbeddingModel(db, providerModelId, loadRole);
      return admitted.ok
        ? { kind: "model", policyVersion: policy.version, providerModelId, role: admitted.role }
        : { code: admitted.code, kind: "unavailable", policyVersion: policy.version, providerModelId };
    }
  });
}
