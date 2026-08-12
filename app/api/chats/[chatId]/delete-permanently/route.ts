import {
  defaultPermanentChatDeletionHandlerDeps
} from "@/lib/server/chats/permanentDeletion/default";
import {
  createPermanentChatDeleteAdmissionHandler
} from "@/lib/server/chats/permanentDeletion/handlers";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export const POST = createPermanentChatDeleteAdmissionHandler(
  defaultPermanentChatDeletionHandlerDeps
);
