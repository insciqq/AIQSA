import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { ChatPdfRoute } from "../../contracts/chatPdfPreparation";
import type { ProviderAdmissionRole } from "../providerRuntime/admission";
import {
  applySystemModelReasoningEffort,
  type SystemModelRoleResolution
} from "../providerRuntime/systemModelRole";
import { createChatPdfModelRoleResolver } from "../providerRuntime/chatPdfModelRole";
import type { ProviderExecutionSnapshot } from "../providers/runtimeFactory";
import type { SearchProbeBinding } from "../search/probeBinding";

export type ChatPdfRouteAdmission = Readonly<{
  authority: SearchProbeBinding | null;
  policyVersion: number | null;
  route: ChatPdfRoute;
  snapshot: ProviderExecutionSnapshot | null;
}>;

export type ChatPdfAttachmentAdmission = ChatPdfRouteAdmission & Readonly<{
  attachmentId: string;
  byteSize: number;
  pageCount: number | null;
  sourceChecksum: string;
}>;

export function resolveChatPdfRoute(input: Readonly<{
  answer: ProviderAdmissionRole;
  system: SystemModelRoleResolution | null;
  systemAllowed: boolean;
}>): ChatPdfRouteAdmission {
  const answer = input.answer;
  if (answer.snapshot.model.capabilities.nativePdfInput) return {
    authority: answer.authority ?? null, policyVersion: null,
    route: "direct_pdf", snapshot: answer.snapshot
  };
  if (input.systemAllowed && input.system?.ok && input.system.role.verifiedVisionInput === true) {
    return {
      authority: input.system.role.authority ?? null,
      policyVersion: input.system.policyVersion,
      route: "system_vision",
      snapshot: applySystemModelReasoningEffort(input.system.role.snapshot, input.system.reasoningEffort)
    };
  }
  if (answer.verifiedVisionInput === true) return {
    authority: answer.authority ?? null, policyVersion: null,
    route: "selected_model_vision", snapshot: answer.snapshot
  };
  return { authority: null, policyVersion: null, route: "local_text", snapshot: null };
}

export function chatPdfFingerprint(value: unknown): string {
  const canonical = (entry: unknown): string => {
    if (Array.isArray(entry)) return `[${entry.map(canonical).join(",")}]`;
    if (typeof entry === "object" && entry !== null) return `{${Object.entries(entry)
      .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
    return JSON.stringify(entry) ?? "null";
  };
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function createChatPdfRouteResolver(db: Prisma.TransactionClient) {
  const system = createChatPdfModelRoleResolver(db);
  return {
    async resolve(answer: ProviderAdmissionRole): Promise<ChatPdfRouteAdmission> {
      if (answer.snapshot.model.capabilities.nativePdfInput) {
        return resolveChatPdfRoute({ answer, system: null, systemAllowed: false });
      }
      const policy = await db.systemModelPolicy.findUnique({
        select: { chatPdfPreparationAllowed: true, version: true },
        where: { id: "installation" }
      });
      const resolved = policy?.chatPdfPreparationAllowed ? await system.resolve() : null;
      // The installation save is optimistic and affects future admissions.
      // Re-read under the admission transaction before freezing this result.
      return resolveChatPdfRoute({ answer, system: resolved?.ok &&
        resolved.policyVersion === policy?.version ? resolved : null,
        systemAllowed: policy?.chatPdfPreparationAllowed === true });
    }
  };
}
