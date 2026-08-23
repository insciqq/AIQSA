import { resolveRequestAuth } from "../../auth/defaultAuth";
import { getAuthConfig } from "../../auth/config";
import { exposeFakeProvider } from "../../catalog/prismaCatalogData";
import { prisma } from "../../prisma";
import { createAdminProviderCredentialTester } from "./credentialTester";
import {
  createAdminProviderQuickSetupClearHandler,
  createAdminProviderQuickSetupMutationHandler,
  createAdminProviderQuickSetupSnapshotHandler
} from "./quickSetupHandlers";
import { createPrismaAdminProviderQuickSetupRepository } from "./quickSetupPrismaRepository";
import {
  createAdminProviderQuickSetupService,
  deriveAdminProviderQuickSetupStateTokenKey
} from "./quickSetupService";
import { createProviderPdfInputProbe } from "../../providers/pdfInputProbe";

const repository = createPrismaAdminProviderQuickSetupRepository(prisma, {
  exposeFake: exposeFakeProvider()
});

export const adminProviderQuickSetupService = createAdminProviderQuickSetupService({
  credentialTester: createAdminProviderCredentialTester(),
  pdfInputProbe: createProviderPdfInputProbe(),
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
export const adminProviderQuickSetupDELETE = createAdminProviderQuickSetupClearHandler(deps);
