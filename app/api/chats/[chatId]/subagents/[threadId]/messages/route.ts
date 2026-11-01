import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { getDefaultSubagentBackground } from "@/lib/server/runs/subagentBackground/default";
import { defaultSubagentRouteDeps } from "@/lib/server/runs/subagentBackground/routeDeps";
import { createSubagentUserMessageHandler } from "@/lib/server/runs/subagentBackground/userMessageHandler";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export const POST: AsyncRouteHandler<ReturnType<typeof createSubagentUserMessageHandler>> = createSubagentUserMessageHandler({
  ...defaultSubagentRouteDeps,
  control: { deliverUser: (input) => getDefaultSubagentBackground().control.deliverUser(input) }
});
