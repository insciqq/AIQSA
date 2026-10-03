import { safeInternalPath } from "../auth/internalPath";

/**
 * A chat address: `/` (new chat), `/c/<chat>`, `/p/<project>` (new Project
 * chat) or `/p/<project>/c/<chat>`. Server links and the browser shell share
 * this one contract; an address implies neither existence nor access.
 */
export type ChatRoute = Readonly<{
  chatId: string | null;
  projectId: string | null;
}>;

export const BLANK_CHAT_ROUTE: ChatRoute = Object.freeze({ chatId: null, projectId: null });

/** One-shot parameters that belong to the chat they arrived with. */
export const CHAT_SCOPED_ROUTE_PARAMETERS = ["message", "artifactEdit", "artifactId", "versionId"] as const;

/** Legacy query names of the path form; they are read once and never written. */
const LEGACY_ROUTE_PARAMETERS = ["chat", "project"] as const;
const ROUTE_ID_MAX_LENGTH = 256;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

export function boundedRouteId(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 &&
    normalized.length <= ROUTE_ID_MAX_LENGTH &&
    !CONTROL_CHARACTER.test(normalized)
    ? normalized
    : null;
}

function routeSegment(segment: string | undefined): string | null {
  if (segment === undefined) return null;
  try {
    return boundedRouteId(decodeURIComponent(segment));
  } catch {
    return null;
  }
}

/** Parses one of the four chat pathnames; anything else, including a malformed id, is null. */
export function parseChatRoutePath(pathname: string): ChatRoute | null {
  if (pathname === "/") return BLANK_CHAT_ROUTE;
  const segments = pathname.split("/").slice(1);
  if (segments.length === 2 && (segments[0] === "c" || segments[0] === "p")) {
    const id = routeSegment(segments[1]);
    if (!id) return null;
    return segments[0] === "c" ? { chatId: id, projectId: null } : { chatId: null, projectId: id };
  }
  if (segments.length === 4 && segments[0] === "p" && segments[2] === "c") {
    const projectId = routeSegment(segments[1]);
    const chatId = routeSegment(segments[3]);
    return projectId && chatId ? { chatId, projectId } : null;
  }
  return null;
}

/**
 * The Assistant entry address `/assistant/<id>`. It opens a new personal chat
 * with that Assistant and settles on `/`, so it is never a chat's route; a
 * malformed id is kept as null and resolves like an unknown Assistant.
 */
export type AssistantEntryRoute = Readonly<{ assistantId: string | null }>;

export function parseAssistantEntryPath(pathname: string): AssistantEntryRoute | null {
  const segments = pathname.split("/").slice(1);
  return segments.length === 2 && segments[0] === "assistant"
    ? { assistantId: routeSegment(segments[1]) }
    : null;
}

/** The shareable link of an Assistant; the id is its only parameter. */
export function formatAssistantEntryPath(assistantId: string): string {
  return `/assistant/${encodeURIComponent(assistantId)}`;
}

/** Whether the chat pages serve a pathname, even one naming a malformed id. */
export function isChatRoutePathname(pathname: string): boolean {
  return pathname === "/" || /^\/(?:[cp]|assistant)\//u.test(pathname);
}

export function formatChatRoutePath(route: ChatRoute): string {
  const chat = route.chatId ? `/c/${encodeURIComponent(route.chatId)}` : "";
  return route.projectId ? `/p/${encodeURIComponent(route.projectId)}${chat}` : chat || "/";
}

export function sameChatRoute(left: ChatRoute, right: ChatRoute): boolean {
  return left.chatId === right.chatId && left.projectId === right.projectId;
}

/** The route path followed by the carried query, without legacy route parameters. */
export function chatRouteHref(route: ChatRoute, carried: string | URLSearchParams = ""): string {
  const params = new URLSearchParams(carried);
  for (const key of LEGACY_ROUTE_PARAMETERS) params.delete(key);
  const query = params.toString();
  return `${formatChatRoutePath(route)}${query ? `?${query}` : ""}`;
}

export function withoutChatScopedParameters(carried: string | URLSearchParams): URLSearchParams {
  const params = new URLSearchParams(carried);
  for (const key of CHAT_SCOPED_ROUTE_PARAMETERS) params.delete(key);
  return params;
}

function singleRouteParameter(params: URLSearchParams, key: string): string | null {
  const values = params.getAll(key);
  return values.length === 1 ? boundedRouteId(values[0]) : null;
}

/**
 * Path form of a legacy `/?chat=<id>[&project=<id>]` link carrying its other
 * parameters, or null when the query names no route. A legacy chat link
 * whose id is unusable lands on the new chat without its one-shot parameters.
 */
export function legacyChatRouteHref(params: URLSearchParams): string | null {
  if (!LEGACY_ROUTE_PARAMETERS.some((key) => params.has(key))) return null;
  const chatId = singleRouteParameter(params, "chat");
  if (params.has("chat") && !chatId) {
    return chatRouteHref(BLANK_CHAT_ROUTE, withoutChatScopedParameters(params));
  }
  return chatRouteHref({ chatId, projectId: singleRouteParameter(params, "project") }, params);
}

/**
 * The chat pathname a flow that leaves the shell may return to. Only an
 * internal, query-free chat route survives; anything else is the new chat.
 */
export function chatReturnPath(value: string | null | undefined): string {
  if (!value) return "/";
  const url = new URL(safeInternalPath(value), "https://aiqsa.invalid");
  if (url.search || url.hash) return "/";
  const route = parseChatRoutePath(url.pathname);
  return route ? formatChatRoutePath(route) : "/";
}

/** Control Center entry that remembers the chat it was opened from. */
export function controlCenterHref(
  returnPath: string,
  target?: Readonly<{ resource?: string; section: string }>
): string {
  const path = chatReturnPath(returnPath);
  const query = new URLSearchParams(target ? {
    section: target.section, ...(target.resource ? { resource: target.resource } : {})
  } : {});
  if (path !== "/") query.set("return", path);
  const search = query.toString();
  return search ? `/admin?${search}` : "/admin";
}
