import { agentConnectionMetadataSchema } from "@/lib/contracts/agentConnections";
import { getAuthConfig } from "@/lib/server/auth/config";
import { isMcpHubEnabled } from "@/lib/server/mcp/hubConfiguration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  try {
    const base = new URL(getAuthConfig().appBaseUrl);
    if (base.username || base.password || base.hash || base.search) throw new Error("invalid_base_url");
    const metadata = agentConnectionMetadataSchema.parse({ origin: base.origin, hubEnabled: isMcpHubEnabled() });
    return Response.json(metadata, { headers: { "cache-control": "public, max-age=300" } });
  } catch {
    return Response.json({ error: "agent_connections_unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
