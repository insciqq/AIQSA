import { resolveRequestAuth } from "../../auth/defaultAuth";
import { getAuthConfig } from "../../auth/config";
import { exposeFakeProvider } from "../../catalog/prismaCatalogData";
import { prisma } from "../../prisma";
import { createAdminProviderCredentialTester } from "./credentialTester";
import { adminProviderService } from "./defaultProviders";
import {
  createAdminProviderQuickSetupMutationHandler,
  createAdminProviderQuickSetupSnapshotHandler
} from "./quickSetupHandlers";
import { createPrismaAdminProviderQuickSetupRepository } from "./quickSetupPrismaRepository";
import {
  createAdminProviderQuickSetupService,
  deriveAdminProviderQuickSetupStateTokenKey
} from "./quickSetupService";
import { createProviderPdfInputProbe } from "../../providers/pdfInputProbe";
import { createAdminProviderDraftTester } from "./tester";

const repository = createPrismaAdminProviderQuickSetupRepository(prisma, {
  exposeFake: exposeFakeProvider()
});

export const adminProviderQuickSetupService = createAdminProviderQuickSetupService({
  credentialTester: createAdminProviderCredentialTester(),
  finishInitialSetup: (completion) => adminProviderService.finishInitialSetup(completion),
  pdfInputProbe: createProviderPdfInputProbe(),
  rerankerTester: createAdminProviderDraftTester(),
  repository,
  stateTokenKey: () => deriveAdminProviderQuickSetupStateTokenKey(
    getAuthConfig().sessionSecret
  )
});

const deps = {
  resolveAuth: resolveRequestAuth,
  service: adminProviderQuickSetupService
};

export const adminProviderQuickSetupGET = createAdminProviderQuickSetupSnapshotHandler(deps);
export const adminProviderQuickSetupPOST = createAdminProviderQuickSetupMutationHandler(deps);
