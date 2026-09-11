import type { Prisma } from "@prisma/client";
import {
  type AdmissionPrisma, loadInstallationAnswerProviderRole, ProviderAdmissionError
} from "./admission";
import { systemModelRoleEligible } from "./systemModelCapabilities";
import { supportsConfiguredReasoningEffort } from "../providers/providerModelCapabilities";
import {
  SYSTEM_MODEL_ABSENT, SYSTEM_MODEL_UNAVAILABLE, type SystemModelRoleResolution
} from "./systemModelRole";

export function createChatPdfModelRoleResolver(
  db: AdmissionPrisma & Pick<Prisma.TransactionClient, "systemModelPolicy">,
  loadRole = loadInstallationAnswerProviderRole
) {
  return {
    async resolve(method: "pdf_reader" | "page_images" = "page_images"): Promise<SystemModelRoleResolution> {
      const policy = await db.systemModelPolicy.findUnique({
        select: { chatPdfProviderModelId: true, chatPdfReasoningEffort: true,
          chatPdfNativeProviderModelId: true, chatPdfNativeReasoningEffort: true, version: true },
        where: { id: "installation" }
      });
      const providerModelId = method === "pdf_reader" ? policy?.chatPdfNativeProviderModelId : policy?.chatPdfProviderModelId;
      if (!policy || !providerModelId) return { ok: false, code: SYSTEM_MODEL_ABSENT };
      try {
        const role = await loadRole(db, { providerModelId });
        const effort = (method === "pdf_reader" ? policy.chatPdfNativeReasoningEffort : policy.chatPdfReasoningEffort) ?? null;
        if (!systemModelRoleEligible(role, method === "pdf_reader" ? "direct_pdf" : "vision") || effort !== null &&
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
