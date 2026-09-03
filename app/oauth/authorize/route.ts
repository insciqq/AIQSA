import { defaultInboundMcpAuthorizationHandlers } from "@/lib/server/memoryMcp/oauth/default";

export const runtime = "nodejs";

export const GET = defaultInboundMcpAuthorizationHandlers.GET;
export const POST = defaultInboundMcpAuthorizationHandlers.POST;
