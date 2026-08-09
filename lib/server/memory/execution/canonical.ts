import { createHash } from "node:crypto";

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalize(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("memory_execution_non_json_value");
    return Object.is(value, -0) ? 0 : value;
  }
  if (
    typeof value === "undefined" ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    typeof value === "bigint"
  ) {
    throw new Error("memory_execution_non_json_value");
  }
  if (ancestors.has(value)) throw new Error("memory_execution_non_json_value");

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => canonicalize(entry, ancestors));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("memory_execution_non_json_value");
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, entry]) => [key, canonicalize(entry, ancestors)])
    );
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalMemoryExecutionJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, new Set()));
}

export function memoryExecutionSha256(value: unknown): string {
  return createHash("sha256")
    .update(canonicalMemoryExecutionJson(value), "utf8")
    .digest("hex");
}
