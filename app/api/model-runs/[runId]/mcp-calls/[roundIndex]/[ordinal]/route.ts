import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { prisma } from "@/lib/server/prisma";
import { createS3StorageAdapter } from "@/lib/server/uploads/storage";
import { createGetMcpCallDetailsHandler } from "@/lib/server/mcp/callDetailsHandler";
import { mcpCallDetailsForStorage } from "@/lib/server/mcp/callDetailsServices";

export const runtime = "nodejs";
export const GET: AsyncRouteHandler<ReturnType<typeof createGetMcpCallDetailsHandler>> = createGetMcpCallDetailsHandler({
  resolveAuth: resolveRequestAuth,
  read: mcpCallDetailsForStorage(prisma, createS3StorageAdapter())
});
