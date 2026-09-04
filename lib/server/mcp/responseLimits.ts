export type McpResponseOperation = "call_tool" | "initialize" | "list_tools" | "ping" | "unknown";

export type McpResponseWireLimits = Readonly<{
  callToolResponseMaxBytes: number;
  initializeResponseMaxBytes: number;
  listToolsResponseMaxBytes: number;
  sseEventMaxBytes: number;
  unknownResponseMaxBytes: number;
}>;

export const MCP_JSON_RPC_REQUEST_MAX_BYTES = 1 * 1_024 * 1_024;

export const DEFAULT_MCP_RESPONSE_WIRE_LIMITS: McpResponseWireLimits = Object.freeze({
  callToolResponseMaxBytes: 512 * 1_024,
  initializeResponseMaxBytes: 1 * 1_024 * 1_024,
  listToolsResponseMaxBytes: 16 * 1_024 * 1_024,
  sseEventMaxBytes: 16 * 1_024 * 1_024,
  unknownResponseMaxBytes: 1 * 1_024 * 1_024
});

export const MCP_RESPONSE_WIRE_LIMIT_CEILINGS: McpResponseWireLimits = Object.freeze({
  callToolResponseMaxBytes: 16 * 1_024 * 1_024,
  initializeResponseMaxBytes: 16 * 1_024 * 1_024,
  listToolsResponseMaxBytes: 64 * 1_024 * 1_024,
  sseEventMaxBytes: 64 * 1_024 * 1_024,
  unknownResponseMaxBytes: 16 * 1_024 * 1_024
});

const environmentNames = Object.freeze({
  callToolResponseMaxBytes: "AIQSA_MCP_CALL_TOOL_RESPONSE_MAX_BYTES",
  initializeResponseMaxBytes: "AIQSA_MCP_INITIALIZE_RESPONSE_MAX_BYTES",
  listToolsResponseMaxBytes: "AIQSA_MCP_LIST_TOOLS_RESPONSE_MAX_BYTES",
  sseEventMaxBytes: "AIQSA_MCP_SSE_EVENT_MAX_BYTES",
  unknownResponseMaxBytes: "AIQSA_MCP_UNKNOWN_RESPONSE_MAX_BYTES"
} satisfies Record<keyof McpResponseWireLimits, string>);

function boundedPositiveInteger(
  value: string | number | undefined,
  fallback: number,
  ceiling: number
): number {
  if (typeof value === "string" && !/^\d+$/u.test(value)) return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= ceiling
    ? parsed
    : fallback;
}

export function getMcpResponseWireLimits(
  environment: Readonly<Record<string, string | undefined>> = process.env
): McpResponseWireLimits {
  return Object.freeze(Object.fromEntries(
    Object.entries(environmentNames).map(([key, name]) => [
      key,
      boundedPositiveInteger(
        environment[name],
        DEFAULT_MCP_RESPONSE_WIRE_LIMITS[key as keyof McpResponseWireLimits],
        MCP_RESPONSE_WIRE_LIMIT_CEILINGS[key as keyof McpResponseWireLimits]
      )
    ])
  ) as McpResponseWireLimits);
}

export function resolveMcpResponseWireLimits(
  overrides: Partial<McpResponseWireLimits> = {},
  environment: Readonly<Record<string, string | undefined>> = process.env
): McpResponseWireLimits {
  const configured = getMcpResponseWireLimits(environment);
  return Object.freeze(Object.fromEntries(
    (Object.keys(configured) as Array<keyof McpResponseWireLimits>).map((key) => [
      key,
      boundedPositiveInteger(overrides[key], configured[key], MCP_RESPONSE_WIRE_LIMIT_CEILINGS[key])
    ])
  ) as McpResponseWireLimits);
}

export function mcpResponseMaxBytes(
  limits: McpResponseWireLimits,
  operation: McpResponseOperation
): number {
  switch (operation) {
    case "call_tool":
      return limits.callToolResponseMaxBytes;
    case "initialize":
      return limits.initializeResponseMaxBytes;
    case "list_tools":
      return limits.listToolsResponseMaxBytes;
    case "ping":
      return Math.min(16 * 1_024, limits.unknownResponseMaxBytes);
    case "unknown":
      return limits.unknownResponseMaxBytes;
  }
}

export class McpResponseTooLargeError extends Error {
  readonly maxBytes: number;
  readonly observedBytes: number;
  readonly operation: McpResponseOperation;

  constructor(input: Readonly<{
    maxBytes: number;
    observedBytes: number;
    operation: McpResponseOperation;
  }>) {
    super("mcp_response_too_large");
    this.name = "McpResponseTooLargeError";
    this.maxBytes = input.maxBytes;
    this.observedBytes = input.observedBytes;
    this.operation = input.operation;
  }
}
