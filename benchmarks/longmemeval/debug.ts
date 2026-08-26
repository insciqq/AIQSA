import { parseMemorySecret } from
  "../../lib/server/memory/explicit/secretParser";

const MAX_DEBUG_VALUE_DEPTH = 64;

/** Last-line defense for ignored opt-in benchmark diagnostics. Runtime Memory
 * boundaries should already reject secret egress; this projection makes sure
 * a recognized format can never be serialized into a debug artifact. */
export function redactLongMemEvalDebugArtifact(
  value: unknown,
  depth = 0
): unknown {
  if (depth > MAX_DEBUG_VALUE_DEPTH) {
    throw new Error("longmemeval_debug_value_too_deep");
  }
  if (typeof value === "string") {
    const parsed = parseMemorySecret(value);
    return parsed.containsSecret
      ? `[REDACTED:${parsed.findings.join("+")}]`
      : value;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map((entry) => redactLongMemEvalDebugArtifact(entry, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      redactLongMemEvalDebugArtifact(entry, depth + 1)
    ]));
  }
  throw new Error("longmemeval_debug_value_invalid");
}
