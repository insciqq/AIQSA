import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createListMemoryMcpConnectedAppsHandler } from "@/lib/server/memoryMcp/connectedApps";
import { defaultInboundMcpOAuthService } from "@/lib/server/memoryMcp/oauth/default";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export const GET = createListMemoryMcpConnectedAppsHandler({
  resolveAuth: resolveRequestAuth,
  service: defaultInboundMcpOAuthService
});
