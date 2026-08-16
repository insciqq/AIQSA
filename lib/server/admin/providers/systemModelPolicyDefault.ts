import { prisma } from "../../prisma";
import { adminProviderService } from "./defaultProviders";
import { createAdminSystemModelPolicyService } from "./systemModelPolicyService";

export const adminSystemModelPolicyService = createAdminSystemModelPolicyService(prisma, {
  refreshActive: (input) => adminProviderService.refreshActive(input)
});
