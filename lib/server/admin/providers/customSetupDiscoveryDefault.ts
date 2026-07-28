import { resolveRequestAuth } from "../../auth/defaultAuth";
import { createAdminProviderCredentialTester } from "./credentialTester";
import { createAdminProviderCustomDiscoveryHandler } from "./customSetupDiscoveryHandlers";

export const adminProviderCustomDiscoveryPOST = createAdminProviderCustomDiscoveryHandler({
  resolveAuth: resolveRequestAuth,
  tester: createAdminProviderCredentialTester()
});
