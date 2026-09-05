import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createWorkspaceExportHistoryHandler } from "@/lib/server/workspace/exportHistoryHandlers";
import { createWorkspaceExportHistoryRepository } from "@/lib/server/workspace/exportHistoryRepository";

export const runtime = "nodejs";
export const GET: AsyncRouteHandler<ReturnType<typeof createWorkspaceExportHistoryHandler>> = createWorkspaceExportHistoryHandler({
  repository: createWorkspaceExportHistoryRepository(), resolveAuth: resolveRequestAuth
});
