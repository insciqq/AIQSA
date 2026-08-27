import { Prisma } from "@prisma/client";
import {
  DEFAULT_RERANKER_MODEL_PRESET_ID,
  rerankerModelPresets
} from "../../domain/rerankerModels";
import { normalizeProviderModelConfiguration } from "../providers/providerConfiguration";
import {
  type AdmissionPrisma,
  loadInstallationRerankerProviderRole,
  ProviderAdmissionError,
  type RerankerProviderAdmissionRole
} from "./admission";

export const RERANKER_MODEL_ABSENT = "reranker_model_absent" as const;
export const RERANKER_MODEL_UNAVAILABLE = "reranker_model_unavailable" as const;

export type RerankerModelRoleResolution =
  | Readonly<{
      code: typeof RERANKER_MODEL_ABSENT | typeof RERANKER_MODEL_UNAVAILABLE;
      ok: false;
      selectedProviderModelId: string | null;
    }>
  | Readonly<{
      credentialScope: "installation";
      ok: true;
      policyVersion: number;
      providerModelId: string;
      role: RerankerProviderAdmissionRole;
    }>;

type RerankerModelRolePrisma = AdmissionPrisma & Pick<
  Prisma.TransactionClient,
  "systemModelPolicy"
>;

type RoleLoader = typeof loadInstallationRerankerProviderRole;

const defaultRerankerUpstreamModelId = rerankerModelPresets.find(
  (preset) => preset.id === DEFAULT_RERANKER_MODEL_PRESET_ID
)!.upstreamModelId;

/** Adopt the code-owned default reranker exactly once for an installation
 * whose reranker role has never been explicitly saved or cleared. Adoption
 * requires a usable materialized default deployment on an OpenRouter
 * connection with an installation-default credential; it keeps
 * `rerankerConfiguredAt` NULL so a later explicit administrator save remains
 * distinguishable, and the guarded write never overwrites a concurrent
 * manual choice. */
async function adoptInstallationDefaultReranker(
  db: RerankerModelRolePrisma,
  loadRole: RoleLoader,
  policyVersion: number
): Promise<Readonly<{
  policyVersion: number;
  providerModelId: string;
  role: RerankerProviderAdmissionRole;
}> | null> {
  const candidates = await db.providerModel.findMany({
    orderBy: [
      { connection: { displayName: "asc" } },
      { displayName: "asc" },
      { id: "asc" }
    ],
    select: { activeConfig: true, id: true },
    where: {
      activeConfig: { not: Prisma.DbNull },
      activeVersion: { gt: 0 },
      connection: {
        activeConfig: { not: Prisma.DbNull },
        activeVersion: { gt: 0 },
        enabled: true,
        family: "openrouter"
      },
      enabled: true,
      modelClass: "reranker"
    }
  });
  for (const candidate of candidates) {
    let isDefaultDeployment = false;
    try {
      const configuration = normalizeProviderModelConfiguration(
        candidate.activeConfig
      );
      isDefaultDeployment =
        configuration.modelClass === "reranker" &&
        configuration.adapterKind === "openrouter_rerank" &&
        configuration.upstreamModelId === defaultRerankerUpstreamModelId;
    } catch {
      continue;
    }
    if (!isDefaultDeployment) continue;
    let role: RerankerProviderAdmissionRole;
    try {
      role = await loadRole(db, { providerModelId: candidate.id });
    } catch (error) {
      if (error instanceof ProviderAdmissionError) continue;
      throw error;
    }
    const adopted = await db.systemModelPolicy.updateMany({
      data: {
        rerankerProviderModelId: candidate.id,
        version: { increment: 1 }
      },
      where: {
        id: "installation",
        rerankerConfiguredAt: null,
        rerankerProviderModelId: null,
        version: policyVersion
      }
    });
    if (adopted.count !== 1) return null;
    return {
      policyVersion: policyVersion + 1,
      providerModelId: candidate.id,
      role
    };
  }
  return null;
}

export function createRerankerModelRoleResolver(
  db: RerankerModelRolePrisma,
  dependencies: Readonly<{ loadRole?: RoleLoader }> = {}
) {
  const loadRole = dependencies.loadRole ?? loadInstallationRerankerProviderRole;

  async function readPolicy() {
    return db.systemModelPolicy.findUnique({
      select: {
        rerankerConfiguredAt: true,
        rerankerProviderModelId: true,
        version: true
      },
      where: { id: "installation" }
    });
  }

  return Object.freeze({
    async resolve(): Promise<RerankerModelRoleResolution> {
      let policy = await readPolicy();
      if (policy && policy.rerankerProviderModelId === null &&
        policy.rerankerConfiguredAt === null) {
        const adoption = await adoptInstallationDefaultReranker(
          db,
          loadRole,
          policy.version
        );
        if (adoption) {
          return {
            credentialScope: "installation",
            ok: true,
            ...adoption
          };
        }
        // A concurrent explicit save may have won the guarded write; resolve
        // whatever selection is now durable instead of adopting again.
        policy = await readPolicy();
      }
      if (!policy?.rerankerProviderModelId) {
        return {
          code: RERANKER_MODEL_ABSENT,
          ok: false,
          selectedProviderModelId: null
        };
      }
      try {
        return {
          credentialScope: "installation",
          ok: true,
          policyVersion: policy.version,
          providerModelId: policy.rerankerProviderModelId,
          role: await loadRole(db, {
            providerModelId: policy.rerankerProviderModelId
          })
        };
      } catch (error) {
        if (error instanceof ProviderAdmissionError) {
          return {
            code: RERANKER_MODEL_UNAVAILABLE,
            ok: false,
            selectedProviderModelId: policy.rerankerProviderModelId
          };
        }
        throw error;
      }
    }
  });
}
