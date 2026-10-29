import type { Prisma } from "@prisma/client";
import {
  type AdmissionPrisma, loadInstallationAnswerProviderRole, ProviderAdmissionError
} from "./admission";
import { systemModelRoleEligible } from "./systemModelCapabilities";
import { supportsConfiguredReasoningEffort } from "../providers/providerModelCapabilities";
import {
  SYSTEM_MODEL_ABSENT, SYSTEM_MODEL_UNAVAILABLE, type SystemModelRoleResolution
} from "./systemModelRole";

export function createMcpGuardModelRoleResolver(
  db: AdmissionPrisma & Pick<Prisma.TransactionClient, "systemModelPolicy">,
  loadRole = loadInstallationAnswerProviderRole
) {
  return {
    async resolve(): Promise<SystemModelRoleResolution> {
      const policy = await db.systemModelPolicy.findUnique({
        select: { mcpGuardProviderModelId: true, mcpGuardReasoningEffort: true, version: true },
        where: { id: "installation" }
      });
      const providerModelId = policy?.mcpGuardProviderModelId;
      if (!policy || !providerModelId) return { ok: false, code: SYSTEM_MODEL_ABSENT };
      try {
        const role = await loadRole(db, { providerModelId });
        const effort = policy.mcpGuardReasoningEffort ?? null;
        if (!systemModelRoleEligible(role, "mcp_guard") || effort !== null &&
          !supportsConfiguredReasoningEffort(role.snapshot.model, role.snapshot.providerFamily, effort)) {
          return { ok: false, code: SYSTEM_MODEL_UNAVAILABLE };
        }
        return { ok: true, credentialScope: "installation", policyVersion: policy.version,
          providerModelId, reasoningEffort: effort, role };
      } catch (error) {
        if (error instanceof ProviderAdmissionError) return { ok: false, code: SYSTEM_MODEL_UNAVAILABLE };
        throw error;
      }
    }
  };
}
