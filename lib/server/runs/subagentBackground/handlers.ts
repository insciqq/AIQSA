import { SUBAGENT_LIMITS, isActiveSubagentState, isSubagentIdentifier } from "../../../contracts/subagents";
import {
  SUBAGENT_NOT_FOUND,
  decodeSubagentSummaryQuery,
  type SubagentStopAllResponse,
  type SubagentStopResponse
} from "../../../contracts/subagentViews";
import { getAuthConfig, type AuthConfig } from "../../auth/config";
import type { RequestAuthResolver } from "../../auth/requestAuth";
import { logEvent } from "../../observability";
import type { SubagentBackgroundOperations } from "./control";
import type { SubagentViews } from "./views";

/**
 * The owner-only sub-agent routes (`SUBAGENT_API_PATHS`): the caller's own
 * signed-in session, the caller's own chat not pending deletion, a thread of
 * that chat on its active branch. Anything else, administrators included,
 * reads `subagent_not_found`. Stops are idempotent mutations behind the
 * shared same-origin guard (`proxy.ts`).
 */

export type SubagentRouteDeps = Readonly<{
  control: Pick<SubagentBackgroundOperations, "stopAll" | "stopThread">;
  getConfig?: () => AuthConfig;
  resolveAuth: RequestAuthResolver;
  views: SubagentViews;
}>;

type Params<T> = Readonly<{ params: Promise<T> | T }>;

const HEADERS = { "cache-control": "private, no-store, max-age=0" };

function json(data: unknown, status = 200): Response {
  return Response.json(data, { headers: HEADERS, status });
}

const notFound = () => json({ error: SUBAGENT_NOT_FOUND.error }, SUBAGENT_NOT_FOUND.status);
/**
 * Nothing it asked could be stopped and a sub-agent still runs: its turn runs where this process cannot reach it (a
 * foreground turn of a run held elsewhere). Said, never answered as a quiet success.
 */
export const SUBAGENT_STOP_UNAVAILABLE = "subagent_stop_unavailable";
const stopUnavailable = () => json({ error: SUBAGENT_STOP_UNAVAILABLE }, 409);

async function userOf(deps: SubagentRouteDeps, request: Request): Promise<string | null> {
  if (!(deps.getConfig?.() ?? getAuthConfig()).configured) return null;
  return (await deps.resolveAuth(request))?.userId ?? null;
}

function guarded<T>(stage: string, handler: (request: Request, context: Params<T>) => Promise<Response>) {
  return async (request: Request, context: Params<T>): Promise<Response> => {
    try {
      return await handler(request, context);
    } catch (error) {
      logEvent("run_recovery", { code: `subagent_route_${stage}_failed`, error, outcome: "failed", stage: "read",
        subsystem: "run_recovery" });
      return json({ error: "internal_error" }, 500);
    }
  };
}

/** `GET /api/subagents?chatId=…`: the caller's chats among these that have sub-agents on their active branch. */
export function createSubagentSummaryHandler(deps: SubagentRouteDeps) {
  return guarded<Record<string, never>>("summary", async (request) => {
    const userId = await userOf(deps, request);
    if (!userId) return json({ error: "unauthorized" }, 401);
    const chatIds = decodeSubagentSummaryQuery(new URL(request.url).searchParams);
    if (!chatIds) return json({ error: "subagent_query_invalid" }, 400);
    return json(await deps.views.summary({ chatIds, userId }));
  });
}

/** `GET /api/chats/:chatId/subagents`. */
export function createSubagentChatThreadsHandler(deps: SubagentRouteDeps) {
  return guarded<{ chatId: string }>("threads", async (request, context) => {
    const userId = await userOf(deps, request);
    if (!userId) return json({ error: "unauthorized" }, 401);
    const { chatId } = await context.params;
    if (!isSubagentIdentifier(chatId)) return notFound();
    const threads = await deps.views.chatThreads({ chatId, userId });
    return threads ? json(threads) : notFound();
  });
}

/** `GET /api/chats/:chatId/subagents/:threadId`. */
export function createSubagentThreadViewHandler(deps: SubagentRouteDeps) {
  return guarded<{ chatId: string; threadId: string }>("thread", async (request, context) => {
    const userId = await userOf(deps, request);
    if (!userId) return json({ error: "unauthorized" }, 401);
    const { chatId, threadId } = await context.params;
    if (!isSubagentIdentifier(chatId) || !isSubagentIdentifier(threadId)) return notFound();
    const view = await deps.views.threadView({ chatId, threadId, userId });
    return view ? json(view) : notFound();
  });
}

/** `POST /api/chats/:chatId/subagents/:threadId/stop`: the user's Stop on one sub-agent. */
export function createSubagentStopHandler(deps: SubagentRouteDeps) {
  return guarded<{ chatId: string; threadId: string }>("stop", async (request, context) => {
    const userId = await userOf(deps, request);
    if (!userId) return json({ error: "unauthorized" }, 401);
    const { chatId, threadId } = await context.params;
    if (!isSubagentIdentifier(chatId) || !isSubagentIdentifier(threadId)) return notFound();
    if (!(await deps.views.thread({ chatId, threadId, userId }))) return notFound();
    const stopped = await deps.control.stopThread({ chatId, threadId, userId });
    const thread = await deps.views.thread({ chatId, threadId, userId });
    if (!thread) return notFound();
    if (stopped === 0 && isActiveSubagentState(thread.state)) return stopUnavailable();
    return json({ thread } satisfies SubagentStopResponse);
  });
}

/** `POST /api/chats/:chatId/subagents/stop-all`: every active sub-agent of the chat, on every branch. */
export function createSubagentStopAllHandler(deps: SubagentRouteDeps) {
  return guarded<{ chatId: string }>("stop_all", async (request, context) => {
    const userId = await userOf(deps, request);
    if (!userId) return json({ error: "unauthorized" }, 401);
    const { chatId } = await context.params;
    if (!isSubagentIdentifier(chatId) || !(await deps.views.ownsChat({ chatId, userId }))) return notFound();
    const stopped = await deps.control.stopAll({ chatId, userId });
    if (stopped === 0 && ((await deps.views.chatThreads({ chatId, userId }))?.running ?? 0) > 0) return stopUnavailable();
    return json({ stopped: Math.min(stopped, SUBAGENT_LIMITS.runningPerChat) } satisfies SubagentStopAllResponse);
  });
}
