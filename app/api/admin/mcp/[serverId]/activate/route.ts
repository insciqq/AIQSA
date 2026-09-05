import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { kickDefaultMcpActivation } from "@/lib/server/mcp/defaultActivation";
import { mcpRepository } from "@/lib/server/mcp/defaultMcp";
import { kickDefaultMcpRuntime } from "@/lib/server/mcp/defaultRuntime";
import { createAdminMcpActivateHandler } from "@/lib/server/mcp/handlers";

export const runtime = "nodejs";

export const POST: AsyncRouteHandler<ReturnType<typeof createAdminMcpActivateHandler>> = createAdminMcpActivateHandler({
  onActivationRequested: kickDefaultMcpActivation,
  onRuntimeChanged: kickDefaultMcpRuntime,
  repository: mcpRepository,
  resolveAuth: resolveRequestAuth
});
