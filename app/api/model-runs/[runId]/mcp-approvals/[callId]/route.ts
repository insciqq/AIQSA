import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { mcpApprovalHandlers } from "@/lib/server/mcp/defaultWriteApproval";

export const runtime = "nodejs";

export const POST: AsyncRouteHandler<typeof mcpApprovalHandlers.POST_DECISION> = mcpApprovalHandlers.POST_DECISION;
