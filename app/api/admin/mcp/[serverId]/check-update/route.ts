import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { mcpRepository } from "@/lib/server/mcp/defaultMcp";
import { createAdminMcpCheckUpdateHandler } from "@/lib/server/mcp/handlers";

export const runtime = "nodejs";

export const POST: AsyncRouteHandler<ReturnType<typeof createAdminMcpCheckUpdateHandler>> = createAdminMcpCheckUpdateHandler({
  repository: mcpRepository,
  resolveAuth: resolveRequestAuth
});
