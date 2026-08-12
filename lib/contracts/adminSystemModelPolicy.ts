import type { AdminModelDefaultCandidate } from "./adminModelPolicy";

export type AdminSystemModelCandidate = AdminModelDefaultCandidate & {
  defaultReasoningEffort: string | null;
  reasoningEfforts: string[];
};

export type AdminSystemModelPolicyCatalog = {
  candidates: AdminSystemModelCandidate[];
  policy: {
    reasoningEffort: string | null;
    systemModel: (AdminSystemModelCandidate & { available: boolean }) | null;
    updatedAt: string;
    updatedBy: { displayName: string; id: string } | null;
    version: number;
  };
};

export type AdminSystemModelPolicyResponse = {
  systemModelPolicy: AdminSystemModelPolicyCatalog;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 &&
    value.length <= maxLength && !/[\u0000-\u001f\u007f]/u.test(value);
}

function candidate(value: unknown): value is AdminSystemModelCandidate {
  if (!record(value) || !boundedText(value.connectionDisplayName, 160) ||
    !boundedText(value.connectionId, 256) || !boundedText(value.displayName, 160) ||
    !boundedText(value.id, 256) || !Array.isArray(value.reasoningEfforts) ||
    value.reasoningEfforts.length > 16 ||
    !value.reasoningEfforts.every((effort) => boundedText(effort, 32)) ||
    new Set(value.reasoningEfforts).size !== value.reasoningEfforts.length) return false;
  return value.defaultReasoningEffort === null ||
    boundedText(value.defaultReasoningEffort, 32) &&
    value.reasoningEfforts.includes(value.defaultReasoningEffort);
}

export function decodeAdminSystemModelPolicyResponse(
  value: unknown
): AdminSystemModelPolicyResponse | null {
  if (!record(value) || !record(value.systemModelPolicy)) return null;
  const catalog = value.systemModelPolicy;
  if (!Array.isArray(catalog.candidates) || !catalog.candidates.every(candidate) ||
    !record(catalog.policy)) return null;
  const policy = catalog.policy;
  const reasoningEffort = policy.reasoningEffort;
  const systemModel = policy.systemModel;
  const updatedBy = policy.updatedBy;
  if ((systemModel !== null && (!record(systemModel) || !candidate(systemModel) ||
      typeof (systemModel as Record<string, unknown>).available !== "boolean")) ||
    (systemModel === null && reasoningEffort !== null) ||
    (updatedBy !== null && (!record(updatedBy) || !boundedText(updatedBy.displayName, 160) ||
      !boundedText(updatedBy.id, 256))) ||
    !(reasoningEffort === null || boundedText(reasoningEffort, 32)) ||
    typeof policy.updatedAt !== "string" || !Number.isFinite(Date.parse(policy.updatedAt)) ||
    !Number.isSafeInteger(policy.version) || Number(policy.version) < 1) return null;

  return {
    systemModelPolicy: {
      candidates: catalog.candidates,
      policy: {
        reasoningEffort: reasoningEffort as string | null,
        systemModel: systemModel as
          (AdminSystemModelCandidate & { available: boolean }) | null,
        updatedAt: policy.updatedAt,
        updatedBy: updatedBy as { displayName: string; id: string } | null,
        version: Number(policy.version)
      }
    }
  };
}
