import providerErrorCodes from "../observability/providerErrorCodes.json";

/**
 * The provider's own error identity (`error.code`, else `error.type`, else
 * Google's `error.status`), reduced to a reviewed vocabulary for telemetry:
 * an identity outside it is `other`, and a failure whose body named none has
 * none. Only this bounded value leaves a decoder, never the provider's
 * message, parameters or body. It never decides retries or user wording.
 */
export const PROVIDER_ERROR_CODE_OTHER = "other";

const known = new Set<string>(providerErrorCodes);
const identityPattern = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;
const PROPERTY = "providerErrorCode";

function ownValue(value: unknown, key: string): unknown {
  try {
    if (value === null || typeof value !== "object") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function reviewed(value: string): string | null {
  if (!identityPattern.test(value)) return null;
  const normalized = value.toLowerCase();
  return known.has(normalized) ? normalized : null;
}

/** The reviewed identity of one provider error record, `other` for an unknown one, null when it names none. */
export function providerErrorCodeOf(detail: unknown): string | null {
  let named = false;
  for (const key of ["code", "type", "status"]) {
    const value = ownValue(detail, key);
    // A numeric `code` is an HTTP status (Google, OpenRouter), kept separately;
    // `type: "error"` names a streamed event, not the failure.
    if (typeof value !== "string" || value.length === 0 || /^\d+$/u.test(value) || key === "type" && value === "error") continue;
    named = true;
    const code = reviewed(value);
    if (code !== null) return code;
  }
  return named ? PROVIDER_ERROR_CODE_OTHER : null;
}

/** A value as telemetry may carry it: a reviewed identity or `other`; anything else is none. */
export function reviewedProviderErrorCode(value: unknown): string | null {
  if (value === PROVIDER_ERROR_CODE_OTHER) return value;
  return typeof value === "string" && known.has(value) ? value : null;
}

/** The identity a decoder marked on a failure, or null. */
export function providerErrorCode(error: unknown): string | null {
  return reviewedProviderErrorCode(ownValue(error, PROPERTY));
}

/**
 * Names the identity on the failure as a non-enumerable own data property,
 * so spreads, `Object.assign` and JSON never copy or print it; a value that
 * cannot carry it (a primitive, a frozen value) stays unmarked. The first
 * identity marked wins.
 */
export function markProviderErrorCode<T>(error: T, code: string | null): T {
  const value = reviewedProviderErrorCode(code);
  if (value === null || typeof error !== "object" || error === null || providerErrorCode(error) !== null) return error;
  try {
    Object.defineProperty(error, PROPERTY, { configurable: true, value });
  } catch {
    // A frozen foreign value keeps its identity unmarked.
  }
  return error;
}

/** Marks the failure with the identity of one provider error record. */
export function markProviderErrorDetail<T>(error: T, detail: unknown): T {
  return markProviderErrorCode(error, providerErrorCodeOf(detail));
}

/** Carries a decoded failure's identity over to the error that re-wraps it. */
export function inheritProviderErrorCode<T>(error: T, source: unknown): T {
  return markProviderErrorCode(error, providerErrorCode(source));
}

/**
 * The identity of a provider JSON error body (`{ "error": { ... } }`, a
 * streamed error event carrying its fields at the top, or Google's
 * one-element array), parsed in memory and never retained.
 */
export function providerErrorCodeOfBody(text: string): string | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  const value = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
  const error = ownValue(value, "error");
  if (error !== null && typeof error === "object" && !Array.isArray(error)) return providerErrorCodeOf(error);
  return ownValue(value, "type") === "error" ? providerErrorCodeOf(value) : null;
}
