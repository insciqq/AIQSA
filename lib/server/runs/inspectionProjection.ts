import type {
  ModelRunInspectionMcpServer,
  ModelRunInspectionParameter,
  ModelRunInspectionProjection
} from "@/lib/contracts/runs";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeLabel(value: unknown, maxLength = 256): string | null {
  if (typeof value !== "string") return null;
  const label = value.trim();
  return label && label.length <= maxLength && !/[\u0000-\u001f\u007f]/u.test(label)
    ? label
    : null;
}

function safeCount(value: unknown, max: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, max)
    : 0;
}

function firstFiniteNumber(record: Record<string, unknown>, names: readonly string[]): number | null {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function acceptedParameters(value: unknown): ModelRunInspectionParameter[] {
  if (!isRecord(value)) return [];
  const parameters: ModelRunInspectionParameter[] = [];
  const maxOutputTokens = firstFiniteNumber(value, [
    "maxOutputTokens",
    "maxTokens",
    "max_output_tokens",
    "max_completion_tokens",
    "max_tokens"
  ]);
  if (maxOutputTokens !== null) {
    parameters.push({ name: "max_output_tokens", value: maxOutputTokens });
  }
  if (typeof value.temperature === "number" && Number.isFinite(value.temperature)) {
    parameters.push({ name: "temperature", value: value.temperature });
  }
  for (const name of ["background", "stream"] as const) {
    if (typeof value[name] === "boolean") parameters.push({ name, value: value[name] });
  }
  if (isRecord(value.reasoning)) {
    const effort = safeLabel(value.reasoning.effort, 80);
    const mode = safeLabel(value.reasoning.mode, 80);
    if (effort) parameters.push({ name: "reasoning_effort", value: effort });
    if (mode) parameters.push({ name: "reasoning_mode", value: mode });
  }
  return parameters;
}

function projectedSearchBindings(value: unknown): {
  bindings: { displayName: string }[];
  mode: ModelRunInspectionProjection["searchMode"];
} {
  if (!isRecord(value) || !Array.isArray(value.options) ||
    (value.mode !== "all_selected" && value.mode !== "model_choice")) {
    return { bindings: [], mode: null };
  }
  return {
    bindings: value.options.slice(0, 3).map((option) => {
      const displayName = isRecord(option) ? safeLabel(option.displayName) : null;
      return { displayName: displayName ?? "Search source" };
    }),
    mode: value.mode
  };
}

function projectedMcpServers(value: unknown): ModelRunInspectionMcpServer[] {
  if (!isRecord(value) || !Array.isArray(value.servers) || !Array.isArray(value.tools)) return [];
  const tools: unknown[] = value.tools;
  return value.servers.slice(0, 16).flatMap((server) => {
    if (!isRecord(server)) return [];
    const name = safeLabel(server.serverName);
    if (!name) return [];
    const serverId = safeLabel(server.serverId, 512);
    const externalAccountLabel = server.externalAccountLabel === null
      ? null
      : safeLabel(server.externalAccountLabel);
    const toolNames = tools.flatMap((tool): string[] => {
      if (!isRecord(tool)) return [];
      const belongsToServer = serverId && tool.serverId === serverId;
      const sameSafeName = !serverId && tool.serverName === name;
      if (!belongsToServer && !sameSafeName) return [];
      const toolName = safeLabel(tool.originalName);
      return toolName ? [toolName] : [];
    }).slice(0, 128);
    return [{
      externalAccountLabel,
      name,
      toolNames: [...new Set(toolNames)]
    }];
  });
}

function firstPartyTools(request: Record<string, unknown>): string[] {
  const tools: string[] = [];
  if (isRecord(request.memoryActionTools) && request.memoryActionTools.version === "model-driven-v2") {
    tools.push("Memory actions");
  }
  if (isRecord(request.memoryHistoryTool)) tools.push("Memory search");
  return tools;
}

export function projectModelRunInspection(input: Readonly<{
  acceptedAt: Date;
  answerMessageId: string | null;
  normalizedRequest: unknown;
}>): ModelRunInspectionProjection {
  const request = isRecord(input.normalizedRequest) ? input.normalizedRequest : {};
  const attachmentIds = Array.isArray(request.attachmentIds)
    ? request.attachmentIds.flatMap((value) => typeof value === "string" ? [value] : [])
    : [];
  const context = isRecord(request.context) ? request.context : null;
  const knowledgePlan = isRecord(request.knowledgePlan) ? request.knowledgePlan : null;
  const personalContext = isRecord(request.personalContext) ? request.personalContext : null;
  const search = projectedSearchBindings(request.searchPlan);
  return {
    acceptedAt: input.acceptedAt.toISOString(),
    answerMessageId: input.answerMessageId,
    attachmentCount: Math.min(new Set(attachmentIds).size, 20),
    branchMessageCount: Math.min(
      context && Array.isArray(context.messages) ? context.messages.length : 0,
      10_000
    ),
    firstPartyTools: firstPartyTools(request),
    knowledgeBaseCount: Math.min(
      knowledgePlan && Array.isArray(knowledgePlan.baseIds)
        ? knowledgePlan.baseIds.length
        : 0,
      3
    ),
    mcpServers: projectedMcpServers(request.mcp),
    memoryContextItemCount: safeCount(personalContext?.itemCount, 50),
    parameters: acceptedParameters(request.params),
    searchBindings: search.bindings,
    searchMode: search.mode,
    toolMode: request.toolMode === "none" ? "none" : "auto"
  };
}
