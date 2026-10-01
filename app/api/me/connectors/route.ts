import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { getAuthConfig } from "@/lib/server/auth/config";
import { mcpRepository } from "@/lib/server/mcp/defaultMcp";
import { createConnectorCatalogHandler } from "@/lib/server/connectors/handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = createConnectorCatalogHandler({ getConfig: () => getAuthConfig(), repository: mcpRepository, resolveAuth: resolveRequestAuth });
