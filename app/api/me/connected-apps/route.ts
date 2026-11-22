import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createListConnectedAppsHandler } from "@/lib/server/mcp/inboundOAuth/connectedApps";
import { defaultInboundMcpOAuthService } from "@/lib/server/mcp/inboundOAuth/default";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export const GET = createListConnectedAppsHandler({
  resolveAuth: resolveRequestAuth,
  service: defaultInboundMcpOAuthService
});
