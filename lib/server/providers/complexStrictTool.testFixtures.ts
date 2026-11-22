/** A strict tool with more optional (nullable) fields than Anthropic's strict grammar takes in one request. */
export function complexStrictTool() {
  const fields = Array.from({ length: 40 }, (_, index) => `field${index}`);
  return {
    capability: "mcp" as const,
    description: "Record a structured result.",
    inputSchema: {
      additionalProperties: false,
      properties: Object.fromEntries(fields.map((field) => [field, { type: ["string", "null"] }])),
      required: fields,
      type: "object"
    },
    name: "record_result",
    strict: true
  };
}
