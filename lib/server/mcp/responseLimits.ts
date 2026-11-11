import { constants } from "node:buffer";
export type McpResponseOperation = "call_tool" | "initialize" | "list_tools" | "ping" | "unknown";

export type McpResponseWireLimits = Readonly<{
  callToolResponseMaxBytes: number;
  initializeResponseMaxBytes: number;
  listToolsResponseMaxBytes: number;
  sseEventMaxBytes: number;
  unknownResponseMaxBytes: number;
}>;

export const MCP_JSON_RPC_REQUEST_MAX_BYTES = 8 * 1_024 * 1_024;

export function getMcpRequestMaxBytes(environment: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = environment.AIQSA_MCP_REQUEST_MAX_BYTES;
  if (raw === undefined || raw === "") return MCP_JSON_RPC_REQUEST_MAX_BYTES;
  const value = Number(raw);
  // Leave room for escaped JSON transport/activity envelopes in a Node string.
  if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > Math.floor(constants.MAX_STRING_LENGTH / 6)) {
    throw Object.assign(new Error("mcp_request_limit_config_invalid"), { code: "mcp_request_limit_config_invalid" });
  }
  return value;
}

export function mcpRequestSizeFailure(observedBytes: number | bigint, maxBytes: number) {
  return { code: "mcp_request_too_large", maxBytes, observedBytes: String(observedBytes),
    message: `The MCP request exceeds the configured ${maxBytes}-byte request limit. No connected tool was called.` };
}

export const DEFAULT_MCP_RESPONSE_WIRE_LIMITS: McpResponseWireLimits = Object.freeze({
  callToolResponseMaxBytes: 8 * 1_024 * 1_024,
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

/**
 * The hard per-call ceiling of a tools/call response body (decision
 * 2026-11-11). A call's body past its wire limit is still read and parsed up
 * to this bound, then cut to the result limit with a marker: the tool already
 * ran, and refusing its whole result only made the model fetch the items one
 * by one and miss some. Only a body above this bound fails the call.
 *
 * Memory: a body of B bytes peaks at about 4 B of V8 heap (the decoded text,
 * up to 2 B for mixed ASCII and Cyrillic, beside its parsed copy, then the
 * parsed result beside its measuring JSON string) and about 3 B of transient
 * buffers (received chunks, their concatenation or the SSE event buffer).
 * Bodies past the wire limit hold one of `MCP_CALL_RESULT_CEILING_PERMITS`
 * process-wide permits from the moment they cross it until the result is cut,
 * so at most 1 × 64 MiB × 7 ≈ 450 MiB rides on the app container's 2 GiB
 * (`AIQSA_APP_MEMORY_LIMIT` in `compose.yaml`), above the bounded bodies under
 * the wire limit; its heap share (256 MiB) stays well inside the about 1.1 GiB
 * heap Node sizes for a 2 GiB cgroup. A per-run batch runs up to 4 calls at once
 * (`TOOL_BATCH_LIMITS.concurrency`) and nothing bounds runs per process, so a
 * second oversized body waits for the permit instead of failing.
 */
export const MCP_CALL_RESULT_CEILING_BYTES = 64 * 1_024 * 1_024;
export const MCP_CALL_RESULT_CEILING_PERMITS = 1;

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
