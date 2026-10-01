import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { mcpRepository } from "@/lib/server/mcp/defaultMcp";
import { getDefaultMcpRuntimeCoordinator, kickDefaultMcpRuntime } from "@/lib/server/mcp/defaultRuntime";
import { createPersonalMcpDeleteHandler, createPersonalMcpUpdateHandler } from "@/lib/server/mcp/personalHandlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const deps = {
  onConnectionChanged: (userId: string, serverId: string) => getDefaultMcpRuntimeCoordinator()
    .ensureUserServersReady(userId, [serverId], AbortSignal.timeout(20_000)),
  onRuntimeChanged: kickDefaultMcpRuntime,
  repository: mcpRepository,
  resolveAuth: resolveRequestAuth
};
export const PATCH: AsyncRouteHandler<ReturnType<typeof createPersonalMcpUpdateHandler>> = createPersonalMcpUpdateHandler(deps);
export const DELETE: AsyncRouteHandler<ReturnType<typeof createPersonalMcpDeleteHandler>> = createPersonalMcpDeleteHandler(deps);
