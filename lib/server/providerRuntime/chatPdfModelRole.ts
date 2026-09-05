import type { Prisma } from "@prisma/client";
import {
  type AdmissionPrisma, loadInstallationAnswerProviderRole, ProviderAdmissionError
} from "./admission";
import { systemModelRoleEligible } from "./systemModelCapabilities";
import {
  SYSTEM_MODEL_ABSENT, SYSTEM_MODEL_UNAVAILABLE, type SystemModelRoleResolution
} from "./systemModelRole";

export function createChatPdfModelRoleResolver(
  db: AdmissionPrisma & Pick<Prisma.TransactionClient, "systemModelPolicy">,
  loadRole = loadInstallationAnswerProviderRole
) {
  return {
    async resolve(): Promise<SystemModelRoleResolution> {
      const policy = await db.systemModelPolicy.findUnique({
        select: { chatPdfProviderModelId: true, chatPdfReasoningEffort: true, version: true },
        where: { id: "installation" }
      });
      if (!policy?.chatPdfProviderModelId) return { ok: false, code: SYSTEM_MODEL_ABSENT };
      try {
        const role = await loadRole(db, { providerModelId: policy.chatPdfProviderModelId });
        const effort = policy.chatPdfReasoningEffort;
        if (!systemModelRoleEligible(role, "vision") || effort !== null &&
          (role.snapshot.model.capabilities.reasoning !== true ||
            !role.snapshot.model.capabilities.reasoningEfforts?.includes(effort))) {
          return { ok: false, code: SYSTEM_MODEL_UNAVAILABLE };
        }
        return { ok: true, credentialScope: "installation", policyVersion: policy.version,
          providerModelId: policy.chatPdfProviderModelId, reasoningEffort: effort, role };
      } catch (error) {
        if (error instanceof ProviderAdmissionError) return { ok: false, code: SYSTEM_MODEL_UNAVAILABLE };
        throw error;
      }
    }
  };
}
