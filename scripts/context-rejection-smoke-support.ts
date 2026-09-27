/**
 * Opt-in diagnostics for smoke:context-rejection. Pure and side-effect free:
 * it reduces a body the smoke captured in memory to bounded, digit-masked
 * facts, which are printed only for an unclassified outcome and never stored.
 */

const LOCAL_CODE = /^[a-z][a-z0-9_]{0,80}$/u;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** A string or number with every digit replaced by "#", bounded. */
export function maskedDiagnostic(value: unknown, maxLength: number): string | null {
  return typeof value === "string" || typeof value === "number"
    ? String(value).replace(/\d/gu, "#").slice(0, maxLength) : null;
}

function errorOf(value: unknown): Record<string, unknown> | null {
  const item = record(Array.isArray(value) && value.length === 1 ? value[0] : value);
  const response = record(item?.response);
  return record(response?.error) ?? record(item?.error) ?? (item?.type === "error" ? item : null);
}

/** The provider error a captured JSON body or SSE stream carries, newest event first. */
export function providerErrorFromBody(body: string): Record<string, unknown> | null {
  try {
    return errorOf(JSON.parse(body));
  } catch { /* An SSE stream follows. */ }
  for (const frame of body.split(/\r?\n\r?\n/u).reverse()) {
    const data = frame.split(/\r?\n/u).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart()).join("\n");
    if (!data.trim()) continue;
    try {
      const error = errorOf(JSON.parse(data));
      if (error) return error;
    } catch { /* Not a JSON event. */ }
  }
  return null;
}

/**
 * Gemini Interactions answers an oversized input with its generic envelope
 * (observed 2026-09-27): HTTP 400 `{"error":{"code":"invalid_request",
 * "message":"Invalid input received."}}`, without status, details or counts.
 * A rejected tool schema gets the same answer, so the transport never
 * classifies it as a context-length rejection and Gemini gets no rebuild on
 * this API; the check reports it as unclassifiable instead of failing.
 */
export function isGeminiGenericOverflowEnvelope(httpStatus: number | null, body: string): boolean {
  if (httpStatus !== 400) return false;
  const error = providerErrorFromBody(body);
  return error?.code === "invalid_request" && error.message === "Invalid input received.";
}

export type ContextRejectionDiagnostics = Readonly<{
  /** The transport's reviewed identity or code on the thrown error. */
  identity: string | null;
  /** The local snake_case failure code the adapter threw, if any. */
  localCode: string | null;
  message: string | null;
  providerCode: string | null;
  providerStatus: string | null;
}>;

/** What an unclassified outcome looked like: the transport identity and the
 * provider's own code and sentence, digits masked and bounded. */
export function contextRejectionDiagnostics(error: unknown, body: string): ContextRejectionDiagnostics {
  const own = record(error);
  const localMessage = error instanceof Error ? error.message : null;
  const providerError = body ? providerErrorFromBody(body) : null;
  return {
    identity: maskedDiagnostic(typeof own?.code === "string" ? own.code : null, 64),
    localCode: localMessage !== null && LOCAL_CODE.test(localMessage) ? localMessage : null,
    message: maskedDiagnostic(providerError?.message, 240),
    providerCode: maskedDiagnostic(providerError?.code, 64),
    providerStatus: maskedDiagnostic(providerError?.status ?? providerError?.type, 64)
  };
}
