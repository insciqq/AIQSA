import type { MemoryCommandListResponse } from "../../../contracts/memoryCommand";
import type { RequestAuthResolver } from "../../auth/requestAuth";

type RouteContext = Readonly<{ params: Promise<{ chatId: string }> | { chatId: string } }>;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: {
    "cache-control": "private, no-store, max-age=0", vary: "Cookie"
  } });
}

export function createGetChatMemoryCommandsHandler(deps: Readonly<{
  resolveAuth: RequestAuthResolver;
  list(input: Readonly<{ userId: string; chatId: string }>): Promise<MemoryCommandListResponse | null>;
}>) {
  return async function GET(request: Request, context: RouteContext): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return json({ error: "unauthorized" }, 401);
    const { chatId } = await context.params;
    if (!chatId || chatId.length > 256 || /[\u0000-\u0020\u007f]/u.test(chatId) ||
      new URL(request.url).searchParams.size !== 0) {
      return json({ error: "memory_contract_invalid" }, 400);
    }
    try {
      const result = await deps.list({ chatId, userId: session.userId });
      return result ? json(result) : json({ error: "not_found" }, 404);
    } catch {
      return json({ error: "memory_unavailable" }, 503);
    }
  };
}
