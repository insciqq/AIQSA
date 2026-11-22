import { defaultInboundMcpAuthorizationHandlers } from "@/lib/server/mcp/inboundOAuth/default";

export const runtime = "nodejs";

export const GET = defaultInboundMcpAuthorizationHandlers.GET;
export const POST = defaultInboundMcpAuthorizationHandlers.POST;
