import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createGetChatTitleHandler } from "@/lib/server/chats/titleMetadata";
import { prisma } from "@/lib/server/prisma";

export const runtime = "nodejs";
export const GET = createGetChatTitleHandler({ client: prisma, resolveAuth: resolveRequestAuth });
