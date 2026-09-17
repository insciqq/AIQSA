import type { Prisma } from "@prisma/client";
import { type AdmissionPrisma, type loadInstallationAnswerProviderRole } from "./admission";
import { resolveInstallationStructuredUtilityRole, type SystemModelRoleResolution } from "./systemModelRole";

/** No live System Model fallback: an explicit Memory clear or unavailable
 * assignment must remain authoritative for every new Memory admission. */
export function createMemoryUtilityModelRoleResolver(
  db: AdmissionPrisma & Pick<Prisma.TransactionClient, "memoryUtilityModelPolicy">,
  dependencies: Readonly<{ loadRole?: typeof loadInstallationAnswerProviderRole }> = {}
) {
  return {
    async resolve(): Promise<SystemModelRoleResolution> {
      const policy = await db.memoryUtilityModelPolicy.findUnique({
        select: { providerModelId: true, reasoningEffort: true, version: true },
        where: { id: "installation" }
      });
      return resolveInstallationStructuredUtilityRole(db, policy, dependencies.loadRole);
    }
  };
}
