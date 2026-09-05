import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createDeleteMessageHandler, createEditMessageBranchHandler } from "@/lib/server/messages/handlers";
import { createPrismaMessageBranchRepository } from "@/lib/server/messages/prismaRepository";

export const runtime = "nodejs";

const repository = createPrismaMessageBranchRepository();

export const PATCH: AsyncRouteHandler<ReturnType<typeof createEditMessageBranchHandler>> = createEditMessageBranchHandler({
  repository,
  resolveAuth: resolveRequestAuth
});

export const DELETE: AsyncRouteHandler<ReturnType<typeof createDeleteMessageHandler>> = createDeleteMessageHandler({
  repository,
  resolveAuth: resolveRequestAuth
});
