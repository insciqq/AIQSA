import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { mcpRepository } from "@/lib/server/mcp/defaultMcp";
import { kickDefaultMcpRuntime } from "@/lib/server/mcp/defaultRuntime";
import { createAdminMcpActivateHandler } from "@/lib/server/mcp/handlers";

export const runtime = "nodejs";

export const POST = createAdminMcpActivateHandler({
  onRuntimeChanged: kickDefaultMcpRuntime,
  repository: mcpRepository,
  resolveAuth: resolveRequestAuth
});
