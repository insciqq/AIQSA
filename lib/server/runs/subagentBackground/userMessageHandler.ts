import { SUBAGENT_LIMITS, isActiveSubagentState, isSubagentIdentifier } from "../../../contracts/subagents";
import { SUBAGENT_NOT_FOUND } from "../../../contracts/subagentViews";
import { getAuthConfig, type AuthConfig } from "../../auth/config";
import { isAllowedMutationOrigin } from "../../auth/csrf";
import type { RequestAuthResolver } from "../../auth/requestAuth";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../../http/requestBody";
import { logEvent } from "../../observability";
import { SubagentMailboxFullError, type SubagentBackgroundOperations } from "./control";
import type { SubagentViews } from "./views";

export function createSubagentUserMessageHandler(deps: Readonly<{
  control: Pick<SubagentBackgroundOperations, "deliverUser">;
  getConfig?: () => AuthConfig;
  resolveAuth: RequestAuthResolver;
  views: Pick<SubagentViews, "threadView">;
}>) {
  return async (request: Request, context: { params: Promise<{ chatId: string; threadId: string }> | { chatId: string; threadId: string } }) => {
    const json = (value: unknown, status = 200) => Response.json(value, { status,
      headers: { "cache-control": "private, no-store", vary: "Cookie" } });
    const notFound = () => json({ error: SUBAGENT_NOT_FOUND.error }, SUBAGENT_NOT_FOUND.status);
    try {
      const config = deps.getConfig?.() ?? getAuthConfig();
      if (!isAllowedMutationOrigin({ appBaseUrl: config.appBaseUrl, origin: request.headers.get("origin"),
        requestOrigin: new URL(request.url).origin, secFetchSite: request.headers.get("sec-fetch-site") })) {
        return json({ error: "forbidden" }, 403);
      }
      const auth = config.configured ? await deps.resolveAuth(request) : null;
      if (!auth || auth.user.status !== "active") return json({ error: "unauthorized" }, 401);
      const { chatId, threadId } = await context.params;
      if (!isSubagentIdentifier(chatId) || !isSubagentIdentifier(threadId)) return notFound();
      const body = await readJsonBodyOrNull(request), bodyError = requestBodyErrorResponse(body);
      if (bodyError) return bodyError;
      // Leave room for the mailbox's user: namespace in the stored 128-character nonce.
      const input = body as { nonce?: unknown; text?: unknown; turnId?: unknown } | null;
      if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).some((key) => !["nonce", "text", "turnId"].includes(key)) ||
        !isSubagentIdentifier(input.nonce) || input.nonce.length > 123 || !isSubagentIdentifier(input.turnId) ||
        typeof input.text !== "string" || !input.text.trim() || input.text.length > SUBAGENT_LIMITS.messageCharacters || input.text.includes("\0")) {
        return json({ error: "subagent_message_invalid" }, 400);
      }
      const view = await deps.views.threadView({ chatId, threadId, userId: auth.userId });
      if (!view) return notFound();
      if (!isActiveSubagentState(view.thread.state) || view.turns.at(-1)?.id !== input.turnId) {
        return json({ error: "subagent_not_active" }, 409);
      }
      const outcome = await deps.control.deliverUser({ chatId, threadId, turnId: input.turnId, userId: auth.userId,
        nonce: input.nonce, text: input.text.trim() });
      if (outcome.kind === "not_found") return notFound();
      if (outcome.kind === "ended") return json({ error: "subagent_not_active" }, 409);
      return json({ accepted: true }, 202);
    } catch (error) {
      if (error instanceof SubagentMailboxFullError) return json({ error: error.code }, 409);
      logEvent("run_recovery", { code: "subagent_user_message_failed", error, outcome: "failed", stage: "dispatch", subsystem: "run_recovery" });
      return json({ error: "subagent_user_message_failed" }, 503);
    }
  };
}
