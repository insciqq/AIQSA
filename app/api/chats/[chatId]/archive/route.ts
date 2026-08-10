import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import {
  createArchiveChatExplicitHandler,
  createGetArchivedChatHandler
} from "@/lib/server/chats/lifecycleHandlers";
import { createPrismaChatRepository } from "@/lib/server/chats/prismaRepository";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

const deps = {
  repository: createPrismaChatRepository(),
  resolveAuth: resolveRequestAuth
};

export const GET = createGetArchivedChatHandler(deps);
export const POST = createArchiveChatExplicitHandler(deps);
