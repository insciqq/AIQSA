import type { Prisma } from "@prisma/client";
import {
  type AdmissionPrisma, loadInstallationAnswerProviderRole, ProviderAdmissionError
} from "./admission";
import { systemModelRoleEligible } from "./systemModelCapabilities";
import { supportsConfiguredReasoningEffort } from "../providers/providerModelCapabilities";
import {
  SYSTEM_MODEL_ABSENT, SYSTEM_MODEL_UNAVAILABLE, type SystemModelRoleResolution
} from "./systemModelRole";

export function createChatTitleModelRoleResolver(
  db: AdmissionPrisma & Pick<Prisma.TransactionClient, "systemModelPolicy">,
  loadRole = loadInstallationAnswerProviderRole
) {
  return {
    async resolve(): Promise<SystemModelRoleResolution> {
      const policy = await db.systemModelPolicy.findUnique({
        select: { chatTitleProviderModelId: true, chatTitleReasoningEffort: true, version: true },
        where: { id: "installation" }
      });
      if (!policy?.chatTitleProviderModelId) return { ok: false, code: SYSTEM_MODEL_ABSENT };
      try {
        const role = await loadRole(db, { providerModelId: policy.chatTitleProviderModelId });
        const effort = policy.chatTitleReasoningEffort;
        if (!systemModelRoleEligible(role, "chat_titles") || effort !== null &&
          !supportsConfiguredReasoningEffort(role.snapshot.model, role.snapshot.providerFamily, effort)) {
          return { ok: false, code: SYSTEM_MODEL_UNAVAILABLE };
        }
        return { ok: true, credentialScope: "installation", policyVersion: policy.version,
          providerModelId: policy.chatTitleProviderModelId, reasoningEffort: effort, role };
      } catch (error) {
        if (error instanceof ProviderAdmissionError) return { ok: false, code: SYSTEM_MODEL_UNAVAILABLE };
        throw error;
      }
    }
  };
}
