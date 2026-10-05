import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createImportChatsHandler, importChatForUser } from "@/lib/server/chats/importChats";
import { prisma } from "@/lib/server/prisma";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export const POST = createImportChatsHandler({
  importChat: (userId, item) => importChatForUser(prisma, userId, item),
  resolveAuth: resolveRequestAuth
});
