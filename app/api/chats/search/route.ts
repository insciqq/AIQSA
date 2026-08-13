import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import {
  createPrismaChatNavigationRepository,
  createSearchChatNavigationHandler
} from "@/lib/server/chats/navigation";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export const GET = createSearchChatNavigationHandler({
  repository: createPrismaChatNavigationRepository(),
  resolveAuth: resolveRequestAuth
});
