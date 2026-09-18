import { ADMIN_PROVIDER_CAPABILITY_CHECKS, ADMIN_PROVIDER_CAPABILITY_REASONS, type AdminProviderCapabilityCheck } from "./adminProviders";

const reasons = ["publisher_unknown", "native_unavailable", "native_incompatible", "verification_required"] as const;
const stages = ["catalog", "modelAccess", "capabilities", "publication"] as const;
const codes = [...reasons, ...ADMIN_PROVIDER_CAPABILITY_REASONS, "capability_mismatch", "authority_changed"] as const;
export type NativeRouteAdoptionDiagnostic = {
  version: 1;
  stage: (typeof stages)[number];
  code: (typeof codes)[number];
  servingMode: "automatic";
  provider?: string;
  httpStatus?: number;
  missing: Array<AdminProviderCapabilityCheck | "maxOutputTokens">;
  previouslyUnverified: AdminProviderCapabilityCheck[];
};
export type NativeRouteAdoptionStatus = {
  reason: (typeof reasons)[number];
  diagnostic?: NativeRouteAdoptionDiagnostic;
};

/** This projection never accepts raw exception messages, payloads or key IDs. */
export function decodeNativeRouteAdoptionDiagnostic(value: unknown): NativeRouteAdoptionDiagnostic | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const fields = ["version", "stage", "code", "servingMode", "provider", "httpStatus", "missing", "previouslyUnverified"];
  const known = (values: unknown, allowed: readonly string[]) => Array.isArray(values) &&
    values.length <= allowed.length && new Set(values).size === values.length && values.every((item) => allowed.includes(item));
  if (Object.keys(v).some((field) => !fields.includes(field)) || v.version !== 1 || v.servingMode !== "automatic" ||
    !(stages as readonly unknown[]).includes(v.stage) || !(codes as readonly unknown[]).includes(v.code) ||
    !known(v.missing, [...ADMIN_PROVIDER_CAPABILITY_CHECKS, "maxOutputTokens"]) ||
    !known(v.previouslyUnverified, ADMIN_PROVIDER_CAPABILITY_CHECKS) ||
    v.provider !== undefined && (typeof v.provider !== "string" || !/^[a-z0-9][a-z0-9/_-]{0,95}$/u.test(v.provider)) ||
    v.httpStatus !== undefined && (!Number.isSafeInteger(v.httpStatus) || Number(v.httpStatus) < 400 || Number(v.httpStatus) > 599)) return null;
  return { version: 1, stage: v.stage as NativeRouteAdoptionDiagnostic["stage"], code: v.code as NativeRouteAdoptionDiagnostic["code"],
    servingMode: "automatic", missing: [...v.missing as NativeRouteAdoptionDiagnostic["missing"]],
    previouslyUnverified: [...v.previouslyUnverified as AdminProviderCapabilityCheck[]],
    ...(typeof v.provider === "string" ? { provider: v.provider } : {}),
    ...(typeof v.httpStatus === "number" ? { httpStatus: v.httpStatus } : {}) };
}

export function nativeRouteAdoptionStatus(reason: unknown, evidence: unknown): NativeRouteAdoptionStatus | undefined {
  if (!(reasons as readonly unknown[]).includes(reason)) return undefined;
  const diagnostic = decodeNativeRouteAdoptionDiagnostic(evidence);
  return { reason: reason as NativeRouteAdoptionStatus["reason"], ...(diagnostic ? { diagnostic } : {}) };
}
