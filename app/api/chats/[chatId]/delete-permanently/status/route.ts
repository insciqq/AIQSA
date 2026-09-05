import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import {
  defaultPermanentChatDeletionHandlerDeps
} from "@/lib/server/chats/permanentDeletion/default";
import {
  createPermanentChatDeleteStatusHandler
} from "@/lib/server/chats/permanentDeletion/handlers";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export const GET: AsyncRouteHandler<ReturnType<typeof createPermanentChatDeleteStatusHandler>> = createPermanentChatDeleteStatusHandler(
  defaultPermanentChatDeletionHandlerDeps
);
