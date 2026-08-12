import {
  defaultPermanentChatDeletionHandlerDeps
} from "@/lib/server/chats/permanentDeletion/default";
import {
  createPermanentChatDeleteStatusHandler
} from "@/lib/server/chats/permanentDeletion/handlers";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export const GET = createPermanentChatDeleteStatusHandler(
  defaultPermanentChatDeletionHandlerDeps
);
