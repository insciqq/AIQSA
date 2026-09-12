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

export type ChatPdfProcessingMode = "prefer_chat_model" | "use_pdf_reader" | "read_page_images";
export type ChatPdfFallbackMethod = "pdf_reader" | "page_images";

export class ChatPdfPolicyUnavailableError extends Error {
  readonly code = "pdf_processing_configuration_incomplete" as const;
  constructor() {
    super("pdf_processing_configuration_incomplete");
    this.name = "ChatPdfPolicyUnavailableError";
  }
}

export function isChatPdfPolicyUnavailableError(error: unknown): error is ChatPdfPolicyUnavailableError {
  // The process-wide PDF resolver can outlive the route module that catches it.
  return typeof error === "object" && error !== null &&
    "name" in error && error.name === "ChatPdfPolicyUnavailableError" &&
    "code" in error && error.code === "pdf_processing_configuration_incomplete";
}

export type ChatPdfRouteAdmission = Readonly<{
  authority: SearchProbeBinding | null;
  fallbackMethod?: ChatPdfFallbackMethod;
  mode?: ChatPdfProcessingMode;
  answerModelName?: string;
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
  fallbackMethod?: ChatPdfFallbackMethod;
  mode?: ChatPdfProcessingMode;
  system: SystemModelRoleResolution | null;
  policyVersion?: number;
  strictPolicy?: boolean;
}>): ChatPdfRouteAdmission {
  const answer = input.answer;
  const mode = input.mode ?? "prefer_chat_model";
  const policyBinding = input.strictPolicy || input.mode ? { mode, fallbackMethod: input.fallbackMethod ?? "page_images" as const,
    answerModelName: answer.snapshot.modelDisplayName } : {};
  if (mode === "prefer_chat_model" && answer.snapshot.model.capabilities.nativePdfInput) return {
    authority: answer.authority ?? null, policyVersion: input.policyVersion ?? null,
    ...policyBinding,
    route: "direct_pdf", snapshot: answer.snapshot
  };
  const method = mode === "use_pdf_reader" ? "pdf_reader" : mode === "read_page_images" ? "page_images"
    : input.fallbackMethod ?? "page_images";
  if (input.system?.ok && (method === "pdf_reader"
    ? input.system.role.snapshot.model.capabilities.nativePdfInput === true
    : input.system.role.verifiedVisionInput === true)) {
    return {
      authority: input.system.role.authority ?? null,
      ...policyBinding,
      policyVersion: input.system.policyVersion,
      route: method === "pdf_reader" ? "system_pdf" : "system_vision",
      snapshot: applySystemModelReasoningEffort(input.system.role.snapshot, input.system.reasoningEffort)
    };
  }
  if (input.strictPolicy || input.mode) throw new ChatPdfPolicyUnavailableError();
  // Historical resolver calls retain their old routes; new admission is always explicit.
  if (mode === "prefer_chat_model" && answer.verifiedVisionInput === true) return {
    authority: answer.authority ?? null, policyVersion: null, ...policyBinding,
    route: "selected_model_vision", snapshot: answer.snapshot
  };
  return { authority: null, policyVersion: null, ...policyBinding, route: "local_text", snapshot: null };
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
      const policy = await db.systemModelPolicy.findUnique({
        select: { chatPdfFallbackMethod: true, chatPdfProcessingMode: true, version: true },
        where: { id: "installation" }
      });
      const mode = policy?.chatPdfProcessingMode === "USE_PDF_READER" ? "use_pdf_reader" :
        policy?.chatPdfProcessingMode === "READ_PAGE_IMAGES" ? "read_page_images" : "prefer_chat_model";
      const fallbackMethod = policy?.chatPdfFallbackMethod === "PDF_READER" ? "pdf_reader" : "page_images";
      if (!policy) throw new ChatPdfPolicyUnavailableError();
      if (mode === "prefer_chat_model" && answer.snapshot.model.capabilities.nativePdfInput) {
        return resolveChatPdfRoute({ answer, fallbackMethod, mode, policyVersion: policy.version, strictPolicy: true, system: null });
      }
      const resolved = await system.resolve(mode === "use_pdf_reader" ? "pdf_reader" :
        mode === "read_page_images" ? "page_images" : fallbackMethod);
      // The installation save is optimistic and affects future admissions.
      // Re-read under the admission transaction before freezing this result.
      return resolveChatPdfRoute({ answer, fallbackMethod, mode, policyVersion: policy.version, strictPolicy: true, system: resolved?.ok &&
        resolved.policyVersion === policy?.version ? resolved : null });
    }
  };
}
