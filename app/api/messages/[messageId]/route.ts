import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createDeleteMessageHandler, createEditMessageBranchHandler } from "@/lib/server/messages/handlers";
import { createPrismaMessageBranchRepository } from "@/lib/server/messages/prismaRepository";

export const runtime = "nodejs";

const repository = createPrismaMessageBranchRepository();

export const PATCH = createEditMessageBranchHandler({
  repository,
  resolveAuth: resolveRequestAuth
});

export const DELETE = createDeleteMessageHandler({
  repository,
  resolveAuth: resolveRequestAuth
});
