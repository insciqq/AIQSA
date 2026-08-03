import { resolveRequestAuth } from "../../auth/defaultAuth";
import { exposeFakeProvider } from "../../catalog/prismaCatalogData";
import { prisma } from "../../prisma";
import { createAdminProviderCustomSetupHandler } from "./customSetupHandlers";
import { createPrismaAdminProviderCustomSetupRepository } from "./customSetupPrismaRepository";
import {
  createAdminProviderCustomSetupService,
  type AdminProviderCustomSetupTester
} from "./customSetupService";
import { createAdminProviderDraftTester } from "./tester";

const draftTester = createAdminProviderDraftTester();
const tester: AdminProviderCustomSetupTester = {
  test(input) {
    return draftTester.test({
      connection: input.connection,
      connectionDisplayName: input.connectionDisplayName,
      connectionId: input.connectionId,
      credentialId: input.credentialId,
      credentialVersionIdentity: input.credentialVersionIdentity,
      mode: "tiny_generation",
      model: input.model,
      modelDisplayName: input.modelDisplayName,
      providerFamily: input.providerFamily,
      providerModelId: input.providerModelId,
      secret: input.secret,
      signal: input.signal
    });
  }
};

const repository = createPrismaAdminProviderCustomSetupRepository(prisma, {
  exposeFake: exposeFakeProvider()
});

export const adminProviderCustomSetupService = createAdminProviderCustomSetupService({
  repository,
  tester
});

export const adminProviderCustomSetupPOST = createAdminProviderCustomSetupHandler({
  resolveAuth: resolveRequestAuth,
  service: adminProviderCustomSetupService
});
