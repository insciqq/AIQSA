import { mcpRuntimeErrorMessage, type McpRuntimeErrorCode } from "@/lib/contracts/mcp";

export type McpDispatchFailureCode = McpRuntimeErrorCode | "memory_egress_destination_revoked";

export function mcpDispatchError(code: McpDispatchFailureCode): Error {
  return Object.assign(new Error(code === "memory_egress_destination_revoked"
    ? code : mcpRuntimeErrorMessage(code)), { code });
}

/** A refusal built by `mcpDispatchError`, recognized by its own code rather than its message. */
export function isMcpDispatchError(error: unknown, code: McpDispatchFailureCode): boolean {
  return error instanceof Error && Object.hasOwn(error, "code") &&
    (error as Error & { code?: unknown }).code === code;
}
