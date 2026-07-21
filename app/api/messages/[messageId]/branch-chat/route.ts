import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createBranchChatFromMessageHandler } from "@/lib/server/messages/handlers";
import { createPrismaMessageBranchRepository } from "@/lib/server/messages/prismaRepository";

export const runtime = "nodejs";

const repository = createPrismaMessageBranchRepository();

export const POST = createBranchChatFromMessageHandler({
  repository,
  resolveAuth: resolveRequestAuth
});
