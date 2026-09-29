import { getAuthConfig } from "@/lib/server/auth/config";
import { publicAgentGuideResponse } from "@/lib/server/agents/guide";
import { isMcpHubEnabled } from "@/lib/server/mcp/hubConfiguration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  return publicAgentGuideResponse(getAuthConfig().appBaseUrl, isMcpHubEnabled());
}
