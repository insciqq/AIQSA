export const MCP_CALL_DISPLAY_BYTES = 64 * 1024;

export type McpCallDisplaySection = Readonly<{ text: string; byteSize: number; truncated: boolean }>;
export type McpCallDetails = Readonly<{
  request: McpCallDisplaySection | null;
  response: McpCallDisplaySection | null;
  requestState: "available" | "unavailable";
  responseState: "available" | "pending" | "cancelled" | "too_large" | "unavailable";
  isError: boolean;
  unsupportedContentTypes: readonly string[];
}>;

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function section(value: unknown): McpCallDisplaySection | null {
  if (!record(value) || typeof value.text !== "string" || typeof value.truncated !== "boolean" ||
    !Number.isSafeInteger(value.byteSize) || Number(value.byteSize) < 0) return null;
  const delivered = new TextEncoder().encode(value.text).length;
  if (delivered > MCP_CALL_DISPLAY_BYTES || Number(value.byteSize) < delivered ||
    value.truncated !== (Number(value.byteSize) > delivered)) return null;
  return { text: value.text, byteSize: Number(value.byteSize), truncated: value.truncated };
}

export function decodeMcpCallDetails(value: unknown): McpCallDetails | null {
  if (!record(value) || !["available", "unavailable"].includes(String(value.requestState)) ||
    !["available", "pending", "cancelled", "too_large", "unavailable"].includes(String(value.responseState)) ||
    typeof value.isError !== "boolean" || !Array.isArray(value.unsupportedContentTypes) || value.unsupportedContentTypes.length > 16 ||
    !value.unsupportedContentTypes.every(type => typeof type === "string" && /^[a-z][a-z0-9_-]{0,63}$/u.test(type))) return null;
  const request = value.request === null ? null : section(value.request);
  const response = value.response === null ? null : section(value.response);
  if ((value.requestState === "available") !== (request !== null) || (value.responseState === "available") !== (response !== null)) return null;
  return { request, response, requestState: value.requestState as McpCallDetails["requestState"],
    responseState: value.responseState as McpCallDetails["responseState"], isError: value.isError,
    unsupportedContentTypes: [...value.unsupportedContentTypes] };
}
