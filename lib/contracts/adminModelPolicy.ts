import {
  MCP_AUTO_DISCOVERY_TIMEOUT_LIMITS,
  isMcpAutoDiscoveryOutputTokens,
  MCP_RUN_PLAN_LIMITS
} from "./mcp";

export type AdminModelDefaultCandidate = {
  connectionDisplayName: string;
  connectionId: string;
  displayName: string;
  id: string;
};

export type AdminDefaultAnswerModelCandidate = AdminModelDefaultCandidate & {
  defaultReasoningEffort: string | null;
  reasoningEfforts: string[];
};

export type AdminModelPolicyCatalog = {
  candidates: AdminDefaultAnswerModelCandidate[];
  policy: {
    defaultModel: (AdminDefaultAnswerModelCandidate & { available: boolean }) | null;
    reasoningEffort: string | null;
    mcpAutoDiscoveryTimeoutSeconds: number;
    mcpAutoDiscoveryMaxOutputTokens: number;
    maxMcpToolsPerDiscovery: number;
    maxToolCalls: number;
    maxToolRounds: number;
    updatedAt: string;
    updatedBy: { displayName: string; id: string } | null;
    version: number;
  };
};

export type AdminModelPolicyResponse = {
  modelPolicy: AdminModelPolicyCatalog;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 &&
    value.length <= maxLength && !/[\u0000-\u001f\u007f]/u.test(value);
}

function candidate(value: unknown): value is AdminDefaultAnswerModelCandidate {
  return record(value) && boundedText(value.connectionDisplayName, 160) &&
    boundedText(value.connectionId, 256) && boundedText(value.displayName, 160) &&
    boundedText(value.id, 256) && Array.isArray(value.reasoningEfforts) &&
    value.reasoningEfforts.length <= 32 &&
    value.reasoningEfforts.every((effort) => boundedText(effort, 32)) &&
    new Set(value.reasoningEfforts).size === value.reasoningEfforts.length &&
    (value.defaultReasoningEffort === null ||
      boundedText(value.defaultReasoningEffort, 32) &&
      value.reasoningEfforts.includes(value.defaultReasoningEffort));
}

export function decodeAdminModelPolicyResponse(
  value: unknown
): AdminModelPolicyResponse | null {
  if (!record(value) || !record(value.modelPolicy)) return null;
  const catalog = value.modelPolicy;
  if (!Array.isArray(catalog.candidates) || !catalog.candidates.every(candidate) ||
    !record(catalog.policy)) return null;
  const policy = catalog.policy;
  const defaultModel = policy.defaultModel;
  const updatedBy = policy.updatedBy;
  if ((defaultModel !== null && (!record(defaultModel) || !candidate(defaultModel) ||
      typeof (defaultModel as Record<string, unknown>).available !== "boolean")) ||
    !(policy.reasoningEffort === null || boundedText(policy.reasoningEffort, 32)) ||
    (defaultModel === null && policy.reasoningEffort !== null) ||
    (updatedBy !== null && (!record(updatedBy) || !boundedText(updatedBy.displayName, 160) ||
      !boundedText(updatedBy.id, 256))) ||
    !isMcpAutoDiscoveryOutputTokens(policy.mcpAutoDiscoveryMaxOutputTokens) ||
    !Number.isSafeInteger(policy.mcpAutoDiscoveryTimeoutSeconds) ||
    Number(policy.mcpAutoDiscoveryTimeoutSeconds) <
      MCP_AUTO_DISCOVERY_TIMEOUT_LIMITS.minSeconds ||
    Number(policy.mcpAutoDiscoveryTimeoutSeconds) >
      MCP_AUTO_DISCOVERY_TIMEOUT_LIMITS.maxSeconds ||
    !Number.isSafeInteger(policy.maxMcpToolsPerDiscovery) ||
    Number(policy.maxMcpToolsPerDiscovery) < 1 ||
    Number(policy.maxMcpToolsPerDiscovery) > MCP_RUN_PLAN_LIMITS.maxTools ||
    !Number.isSafeInteger(policy.maxToolCalls) || Number(policy.maxToolCalls) < 1 ||
    !Number.isSafeInteger(policy.maxToolRounds) || Number(policy.maxToolRounds) < 1 ||
    typeof policy.updatedAt !== "string" || !Number.isFinite(Date.parse(policy.updatedAt)) ||
    !Number.isSafeInteger(policy.version) ||
    Number(policy.version) < 1) return null;

  return {
    modelPolicy: {
      candidates: catalog.candidates,
      policy: {
        defaultModel: defaultModel as AdminModelPolicyCatalog["policy"]["defaultModel"],
        reasoningEffort: policy.reasoningEffort as string | null,
        mcpAutoDiscoveryTimeoutSeconds: Number(policy.mcpAutoDiscoveryTimeoutSeconds),
        mcpAutoDiscoveryMaxOutputTokens: Number(policy.mcpAutoDiscoveryMaxOutputTokens),
        maxMcpToolsPerDiscovery: Number(policy.maxMcpToolsPerDiscovery),
        maxToolCalls: Number(policy.maxToolCalls),
        maxToolRounds: Number(policy.maxToolRounds),
        updatedAt: policy.updatedAt,
        updatedBy: updatedBy as { displayName: string; id: string } | null,
        version: Number(policy.version)
      }
    }
  };
}
