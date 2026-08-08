import type { Prisma } from "@prisma/client";
import {
  type AdmissionPrisma,
  loadUnentitledAnswerProviderRole,
  ProviderAdmissionError,
  type ProviderAdmissionRole
} from "./admission";

export const SYSTEM_MODEL_ABSENT = "system_model_absent" as const;
export const SYSTEM_MODEL_UNAVAILABLE = "system_model_unavailable" as const;

export type SystemModelRoleResolution =
  | Readonly<{
      code: typeof SYSTEM_MODEL_ABSENT | typeof SYSTEM_MODEL_UNAVAILABLE;
      ok: false;
    }>
  | Readonly<{
      credentialOwnerUserId: string;
      ok: true;
      policyVersion: number;
      providerModelId: string;
      role: ProviderAdmissionRole;
    }>;

type SystemModelRolePrisma = AdmissionPrisma & Pick<
  Prisma.TransactionClient,
  "systemModelPolicy"
>;

type RoleLoader = typeof loadUnentitledAnswerProviderRole;

export function createSystemModelRoleResolver(
  db: SystemModelRolePrisma,
  dependencies: Readonly<{ loadRole?: RoleLoader }> = {}
) {
  const loadRole = dependencies.loadRole ?? loadUnentitledAnswerProviderRole;
  return {
    async resolve(): Promise<SystemModelRoleResolution> {
      const policy = await db.systemModelPolicy.findUnique({
        select: {
          providerModelId: true,
          updatedByUserId: true,
          version: true
        },
        where: { id: "installation" }
      });
      if (!policy?.providerModelId) {
        return { code: SYSTEM_MODEL_ABSENT, ok: false };
      }
      if (!policy.updatedByUserId) {
        return { code: SYSTEM_MODEL_UNAVAILABLE, ok: false };
      }

      try {
        const role = await loadRole(db, {
          providerModelId: policy.providerModelId,
          userId: policy.updatedByUserId
        });
        return {
          credentialOwnerUserId: policy.updatedByUserId,
          ok: true,
          policyVersion: policy.version,
          providerModelId: policy.providerModelId,
          role
        };
      } catch (error) {
        if (error instanceof ProviderAdmissionError) {
          return { code: SYSTEM_MODEL_UNAVAILABLE, ok: false };
        }
        throw error;
      }
    }
  };
}
