import { decodeChatContinuationRequest, type ChatContinuationRequest, type ChatContinuationResult } from "../../contracts/chatContinuation";
import type { RequestAuthResolver } from "../auth/requestAuth";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../http/requestBody";
import { ChatContinuationError } from "./continuation";

type RouteContext = { params: Promise<{ chatId: string }> };

export function createContinuationSourceHandler(deps: Readonly<{
  resolveAuth: RequestAuthResolver;
  sourceHref(chatId: string, userId: string): Promise<string | null>;
}>) {
  return async (request: Request, context: RouteContext): Promise<Response> => {
    const session = await deps.resolveAuth(request);
    if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
    const href = await deps.sourceHref((await context.params).chatId, session.userId);
    return href ? new Response(null, { status: 303, headers: { Location: new URL(href, request.url).href, "Cache-Control": "no-store" } })
      : Response.json({ error: "chat_not_found" }, { status: 404 });
  };
}

export function createChatContinuationHandler(deps: Readonly<{
  resolveAuth: RequestAuthResolver;
  continueChat(input: ChatContinuationRequest & { chatId: string; userId: string; signal?: AbortSignal }): Promise<ChatContinuationResult>;
}>) {
  return async (request: Request, context: RouteContext): Promise<Response> => {
    const session = await deps.resolveAuth(request);
    if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
    let value: unknown;
    try { value = await readJsonBodyOrNull(request); }
    catch (error) { return requestBodyErrorResponse(error) ?? Response.json({ error: "invalid_request" }, { status: 400 }); }
    const body = decodeChatContinuationRequest(value);
    if (!body) return Response.json({ error: "invalid_request" }, { status: 400 });
    try {
      const { chatId } = await context.params;
      const result = await deps.continueChat({ ...body, chatId, userId: session.userId, signal: request.signal });
      return Response.json(result, { status: result.status === "running" ? 202 : 200, headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      const failure = error instanceof ChatContinuationError ? error : new ChatContinuationError("chat_summary_failed", 502);
      return Response.json({ error: failure.code }, { status: failure.status });
    }
  };
}
