import { prisma } from "../../prisma";
import { createPrismaAdminProviderRepository } from "./prismaRepository";
import { createAdminProviderCredentialTester } from "./credentialTester";
import { createAdminProviderService } from "./service";
import { createAdminProviderDraftTester } from "./tester";
import { createAdminProviderBootstrap } from "./bootstrapService";
import { createAdminModelPolicyService } from "./modelPolicyService";
import { createAdminSystemModelPolicyService } from "./systemModelPolicyService";
import { adminSearchService } from "../search/defaultService";

export const adminProviderService = createAdminProviderService({
  completeSetup: (input) => completeSetup(input),
  credentialTester: createAdminProviderCredentialTester(),
  repository: createPrismaAdminProviderRepository(prisma),
  tester: createAdminProviderDraftTester()
});

const completeSetup = createAdminProviderBootstrap({
  providers: adminProviderService,
  chat: createAdminModelPolicyService(prisma),
  roles: createAdminSystemModelPolicyService(prisma),
  search: adminSearchService
});
