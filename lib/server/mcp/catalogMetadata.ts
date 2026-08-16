import type {
  McpToolArgumentInventoryEntry,
  McpToolInventoryEntry
} from "@/lib/contracts/mcp";

const JSON_SCHEMA_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeText(
  value: unknown,
  secrets: readonly string[]
): string | null {
  if (typeof value !== "string" || secrets.some((secret) => value.includes(secret))) {
    return null;
  }
  const normalized = value.trim();
  if (!normalized || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) {
    return null;
  }
  return normalized;
}

function schemaTypes(value: unknown): string[] {
  const values = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  return [...new Set(values.filter((candidate): candidate is string =>
    typeof candidate === "string" && JSON_SCHEMA_TYPES.has(candidate)
  ))].sort();
}

export function compactMcpToolArguments(
  inputSchema: Readonly<Record<string, unknown>>,
  secrets: readonly string[] = []
): McpToolArgumentInventoryEntry[] {
  const properties = isRecord(inputSchema.properties) ? inputSchema.properties : {};
  return Object.entries(properties)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([rawName, value]) => {
      const name = safeText(rawName, secrets);
      if (!name || !isRecord(value)) return [];
      return [{
        description: safeText(value.description, secrets),
        name,
        types: schemaTypes(value.type)
      }];
    });
}

export function compactMcpToolInventoryEntry(
  tool: Readonly<{
    annotations?: Readonly<{ title?: unknown }>;
    description: string | null;
    inputSchema: Readonly<Record<string, unknown>>;
    name: string;
    title?: string;
  }>,
  secrets: readonly string[] = []
): McpToolInventoryEntry {
  const title = safeText(tool.title ?? tool.annotations?.title, secrets);
  return {
    arguments: compactMcpToolArguments(tool.inputSchema, secrets),
    description: safeText(tool.description, secrets),
    name: tool.name,
    ...(title ? { title } : {})
  };
}
