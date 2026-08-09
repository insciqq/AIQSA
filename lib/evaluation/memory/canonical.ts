import { createHash } from "node:crypto";

export function compareMemoryEvaluationText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalize(value: unknown, ancestors: Set<object>): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("memory_evaluation_non_finite_number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (
    typeof value === "undefined" ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    typeof value === "bigint"
  ) {
    throw new Error("memory_evaluation_non_json_value");
  }
  if (ancestors.has(value)) throw new Error("memory_evaluation_cyclic_value");

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => canonicalize(item, ancestors));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("memory_evaluation_non_plain_object");
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareMemoryEvaluationText(left, right))
        .map(([key, item]) => [key, canonicalize(item, ancestors)])
    );
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalMemoryEvaluationJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, new Set()));
}

export function memoryEvaluationSha256(value: unknown): string {
  return createHash("sha256")
    .update(canonicalMemoryEvaluationJson(value), "utf8")
    .digest("hex");
}

export function deriveMemoryEvaluationSeed(seed: number, label: string): number {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new Error("memory_evaluation_invalid_seed");
  }
  const digest = createHash("sha256")
    .update(`${seed}:${label}`, "utf8")
    .digest();
  return digest.readUInt32BE(0);
}

export function createMemoryEvaluationPrng(seed: number): () => number {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new Error("memory_evaluation_invalid_seed");
  }
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}
