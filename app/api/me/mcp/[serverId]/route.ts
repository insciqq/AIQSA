import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { mcpRepository } from "@/lib/server/mcp/defaultMcp";
import { defaultMcpOperationalStatus, kickDefaultMcpRuntime } from "@/lib/server/mcp/defaultRuntime";
import { createUserMcpUpdateHandler } from "@/lib/server/mcp/handlers";

export const runtime = "nodejs";

export const PATCH = createUserMcpUpdateHandler({
  onRuntimeChanged: kickDefaultMcpRuntime,
  runtimeOperationalStatus: defaultMcpOperationalStatus,
  repository: mcpRepository,
  resolveAuth: resolveRequestAuth
});
