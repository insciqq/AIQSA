import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createListChatSharesHandler, createShareChatHandler } from "@/lib/server/shares/handlers";
import { createPrismaShareRepository } from "@/lib/server/shares/prismaRepository";

export const runtime = "nodejs";

const repository = createPrismaShareRepository();

export const GET = createListChatSharesHandler({
  repository,
  resolveAuth: resolveRequestAuth
});

export const POST = createShareChatHandler({
  repository,
  resolveAuth: resolveRequestAuth
});
