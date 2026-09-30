import type { RequestAuthResolver } from "../auth/requestAuth";
import type { McpCallDetails } from "@/lib/contracts/mcpCallDetails";
import type { McpCallDetailsKey } from "./callDetails";

const json = (value: unknown, status = 200) => Response.json(value, { status,
  headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
const ordinal = (value: string) => /^(?:0|[1-9]\d{0,8})$/u.test(value) ? Number(value) : null;
const notFound = () => json({ error: "chat_not_found" }, 404);

export function createGetMcpCallDetailsHandler(input: Readonly<{
  resolveAuth: RequestAuthResolver;
  read(key: McpCallDetailsKey, signal?: AbortSignal): Promise<McpCallDetails | null>;
}>) {
  return async (request: Request, context: { params: Promise<{ runId: string; roundIndex: string; ordinal: string }> }): Promise<Response> => {
    const auth = await input.resolveAuth(request);
    if (!auth) return json({ error: "unauthorized" }, 401);
    const params = await context.params;
    const roundIndex = ordinal(params.roundIndex), callOrdinal = ordinal(params.ordinal);
    if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(params.runId) || roundIndex === null || callOrdinal === null) return notFound();
    try {
      const details = await input.read({ runId: params.runId, roundIndex, ordinal: callOrdinal, userId: auth.userId }, request.signal);
      return details ? json(details) : notFound();
    } catch {
      // No body, argument, secret context or transport exception is logged.
      return json({ error: "mcp_call_details_unavailable" }, 503);
    }
  };
}
