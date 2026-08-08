import type { Prisma } from "@prisma/client";
import {
  type AdmissionPrisma,
  loadInstallationAnswerProviderRole,
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
      credentialScope: "installation";
      ok: true;
      policyVersion: number;
      providerModelId: string;
      role: ProviderAdmissionRole;
    }>;

type SystemModelRolePrisma = AdmissionPrisma & Pick<
  Prisma.TransactionClient,
  "systemModelPolicy"
>;

type RoleLoader = typeof loadInstallationAnswerProviderRole;

export function createSystemModelRoleResolver(
  db: SystemModelRolePrisma,
  dependencies: Readonly<{ loadRole?: RoleLoader }> = {}
) {
  const loadRole = dependencies.loadRole ?? loadInstallationAnswerProviderRole;
  return {
    async resolve(): Promise<SystemModelRoleResolution> {
      const policy = await db.systemModelPolicy.findUnique({
        select: {
          providerModelId: true,
          version: true
        },
        where: { id: "installation" }
      });
      if (!policy?.providerModelId) {
        return { code: SYSTEM_MODEL_ABSENT, ok: false };
      }
      try {
        const role = await loadRole(db, {
          providerModelId: policy.providerModelId
        });
        return {
          credentialScope: "installation",
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
