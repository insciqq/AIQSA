export type AdminModelDefaultCandidate = {
  connectionDisplayName: string;
  connectionId: string;
  displayName: string;
  id: string;
};

export type AdminModelPolicyCatalog = {
  candidates: AdminModelDefaultCandidate[];
  policy: {
    defaultModel: (AdminModelDefaultCandidate & { available: boolean }) | null;
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

function candidate(value: unknown): value is AdminModelDefaultCandidate {
  return record(value) && boundedText(value.connectionDisplayName, 160) &&
    boundedText(value.connectionId, 256) && boundedText(value.displayName, 160) &&
    boundedText(value.id, 256);
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
    (updatedBy !== null && (!record(updatedBy) || !boundedText(updatedBy.displayName, 160) ||
      !boundedText(updatedBy.id, 256))) ||
    typeof policy.updatedAt !== "string" || !Number.isFinite(Date.parse(policy.updatedAt)) ||
    !Number.isSafeInteger(policy.version) ||
    Number(policy.version) < 1) return null;

  return {
    modelPolicy: {
      candidates: catalog.candidates,
      policy: {
        defaultModel: defaultModel as (AdminModelDefaultCandidate & { available: boolean }) | null,
        updatedAt: policy.updatedAt,
        updatedBy: updatedBy as { displayName: string; id: string } | null,
        version: Number(policy.version)
      }
    }
  };
}
