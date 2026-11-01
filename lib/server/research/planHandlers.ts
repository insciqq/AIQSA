import { decodeResearchPlanAction, type ResearchPlanAction, type ResearchPlanWindowView } from "../../contracts/research";
import type { RequestAuthResolver } from "../auth/requestAuth";
import { readBoundedRequestBody } from "../http/requestBody";
import { researchPlanRowView, type ResearchPlanStore, type ResearchPlanWindowKey, type ResearchPlanWindows } from "./planWindow";

/**
 * The plan window's route, `/api/chats/<chatId>/research/plan`, on the pattern of the live browser's
 * (`lib/server/workspace/browserLiveHandlers.ts`): the signed-in browser session, the chat and the run are checked at the operation,
 * and another user's window, an unknown chat and a run that never had one all get the same `research_plan_not_found`. Mutations get the
 * proxy's same-origin check; bodies are bounded before they are read. An action on a closed window is no error: `outcome` says so
 * and the view shows what closed it.
 */
export type ResearchPlanHandlerDeps = Readonly<{
  now?: () => number;
  resolveAuth: RequestAuthResolver;
  store: Pick<ResearchPlanStore, "chatOpen" | "read">;
  windows: ResearchPlanWindows;
}>;

type Params = Readonly<{ params: Promise<Readonly<{ chatId: string }>> | Readonly<{ chatId: string }> }>;

/** What a POST answers: `closed` when the window had closed before this action reached it. */
export type ResearchPlanActionResult = Readonly<{ outcome: "applied" | "closed"; view: ResearchPlanWindowView }>;

const HEADERS = Object.freeze({ "cache-control": "private, no-store" });
/** A whole edit at its bounds, where each character may escape to six bytes. */
const BODY_MAX_BYTES = 64 * 1_024;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/u;

const reply = (body: unknown, status = 200) => Response.json(body, { headers: HEADERS, status });
const notFound = () => reply({ code: "research_plan_not_found" }, 404);

export function createResearchPlanHandlers(deps: ResearchPlanHandlerDeps) {
  const now = deps.now ?? Date.now;

  /** The caller's own scope of a chat, or null for anyone else. */
  async function scope(request: Request, context: Params, runId: unknown): Promise<ResearchPlanWindowKey | null> {
    const auth = await deps.resolveAuth(request).catch(() => null);
    const { chatId } = await context.params;
    if (!auth || auth.user.status !== "active" || !IDENTIFIER.test(chatId) || typeof runId !== "string" || !IDENTIFIER.test(runId)) return null;
    return await deps.store.chatOpen({ chatId, userId: auth.userId }) ? { chatId, runId, userId: auth.userId } : null;
  }

  /** A waiting window from memory, or from its row what a reload needs. */
  async function view(key: ResearchPlanWindowKey): Promise<ResearchPlanWindowView | null> {
    const live = deps.windows.find(key);
    if (live) return live.view();
    const row = await deps.store.read(key);
    return row ? researchPlanRowView(row, key.runId, now()) : null;
  }

  return {
    /** `GET …/research/plan?runId=`: the window as it stands. */
    async read(request: Request, context: Params): Promise<Response> {
      const key = await scope(request, context, new URL(request.url).searchParams.get("runId"));
      const found = key ? await view(key) : null;
      return found ? reply(found) : notFound();
    },

    /** `POST …/research/plan`: the button, a lease, its end or a saved edit (`decodeResearchPlanAction`). */
    async act(request: Request, context: Params): Promise<Response> {
      let action: ResearchPlanAction;
      try {
        const bytes = await readBoundedRequestBody(request, { maxBytes: BODY_MAX_BYTES });
        const decoded = decodeResearchPlanAction(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown);
        if (!decoded.ok) return reply({ code: "research_plan_request_invalid", message: decoded.message }, 400);
        action = decoded.value;
      } catch {
        return reply({ code: "research_plan_request_invalid" }, 400);
      }
      const key = await scope(request, context, action.runId);
      if (!key) return notFound();
      const live = deps.windows.find(key);
      const outcome = live ? await live.act(action) : "closed";
      const found = live?.view() ?? await view(key);
      return found ? reply({ outcome, view: found } satisfies ResearchPlanActionResult) : notFound();
    }
  };
}
