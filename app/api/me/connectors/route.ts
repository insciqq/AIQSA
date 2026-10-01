import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { getAuthConfig } from "@/lib/server/auth/config";
import { mcpRepository } from "@/lib/server/mcp/defaultMcp";
import { defaultMcpOperationalStatus } from "@/lib/server/mcp/defaultRuntime";
import { createConnectorCatalogHandler } from "@/lib/server/connectors/handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = createConnectorCatalogHandler({ getConfig: () => getAuthConfig(), repository: mcpRepository, resolveAuth: resolveRequestAuth, runtimeOperationalStatus: defaultMcpOperationalStatus });
