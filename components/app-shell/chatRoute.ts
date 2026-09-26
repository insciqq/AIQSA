import {
  composerSessionKey,
  projectIdFromComposerSessionKey,
  selectComposerSession,
  useComposerSessionStore
} from "@/components/app-shell/composerSessionStore";
import { useRunLifecycleStore } from "@/components/app-shell/runLifecycleStore";
import type { WorkspaceChatSummary } from "@/components/app-shell/types";
import { useWorkspaceStore } from "@/components/app-shell/workspaceStore";
import {
  BLANK_CHAT_ROUTE,
  chatRouteHref,
  controlCenterHref,
  formatChatRoutePath,
  isChatRoutePathname,
  parseChatRoutePath,
  sameChatRoute,
  withoutChatScopedParameters,
  type ChatRoute
} from "@/lib/domain/chatRoute";
import { useEffect, useRef, useSyncExternalStore } from "react";

export type { ChatRoute };

/**
 * The address is the only persisted location of the shell. State owners write
 * the route of what they activate (`replaceState`); only an explicit user
 * navigation adds a history entry, and resolving an address into state never
 * rewrites it midway.
 */
type NavigationScope = { route: ChatRoute | null };

let navigationScope: NavigationScope | null = null;
let pendingResolution: symbol | null = null;
const routeListeners = new Set<() => void>();

export type ChatRouteResolution = symbol;

/** A local draft is still its blank chat until its first send is under way. */
export function chatRouteForChat(
  chat: Pick<WorkspaceChatSummary, "id" | "pendingPersonalDraft" | "pendingProjectDraft" | "projectId">,
  sending: boolean
): ChatRoute {
  const unsentDraft = Boolean(chat.pendingPersonalDraft || chat.pendingProjectDraft) && !sending;
  return {
    chatId: unsentDraft ? null : chat.id,
    projectId: chat.projectId ?? chat.pendingProjectDraft?.projectId ?? null
  };
}

/**
 * A send is under way from the composer (its pending send) or from any other
 * path that streams an answer into the chat, such as an Assistant starter prompt.
 */
export function chatSendUnderWay(chatId: string): boolean {
  return Boolean(
    selectComposerSession(useComposerSessionStore.getState(), composerSessionKey(chatId)).pendingSend ||
    useRunLifecycleStore.getState().activeStreams[chatId]
  );
}

/** The route of what the workspace and composer owners show right now. */
export function chatRouteForState(): ChatRoute {
  const { activeChatId, chats } = useWorkspaceStore.getState();
  const chat = activeChatId ? chats.find((candidate) => candidate.id === activeChatId) : undefined;
  if (chat) return chatRouteForChat(chat, chatSendUnderWay(chat.id));
  return activeChatId
    ? { chatId: activeChatId, projectId: null }
    : {
        chatId: null,
        projectId: projectIdFromComposerSessionKey(useComposerSessionStore.getState().activeSessionKey)
      };
}

/** The route the address names; null outside the chat pages or for a malformed id. */
export function currentChatRoute(): ChatRoute | null {
  return typeof window === "undefined" ? null : parseChatRoutePath(window.location.pathname);
}

function routeHref(route: ChatRoute): string | null {
  const { hash, pathname, search } = window.location;
  // An async owner may settle after another page took over the document.
  if (!isChatRoutePathname(pathname)) return null;
  const current = parseChatRoutePath(pathname);
  const sameChat = Boolean(route.chatId) && current?.chatId === route.chatId;
  const sameRoute = current !== null && sameChatRoute(current, route);
  return `${chatRouteHref(route, sameChat ? search : withoutChatScopedParameters(search))}${sameRoute ? hash : ""}`;
}

function commitRoute(route: ChatRoute, push: boolean): void {
  const href = routeHref(route);
  const { hash, pathname, search } = window.location;
  if (href === null || href === `${pathname}${search}${hash}`) return;
  // A null state lets the framework router adopt the new address.
  if (push) window.history.pushState(null, "", href);
  else window.history.replaceState(null, "", href);
  for (const listener of routeListeners) listener();
}

/** Records the route of the state an owner just activated. */
export function writeChatRoute(route: ChatRoute): void {
  if (typeof window === "undefined") return;
  if (navigationScope) {
    navigationScope.route = route;
    return;
  }
  if (pendingResolution === null) commitRoute(route, false);
}

/**
 * Runs an explicit user navigation. The route its synchronous part settles on
 * becomes one new history entry, so browser back returns to the previous chat.
 */
export function navigateChatRoute<T>(action: () => T): T {
  if (navigationScope) return action();
  const scope: NavigationScope = { route: null };
  navigationScope = scope;
  // The user's choice supersedes resolving the previous address.
  pendingResolution = null;
  try {
    return action();
  } finally {
    navigationScope = null;
    if (scope.route && typeof window !== "undefined") commitRoute(scope.route, true);
  }
}

/** Starts resolving the address into state; it supersedes any earlier resolution. */
export function beginChatRouteResolution(): ChatRouteResolution {
  const resolution = Symbol("chat-route-resolution");
  pendingResolution = resolution;
  return resolution;
}

export function isCurrentChatRouteResolution(resolution: ChatRouteResolution): boolean {
  return pendingResolution === resolution;
}

/** Ends a current resolution; `null` keeps the address after a load failure. */
export function settleChatRouteResolution(
  resolution: ChatRouteResolution,
  route: ChatRoute | null
): boolean {
  if (pendingResolution !== resolution) return false;
  pendingResolution = null;
  if (route) writeChatRoute(route);
  return true;
}

