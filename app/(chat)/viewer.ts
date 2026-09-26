import { getAuthConfig } from "@/lib/server/auth/config";
import { authSessionStore } from "@/lib/server/auth/defaultAuth";
import { resolveAuthToken } from "@/lib/server/auth/requestAuth";
import { SESSION_COOKIE_NAME } from "@/lib/server/auth/session";
import { prisma } from "@/lib/server/prisma";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

export type ChatViewer = Readonly<{
  accountDisplayName: string;
  accountEmail: string | null;
  accountId: string;
  adminEntryVisible: boolean;
}>;

export type ChatPageSearchParams = Promise<Record<string, string | string[] | undefined>>;

/** One session lookup per request, shared by the chat layout and its pages. */
export const loadChatViewer = cache(async (): Promise<ChatViewer | null> => {
  if (!getAuthConfig().configured) return null;
  const cookieStore = await cookies();
  const session = await resolveAuthToken(cookieStore.get(SESSION_COOKIE_NAME)?.value, {
    sessions: authSessionStore
  });
  if (!session) return null;
  const user = await prisma.user.findUnique({
    select: { displayName: true, email: true, role: true, status: true },
    where: { id: session.userId }
  });
  if (!user || user.status !== "active") return null;
  return {
    accountDisplayName: user.displayName,
    accountEmail: user.email,
    accountId: session.userId,
    adminEntryVisible: user.role === "admin"
  };
});

export function chatPageQuery(values: Awaited<ChatPageSearchParams>): URLSearchParams {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    for (const entry of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      query.append(key, entry);
    }
  }
  return query;
}

/**
 * A layout cannot see its address, so each page authorizes with its own: a
 * stale session signs in again and returns exactly there. Chat existence and
 * access are resolved by the client, identically for invisible and missing ids.
 */
export async function authorizeChatPage(pathname: string, query: URLSearchParams): Promise<void> {
  if (await loadChatViewer()) return;
  if (!getAuthConfig().configured) redirect("/login");
  const address = `${pathname}${query.size > 0 ? `?${query}` : ""}`;
  redirect(address === "/" ? "/login" : `/login?${new URLSearchParams({ next: address })}`);
}
