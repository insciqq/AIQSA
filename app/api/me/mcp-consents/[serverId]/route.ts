import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { mcpApprovalHandlers } from "@/lib/server/mcp/defaultWriteApproval";

export const runtime = "nodejs";

export const DELETE: AsyncRouteHandler<typeof mcpApprovalHandlers.DELETE_CONSENT> = mcpApprovalHandlers.DELETE_CONSENT;
