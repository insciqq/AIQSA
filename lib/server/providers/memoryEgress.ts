import { memorySha256 } from "../memory/persistence/lexical";
import type { ProviderRunRequest } from "./types";

export type MemoryEgressDestinationSnapshot = Readonly<{
  adapterKind?: string;
  baseId?: string;
  displayName: string;
  fingerprint?: string;
  kind: "knowledge" | "mcp" | "search";
  modelId?: string | null;
  optionId?: string;
  provider?: string;
  serverId?: string;
  version: 1;
}>;

export function requestHasHostedSearchCapability(request: ProviderRunRequest): boolean {
  return (request.searchPolicy?.strategyId !== undefined &&
    request.searchPolicy.strategyId !== "perplexity-tool-search") ||
    (request.searchPlan?.options.some((option) =>
      option.adapterKind === "answer_provider_hosted") ?? false);
}

export function requestHasServerExternalTools(request: ProviderRunRequest): boolean {
  return (request.tools ?? []).some((tool) => tool.capability !== "memory");
}

export function memoryEgressDestinations(
  request: ProviderRunRequest
): MemoryEgressDestinationSnapshot[] {
  const destinations: MemoryEgressDestinationSnapshot[] = [];
  for (const server of request.toolMode === "none" ? [] : request.mcp?.servers ?? []) {
    destinations.push({
      displayName: server.externalAccountLabel
        ? `${server.serverName} · ${server.externalAccountLabel}`
        : server.serverName,
      fingerprint: server.fingerprint,
      kind: "mcp",
      serverId: server.serverId,
      version: 1
    });
  }
  for (const option of request.searchPlan?.options ?? []) {
    destinations.push({
      adapterKind: option.adapterKind,
      displayName: option.displayName ?? "Search",
      kind: "search",
      modelId: option.providerModelId ?? option.modelId,
      optionId: option.optionId,
      provider: option.provider,
      version: 1
    });
  }
  if (!request.searchPlan && request.searchPolicy) {
    destinations.push({
      displayName: `Search · ${request.searchPolicy.provider}`,
      kind: "search",
      modelId: request.searchPolicy.modelId,
      optionId: request.searchPolicy.strategyId,
      provider: request.searchPolicy.provider,
      version: 1
    });
  }
  for (const baseId of request.toolMode === "none"
    ? []
    : request.knowledgePlan?.baseIds ?? []) {
    destinations.push({
      baseId,
      displayName: "Knowledge base",
      kind: "knowledge",
      version: 1
    });
  }
  return destinations
    .filter((destination, index, values) =>
      values.findIndex((candidate) =>
        memorySha256(candidate) === memorySha256(destination)) === index)
    .slice(0, 16);
}

export function memoryEgressDestinationFingerprint(
  destination: MemoryEgressDestinationSnapshot
): string {
  return memorySha256(destination);
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
    knowledgePlanHash: memorySha256(request.knowledgePlan ?? null),
    memoryPlanHash: memorySha256({
      action: request.memoryActionPlan ?? null,
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
      plan: request.searchPlan ?? null,
      policy: request.searchPolicy ?? null,
      strategy: request.searchStrategy ?? null
    }),
    transportHash: memorySha256({
      chatId: request.chatId,
      forceNonStreaming: request.forceNonStreaming ?? false,
      modelCapabilities: request.modelCapabilities,
      parallelToolCalls: request.parallelToolCalls ?? false,
      previousProviderResponseId: request.previousProviderResponseId ?? null,
      toolChoice: request.toolChoice ?? null,
      toolMode: request.toolMode ?? null
    }),
    toolsHash: memorySha256(request.tools ?? []),
    version: 3
  } as const;
}
