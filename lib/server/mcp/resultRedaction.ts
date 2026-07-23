import type { AiqsaMcpToolCallResult } from "./clientSession";

const REDACTED = "[REDACTED]";

function normalizedValues(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) => right.length - left.length);
}

function redactText(value: string, secrets: readonly string[]): string {
  if (!secrets.length) return value;
  const pattern = new RegExp(
    secrets.map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|"),
    "gu"
  );
  return value.replace(pattern, REDACTED);
}

function redactValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactText(value, secrets);
  if (typeof value === "number" || typeof value === "boolean") {
    return secrets.includes(String(value)) ? REDACTED : value;
  }
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, secrets));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    redactText(key, secrets),
    redactValue(entry, secrets)
  ]));
}

export function redactMcpToolCallResult(
  result: AiqsaMcpToolCallResult,
  exactValues: readonly string[]
): AiqsaMcpToolCallResult {
  const secrets = normalizedValues(exactValues);
  if (!secrets.length) return result;
  return {
    ...result,
    structuredContent: result.structuredContent
      ? redactValue(result.structuredContent, secrets) as Readonly<Record<string, unknown>>
      : null,
    text: result.text.map((value) => redactText(value, secrets))
  };
}
