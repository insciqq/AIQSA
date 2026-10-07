import { readDefaultHealthFindings } from "@/lib/server/admin/attention/defaultHealth";
import { createAdminAttentionSummaryHandler } from "@/lib/server/admin/attention/handlers";
import { createAdminAttentionSummaryService } from "@/lib/server/admin/attention/summary";
import { adminHealthQueuesService } from "@/lib/server/admin/health/queuesDefault";
import { adminProviderService } from "@/lib/server/admin/providers/defaultProviders";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";

export const runtime = "nodejs";

// Module scope: the in-process cache is shared by every administrator's shell.
const service = createAdminAttentionSummaryService({
  sources: {
    health: readDefaultHealthFindings,
    providers: () => adminProviderService.listConnections(),
    queues: () => adminHealthQueuesService.stalled()
  }
});

export const GET = createAdminAttentionSummaryHandler({
  resolveAuth: resolveRequestAuth,
  service
});
