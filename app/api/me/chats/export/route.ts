import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import {
  createExportAllChatsHandler,
  personalChatExportEntries
} from "@/lib/server/chats/exportAll";
import { prisma } from "@/lib/server/prisma";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export const GET = createExportAllChatsHandler({
  entries: (userId, exportedAt) => personalChatExportEntries(prisma, userId, exportedAt),
  resolveAuth: resolveRequestAuth
});
