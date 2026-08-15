import { memorySha256 } from "../memory/persistence/lexical";
import type { ProviderRunRequest } from "./types";

export function requestHasHostedSearchCapability(request: ProviderRunRequest): boolean {
  return request.searchPlan.options.some((option) =>
    option.adapterKind === "answer_provider_hosted");
}

export function requestHasServerExternalTools(request: ProviderRunRequest): boolean {
  return (request.tools ?? []).some((tool) => tool.capability !== "memory");
}

/** Hash-only evidence for the exact provider/tool-planning request. The
 * returned structure itself is never persisted; the receipt stores its hash. */
export function memoryEgressRequestEvidence(request: ProviderRunRequest) {
  return {
    attachmentIdsHash: memorySha256(request.attachmentIds),
    attachmentsHash: memorySha256(request.attachments.map((attachment) => ({
      base64DataHash: attachment.base64Data
        ? memorySha256(attachment.base64Data)
        : null,
      byteSize: attachment.byteSize,
      dataUrlHash: attachment.dataUrl ? memorySha256(attachment.dataUrl) : null,
      extractedTextHash: attachment.extractedText
        ? memorySha256(attachment.extractedText)
        : null,
      fileName: attachment.fileName,
      id: attachment.id,
      kind: attachment.kind,
      metadataHash: memorySha256(attachment.metadata),
      mimeType: attachment.mimeType,
      status: attachment.status
    }))),
    context: (request.context?.messages ?? []).map((message) => ({
      contentHash: memorySha256(message.content),
      id: message.id,
      role: message.role
    })),
    currentContentHash: memorySha256(request.content),
    knowledgePlanHash: memorySha256(request.knowledgePlan),
    memoryPlanHash: memorySha256({
      actionTools: request.memoryActionTools ?? null,
      history: request.memoryHistoryTool ?? null
    }),
    mcpSnapshotHash: memorySha256(request.mcp ?? null),
    modelId: request.modelId,
    paramsHash: memorySha256(request.params),
    personalContextHash: request.personalContext
      ? memorySha256(request.personalContext.text)
      : null,
    promptHash: memorySha256(request.prompt),
    provider: request.provider,
    providerToolMessagesHash: memorySha256(request.providerToolMessages ?? []),
    searchHash: memorySha256({
      plan: request.searchPlan
    }),
    transportHash: memorySha256({
      chatId: request.chatId,
      forceNonStreaming: request.forceNonStreaming ?? false,
      modelCapabilities: request.modelCapabilities,
      parallelToolCalls: request.parallelToolCalls ?? false,
      previousProviderResponseId: request.previousProviderResponseId ?? null,
      toolChoice: request.toolChoice ?? null,
      toolMode: request.toolMode
    }),
    toolsHash: memorySha256(request.tools ?? []),
    version: 3
  } as const;
}
