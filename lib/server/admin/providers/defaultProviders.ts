import { prisma } from "../../prisma";
import { createPrismaAdminProviderRepository } from "./prismaRepository";
import { createAdminProviderCredentialTester } from "./credentialTester";
import { createAdminProviderService } from "./service";
import { createAdminProviderDraftTester } from "./tester";

export const adminProviderService = createAdminProviderService({
  credentialTester: createAdminProviderCredentialTester(),
  repository: createPrismaAdminProviderRepository(prisma),
  tester: createAdminProviderDraftTester()
});
