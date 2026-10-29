import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { createSubagentStopHandler } from "@/lib/server/runs/subagentBackground/handlers";
import { defaultSubagentRouteDeps } from "@/lib/server/runs/subagentBackground/routeDeps";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export const POST: AsyncRouteHandler<ReturnType<typeof createSubagentStopHandler>> =
  createSubagentStopHandler(defaultSubagentRouteDeps);
