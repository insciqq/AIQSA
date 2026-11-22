import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createRevokeConnectedAppHandler } from "@/lib/server/mcp/inboundOAuth/connectedApps";
import { defaultInboundMcpOAuthService } from "@/lib/server/mcp/inboundOAuth/default";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const DELETE: AsyncRouteHandler<ReturnType<typeof createRevokeConnectedAppHandler>> = createRevokeConnectedAppHandler({
  resolveAuth: resolveRequestAuth,
  service: defaultInboundMcpOAuthService
});
