import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { mcpRepository } from "@/lib/server/mcp/defaultMcp";
import { kickDefaultMcpRuntime } from "@/lib/server/mcp/defaultRuntime";
import { createUserMcpUpdateHandler } from "@/lib/server/mcp/handlers";

export const runtime = "nodejs";

export const PATCH: AsyncRouteHandler<ReturnType<typeof createUserMcpUpdateHandler>> = createUserMcpUpdateHandler({
  onRuntimeChanged: kickDefaultMcpRuntime,
  repository: mcpRepository,
  resolveAuth: resolveRequestAuth
});
