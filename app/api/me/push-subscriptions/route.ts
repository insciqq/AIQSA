import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { prisma } from "@/lib/server/prisma";
import { getDefaultBrowserPush } from "@/lib/server/push/defaultBrowserPush";
import { createBrowserPushHandlers } from "@/lib/server/push/handlers";
import { createPrismaBrowserPushStore } from "@/lib/server/push/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const handlers = createBrowserPushHandlers({
  keys: () => getDefaultBrowserPush().keys(),
  resolveAuth: resolveRequestAuth,
  store: createPrismaBrowserPushStore(prisma)
});

export const GET = handlers.key;
export const POST = handlers.subscribe;
export const DELETE = handlers.unsubscribe;