export function cancelChatRouteResolution(resolution: ChatRouteResolution | null): void {
  if (resolution !== null && pendingResolution === resolution) pendingResolution = null;
}

export type ChatRouteUnavailable = "chat" | "project" | "projectChat";

export type ChatRouteTargets = Readonly<{
  /** Opens a personal chat; a chat readable only inside its Project reports that Project. */
  openChat(chatId: string): Promise<"failed" | "missing" | "opened" | Readonly<{ projectId: string }>>;
  /** Opens a Project and then its chat; `project` means only the Project opened. */
  openProject(
    projectId: string,
    chatId: string | null
  ): Promise<"opened" | "project" | "superseded" | "unavailable">;
  /** Shows the personal new chat, leaving any Project. */
  openBlank(): void;
  showUnavailable(target: ChatRouteUnavailable): void;
  /** The route of the state the shell now shows. */
  stateRoute(): ChatRoute;
}>;

/**
 * Resolves an address (`null` for a malformed one) into state and settles the
 * address on the resulting route. Unknown, foreign and malformed targets share
 * one privacy-neutral notice; a load failure keeps the address for a retry.
 * Results that arrive after another navigation are ignored.
 */
export async function resolveChatRoute(
  route: ChatRoute | null,
  resolution: ChatRouteResolution,
  targets: ChatRouteTargets
): Promise<ChatRoute | null> {
  const current = () => isCurrentChatRouteResolution(resolution);
  const openProject = async (target: Readonly<{ chatId: string | null; projectId: string }>) => {
    const outcome = await targets.openProject(target.projectId, target.chatId);
    if (!current() || outcome === "superseded") return false;
    if (outcome === "unavailable") {
      targets.openBlank();
      targets.showUnavailable(target.chatId ? "projectChat" : "project");
    } else if (outcome === "project" && target.chatId) {
      targets.showUnavailable("projectChat");
    }
    return true;
  };
  let settled: ChatRoute | null = null;
  try {
    if (!current()) return null;
    if (!route) {
      targets.openBlank();
      targets.showUnavailable("chat");
    } else if (route.projectId) {
      if (!await openProject({ chatId: route.chatId, projectId: route.projectId })) return null;
    } else if (route.chatId) {
      const outcome = await targets.openChat(route.chatId);
      if (!current() || outcome === "failed") return null;
      if (outcome === "missing") {
        targets.openBlank();
        targets.showUnavailable("chat");
      } else if (outcome !== "opened" &&
        !await openProject({ chatId: route.chatId, projectId: outcome.projectId })) {
        return null;
      }
    } else {
      targets.openBlank();
    }
    if (!current()) return null;
    settled = targets.stateRoute();
    return settled;
  } finally {
    settleChatRouteResolution(resolution, settled);
  }
}

/**
 * Keeps the address on the shown chat while that chat's own route changes in
 * place: a draft becomes addressable once its first send is under way, keeps
 * the address after the server admits it, and returns to its blank route when
 * the first send fails.
 */
export function useShownChatRoute(): void {
  const chat = useWorkspaceStore((state) => state.activeChatId
    ? state.chats.find((candidate) => candidate.id === state.activeChatId) ?? null
    : null);
  const chatId = chat?.id ?? null;
  const composing = useComposerSessionStore((state) =>
    chatId !== null && Boolean(selectComposerSession(state, composerSessionKey(chatId)).pendingSend));
  const streaming = useRunLifecycleStore((state) => chatId !== null && Boolean(state.activeStreams[chatId]));
  const path = chat ? formatChatRoutePath(chatRouteForChat(chat, composing || streaming)) : null;
  useEffect(() => {
    if (path !== null) writeChatRoute(chatRouteForState());
  }, [path]);
}

/**
 * Follows browser back/forward inside the chat pages. A guard that blocks the
 * traversal (busy or unsaved Studio work) puts the shown route back on top;
 * releasing it later adds the traversed route as a new entry.
 */
export function useChatRouteHistory(input: Readonly<{
  currentRoute(): ChatRoute;
  requestNavigation(proceed: () => void): void;
  resolve(route: ChatRoute | null, resolution: ChatRouteResolution): void;
}>): void {
  const latest = useRef(input);
  useEffect(() => {
    latest.current = input;
  });
  useEffect(() => {
    const onPopState = () => {
      const { pathname } = window.location;
      // Another page owns the traversed entry; the framework router shows it.
      if (!isChatRoutePathname(pathname)) return;
      const target = parseChatRoutePath(pathname);
      const origin = latest.current.currentRoute();
      if (target && sameChatRoute(target, origin)) return;
      let synchronous = true;
      let released = false;
      latest.current.requestNavigation(() => {
        if (released) return;
        released = true;
        if (!synchronous) commitRoute(target ?? BLANK_CHAT_ROUTE, true);
        latest.current.resolve(target, beginChatRouteResolution());
      });
      synchronous = false;
      if (!released) commitRoute(origin, true);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
}

function subscribeChatRoute(listener: () => void): () => void {
  routeListeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    routeListeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

function chatRoutePathSnapshot(): string {
  return formatChatRoutePath(currentChatRoute() ?? BLANK_CHAT_ROUTE);
}

/** The shown chat route's pathname; `/` during server rendering and outside the chat pages. */
export function useChatRoutePath(): string {
  return useSyncExternalStore(subscribeChatRoute, chatRoutePathSnapshot, () => "/");
}

/** Control Center link that returns to the chat it was opened from. */
export function useControlCenterHref(): string {
  return controlCenterHref(useChatRoutePath());
}
