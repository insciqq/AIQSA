import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createListArchivedChatsHandler } from "@/lib/server/chats/lifecycleHandlers";
import { createPrismaChatRepository } from "@/lib/server/chats/prismaRepository";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export const GET = createListArchivedChatsHandler({
  repository: createPrismaChatRepository(),
  resolveAuth: resolveRequestAuth
});
