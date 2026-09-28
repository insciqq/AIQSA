const SERVER_VALIDATED_KEYS = new Set([
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength",
  "maxItems", "uniqueItems", "pattern"
]);
const SUPPORTED_FORMATS = new Set([
  "date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid"
]);
const CHILD_KEYS = new Set(["items", "additionalProperties", "contains", "not", "if", "then", "else", "propertyNames"]);
const CHILD_ARRAY_KEYS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const CHILD_MAP_KEYS = new Set(["properties", "$defs", "definitions", "patternProperties", "dependentSchemas"]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function anthropicServerValidatedSchemaConstraint(key: string, value: unknown): boolean {
  return SERVER_VALIDATED_KEYS.has(key) || key === "minItems" && value !== 0 && value !== 1 ||
    key === "format" && (typeof value !== "string" || !SUPPORTED_FORMATS.has(value));
}

/** Anthropic strict generation supports a subset of validation keywords.
 * Preserve omitted constraints as guidance; original schemas and owning
 * server validators remain authoritative. Visit schema positions only. */
export function anthropicStrictSchema(schema: Record<string, unknown>, depth = 0): Record<string, unknown> {
  if (depth > 64) throw new Error("structured_output_schema_unsupported");
  const mapped: Record<string, unknown> = {};
  const constraints: Record<string, unknown> = {};
  const child = (value: unknown) => record(value) ? anthropicStrictSchema(value, depth + 1) : value;
  const nullableEnum = Array.isArray(schema.enum) && schema.enum.includes(null) &&
    Array.isArray(schema.type) && schema.type.includes("null");
  for (const [key, value] of Object.entries(schema)) {
    if (nullableEnum && (key === "enum" || key === "type")) continue;
    if (anthropicServerValidatedSchemaConstraint(key, value)) constraints[key] = value;
    else if (CHILD_MAP_KEYS.has(key) && record(value)) {
      mapped[key] = Object.fromEntries(Object.entries(value).map(([name, value]) => [name, child(value)]));
    } else if (CHILD_KEYS.has(key)) mapped[key] = child(value);
    else if (CHILD_ARRAY_KEYS.has(key) && Array.isArray(value)) mapped[key] = value.map(child);
    else mapped[key] = value;
  }
  // Mixed nullable enums are rejected even though nullable type arrays work.
  // Splitting the null branch preserves exactly the same permitted values.
  if (nullableEnum) {
    const types = (schema.type as unknown[]).filter(value => value !== "null");
    const values = (schema.enum as unknown[]).filter(value => value !== null);
    const variants = [...(values.length ? [{ type: types.length === 1 ? types[0] : types, enum: values }] : []), { type: "null" }];
    if (mapped.anyOf || mapped.oneOf) {
      mapped.allOf = [...(Array.isArray(mapped.allOf) ? mapped.allOf : []), { anyOf: variants }];
    } else mapped.anyOf = variants;
  }
  if (Object.keys(constraints).length) {
    mapped.description = `${typeof mapped.description === "string" ? `${mapped.description}\n` : ""}Required constraints: ${JSON.stringify(constraints)}`;
  }
  return mapped;
}

function schemaComplexity(schema: Record<string, unknown>, depth = 0): { optional: number; unions: number } {
  if (depth > 64) throw new Error("structured_output_schema_unsupported");
  const counts = { optional: record(schema.properties)
    ? Object.keys(schema.properties).filter(key => !Array.isArray(schema.required) || !schema.required.includes(key)).length : 0,
    unions: Array.isArray(schema.type) || Array.isArray(schema.anyOf) ? 1 : 0 };
  const visit = (node: unknown) => {
    if (!record(node)) return;
    const result = schemaComplexity(node, depth + 1);
    counts.optional += result.optional;
    counts.unions += result.unions;
  };
  for (const [key, value] of Object.entries(schema)) {
    if (CHILD_MAP_KEYS.has(key) && record(value)) Object.values(value).forEach(visit);
    else if (CHILD_ARRAY_KEYS.has(key) && Array.isArray(value)) value.forEach(visit);
    else if (CHILD_KEYS.has(key)) visit(value);
  }
  return counts;
}

/** Anthropic limits the combined grammar to 20 strict tools, 24 optional
 * parameters and 16 unions. Complex schemas retain their full declaration
 * with native strict disabled; owning server decoders still validate them. */
export function anthropicToolSchemas<T extends { inputSchema: Record<string, unknown>; strict?: boolean }>(tools: readonly T[]): T[] {
  let strictCount = 0;
  let optional = 0;
  let unions = 0;
  return tools.map(tool => {
    if (tool.strict !== true) return tool;
    const complexity = schemaComplexity(tool.inputSchema);
    if (strictCount >= 20 || optional + complexity.optional > 24 || unions + complexity.unions > 16) {
      return { ...tool, strict: false };
    }
    strictCount++;
    optional += complexity.optional;
    unions += complexity.unions;
    return { ...tool, inputSchema: anthropicStrictSchema(tool.inputSchema) };
  });
}
