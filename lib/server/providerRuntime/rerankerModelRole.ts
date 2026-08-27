import type { Prisma } from "@prisma/client";
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

export function createRerankerModelRoleResolver(
  db: RerankerModelRolePrisma,
  dependencies: Readonly<{ loadRole?: RoleLoader }> = {}
) {
  const loadRole = dependencies.loadRole ?? loadInstallationRerankerProviderRole;
  return Object.freeze({
    async resolve(): Promise<RerankerModelRoleResolution> {
      const policy = await db.systemModelPolicy.findUnique({
        select: { rerankerProviderModelId: true, version: true },
        where: { id: "installation" }
      });
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
