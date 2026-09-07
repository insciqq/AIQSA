import { createAdminAttentionHandler } from "@/lib/server/admin/attention/handlers";
import { createAdminAttentionService } from "@/lib/server/admin/attention/service";
import { adminKnowledgePolicyService } from "@/lib/server/admin/knowledge/policyDefault";
import { defaultAdminMemoryStatusService } from "@/lib/server/admin/memory/statusDefault";
import { adminProviderService } from "@/lib/server/admin/providers/defaultProviders";
import { adminSystemModelPolicyService } from "@/lib/server/admin/providers/systemModelPolicyDefault";
import { adminSearchService } from "@/lib/server/admin/search/defaultService";
import { adminRepository, resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { adminEmailService } from "@/lib/server/email/defaultEmail";
import { mcpRepository } from "@/lib/server/mcp/defaultMcp";

export const runtime = "nodejs";

const service = createAdminAttentionService({
  sources: {
    dashboard: (actingAdminUserId) => adminRepository.listDashboard(actingAdminUserId),
    email: async () => {
      const result = await adminEmailService.read();
      if (result.ok) return result.value;
      throw new Error(result.code);
    },
    knowledge: () => adminKnowledgePolicyService.list(),
    mcp: (actingAdminUserId) => mcpRepository.listAdminServers(actingAdminUserId),
    memory: () => defaultAdminMemoryStatusService.get(),
    providers: () => adminProviderService.listConnections(),
    search: (actingAdminUserId) => adminSearchService.list({ userId: actingAdminUserId }),
    systemRoles: () => adminSystemModelPolicyService.list()
  }
});

export const GET = createAdminAttentionHandler({
  resolveAuth: resolveRequestAuth,
  service
});
