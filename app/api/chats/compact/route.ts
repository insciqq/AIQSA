import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import {
  createListChatNavigationHandler,
  createPrismaChatNavigationRepository
} from "@/lib/server/chats/navigation";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export const GET = createListChatNavigationHandler({
  repository: createPrismaChatNavigationRepository(),
  resolveAuth: resolveRequestAuth
});
