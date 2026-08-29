import type { Prisma } from "@prisma/client";
import {
  type AdmissionPrisma,
  loadInstallationRerankerProviderRole,
  ProviderAdmissionError,
  type RerankerProviderAdmissionRole
} from "./admission";
import {
  approvedRerankerDeploymentByProviderModelId,
  approvedRerankerDeployments
} from "../admin/providers/approvedRerankers";

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
      routes?: readonly Readonly<{
        providerModelId: string;
        role: RerankerProviderAdmissionRole;
      }>[];
      selectedProviderModelId?: string;
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
      const selectedProviderModelId = policy.rerankerProviderModelId;
      const orderedProviderModelIds = approvedRerankerDeploymentByProviderModelId(
        selectedProviderModelId
      )
        ? [
            selectedProviderModelId,
            ...approvedRerankerDeployments
              .map(({ providerModelId }) => providerModelId)
              .filter((providerModelId) => providerModelId !== selectedProviderModelId)
          ]
        : [selectedProviderModelId];
      const routes: Array<{
        providerModelId: string;
        role: RerankerProviderAdmissionRole;
      }> = [];
      for (const providerModelId of orderedProviderModelIds) {
        try {
          routes.push({
            providerModelId,
            role: await loadRole(db, { providerModelId })
          });
        } catch (error) {
          if (!(error instanceof ProviderAdmissionError)) throw error;
        }
      }
      if (routes[0]) {
        return {
          credentialScope: "installation",
          ok: true,
          policyVersion: policy.version,
          providerModelId: routes[0].providerModelId,
          role: routes[0].role,
          routes: Object.freeze(routes),
          selectedProviderModelId
        };
      }
      return {
        code: RERANKER_MODEL_UNAVAILABLE,
        ok: false,
        selectedProviderModelId
      };
    }
  });
}
