import { defaultInboundMcpOAuthConfiguration } from "@/lib/server/memoryMcp/oauth/default";
import { inboundMcpAuthorizationServerMetadata } from "@/lib/server/memoryMcp/oauth/service";

export const runtime = "nodejs";

export function GET(): Response {
  return Response.json(
    inboundMcpAuthorizationServerMetadata(defaultInboundMcpOAuthConfiguration),
    {
      headers: {
        "access-control-allow-origin": "*",
        "cache-control": "public, max-age=300",
        "content-type": "application/json"
      }
    }
  );
}
