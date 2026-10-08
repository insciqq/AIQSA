import { ProviderStreamSafetyError } from "./streamSafety";

/**
 * Why an answer stream ended before its completion event: it ended or broke
 * mid-frame (`truncated`), the provider sent an `error` event
 * (`error_event`) or a `response.failed` terminal (`response_failed`), or
 * the connection was reset while the body was read (`reset`). A closed,
 * content-free vocabulary for telemetry and the dropped-round decision.
 */
export type ProviderStreamDrop = "truncated" | "error_event" | "response_failed" | "reset";

const drops = new Set<string>(["truncated", "error_event", "response_failed", "reset"]);

// Socket codes a reader reports when an established connection breaks
// (Node's http client and undici); never inferred from message text.
const resetCodes = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED", "UND_ERR_SOCKET", "ERR_STREAM_PREMATURE_CLOSE"]);

function ownValue(value: unknown, key: string): unknown {
  try {
    if (value === null || typeof value !== "object") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

/** Names the drop on the failure itself, as a non-enumerable own data
 * property; a value that cannot carry it stays unmarked. */
export function markProviderStreamDrop<T>(error: T, drop: ProviderStreamDrop): T {
  if (typeof error === "object" && error !== null && providerStreamDrop(error) === null) {
    try {
      Object.defineProperty(error, "streamDrop", { configurable: true, value: drop });
    } catch {
      // A frozen foreign value keeps its identity unmarked.
    }
  }
  return error;
}

export function providerStreamDrop(error: unknown): ProviderStreamDrop | null {
  const drop = ownValue(error, "streamDrop");
  return typeof drop === "string" && drops.has(drop) ? drop as ProviderStreamDrop : null;
}

/** A body read that failed because the connection broke, never a Stop, a
 * deadline or a stream safety limit, is a `reset` drop. */
export function markProviderStreamReset<T>(error: T, signal?: AbortSignal): T {
  if (signal?.aborted || error instanceof ProviderStreamSafetyError) return error;
  const code = ownValue(error, "code");
  const causeCode = ownValue(ownValue(error, "cause"), "code");
  return typeof code === "string" && resetCodes.has(code) || typeof causeCode === "string" && resetCodes.has(causeCode)
    ? markProviderStreamDrop(error, "reset")
    : error;
}
