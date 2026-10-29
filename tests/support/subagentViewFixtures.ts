import { isActiveSubagentState, type SubagentThreadState } from "@/lib/contracts/subagents";
import type {
  SubagentChatThreads,
  SubagentThreadSummary,
  SubagentThreadView,
  SubagentTurnView
} from "@/lib/contracts/subagentViews";

/** Fixture projections of the sub-agent view routes (`lib/contracts/subagentViews.ts`), valid for their decoders. */
export function subagentThread(
  id: string,
  state: SubagentThreadState = "running",
  overrides: Partial<SubagentThreadSummary> = {}
): SubagentThreadSummary {
  const active = isActiveSubagentState(state);
  return {
    createdAt: "2026-10-30T09:00:00.000Z",
    endedAt: active ? null : "2026-10-30T09:05:00.000Z",
    id,
    mode: "background",
    name: id.replace(/^thread-/u, ""),
    outcome: state === "done" ? "done" : null,
    reason: state === "stopped" ? "user_stop" : state === "failed" ? "provider_error" : null,
    state,
    turnCount: 1,
    type: null,
    updatedAt: active ? "2026-10-30T09:01:00.000Z" : "2026-10-30T09:05:00.000Z",
    ...overrides
  };
}

export function subagentChat(chatId: string, threads: readonly SubagentThreadSummary[], truncated = false): SubagentChatThreads {
  return {
    chatId,
    running: threads.filter((thread) => isActiveSubagentState(thread.state)).length,
    threads: [...threads],
    truncated
  };
}

export function subagentTurn(id: string, state: SubagentThreadState, overrides: Partial<SubagentTurnView> = {}): SubagentTurnView {
  const active = isActiveSubagentState(state);
  return {
    brief: "Compare the three cheapest laptops.",
    endedAt: active ? null : "2026-10-30T09:05:00.000Z",
    files: [],
    id,
    messages: [],
    mode: "background",
    model: { displayName: "Fake model", effort: null },
    outcome: state === "done" ? "done" : null,
    parentMessageId: "answer-1",
    reason: state === "stopped" ? "user_stop" : null,
    report: active ? null : "Found three laptops.",
    startedAt: "2026-10-30T09:00:00.000Z",
    state,
    toolActivity: null,
    workspaceActivity: null,
    ...overrides
  };
}

export function subagentView(chatId: string, thread: SubagentThreadSummary, turns?: readonly SubagentTurnView[]): SubagentThreadView {
  return { chatId, thread, truncated: false, turns: turns ? [...turns] : [subagentTurn(`turn-${thread.id}`, thread.state)] };
}

export type SubagentFetchRoute = Readonly<{
  method?: "GET" | "POST";
  /** Matched against the request path and query. */
  path: RegExp | string;
  respond(url: URL): Promise<Response> | Response;
}>;

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
}

/** A fetch fake that answers the first matching route and records every request. */
export function subagentFetch(routes: readonly SubagentFetchRoute[]) {
  const calls: { method: string; url: URL }[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://aiqsa.test");
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, url });
    const target = `${url.pathname}${url.search}`;
    const route = routes.find((candidate) => (candidate.method ?? "GET") === method &&
      (typeof candidate.path === "string" ? candidate.path === url.pathname : candidate.path.test(target)));
    if (!route) return jsonResponse({ error: "subagent_not_found" }, 404);
    if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return route.respond(url);
  };
  return { calls, fetch };
}

/** A promise with its resolver, for answers that arrive out of order. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
