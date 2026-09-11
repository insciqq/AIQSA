import { IMAGE_FAILURE_PARAMETERS, type ImageFailureDiagnostic } from "../../contracts/imageGeneration";

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const categoryByCode: Readonly<Record<string, ImageFailureDiagnostic["category"]>> = {
  invalid_parameter: "invalid_parameter", invalid_argument: "invalid_parameter", unsupported_parameter: "invalid_parameter",
  invalid_value: "invalid_parameter", content_policy_violation: "safety", safety_violation: "safety", moderation_blocked: "safety",
  insufficient_quota: "quota", insufficient_credits: "quota", rate_limit_exceeded: "rate_limit",
  invalid_api_key: "authorization", authentication_error: "authorization", permission_denied: "authorization",
  service_unavailable: "upstream_unavailable", overloaded_error: "upstream_unavailable"
};

/** Never project provider messages or metadata. Only exact known codes and field names survive. */
export function imageFailureDiagnostic(text: string, httpStatus: number): ImageFailureDiagnostic {
  const fallback: ImageFailureDiagnostic = { category: httpStatus === 402 ? "quota" : httpStatus === 429 ? "rate_limit"
    : httpStatus === 401 || httpStatus === 403 ? "authorization" : httpStatus >= 500 ? "upstream_unavailable" : "unknown" };
  if (Buffer.byteLength(text) > 32 * 1024) return fallback;
  try {
    const body: unknown = JSON.parse(text);
    if (!record(body) || !record(body.error)) return fallback;
    let error = body.error;
    // Some routed providers put a structured JSON error in this bounded field.
    if (record(error.metadata) && typeof error.metadata.raw === "string" && error.metadata.raw.length <= 16 * 1024) {
      try {
        const nested: unknown = JSON.parse(error.metadata.raw);
        if (record(nested) && record(nested.error)) error = { ...error, ...nested.error };
      } catch { /* Opaque messages carry no diagnostic authority. */ }
    }
    const code = typeof error.code === "string" ? error.code : error.type;
    const category = typeof code === "string" && Object.hasOwn(categoryByCode, code) ? categoryByCode[code]! : fallback.category;
    const rawParameter = error.param ?? error.parameter;
    const parameter = (IMAGE_FAILURE_PARAMETERS as readonly unknown[]).includes(rawParameter)
      ? rawParameter as NonNullable<ImageFailureDiagnostic["parameter"]> : undefined;
    return { category, ...(parameter ? { parameter } : {}) };
  } catch { return fallback; }
}
