import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import {
  createDeleteAllPersonalChatsHandler,
  createPrismaPersonalChatLister
} from "@/lib/server/chats/deleteAll";
import {
  defaultPermanentChatDeletionService,
  permanentChatDeletionCapability
} from "@/lib/server/chats/permanentDeletion/default";
import { createPrismaChatRepository } from "@/lib/server/chats/prismaRepository";
import { prisma } from "@/lib/server/prisma";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

const chatRepository = createPrismaChatRepository();

export const POST = createDeleteAllPersonalChatsHandler({
  archive: chatRepository.setArchived,
  capability: permanentChatDeletionCapability,
  deletion: defaultPermanentChatDeletionService,
  listPersonalChats: createPrismaPersonalChatLister(prisma),
  resolveAuth: resolveRequestAuth
});
