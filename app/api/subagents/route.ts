import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { createSubagentSummaryHandler } from "@/lib/server/runs/subagentBackground/handlers";
import { defaultSubagentRouteDeps } from "@/lib/server/runs/subagentBackground/routeDeps";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export const GET: AsyncRouteHandler<ReturnType<typeof createSubagentSummaryHandler>> =
  createSubagentSummaryHandler(defaultSubagentRouteDeps);
