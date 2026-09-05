import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createRevokeMemoryMcpConnectedAppHandler } from "@/lib/server/memoryMcp/connectedApps";
import { defaultInboundMcpOAuthService } from "@/lib/server/memoryMcp/oauth/default";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const DELETE: AsyncRouteHandler<ReturnType<typeof createRevokeMemoryMcpConnectedAppHandler>> = createRevokeMemoryMcpConnectedAppHandler({
  resolveAuth: resolveRequestAuth,
  service: defaultInboundMcpOAuthService
});
