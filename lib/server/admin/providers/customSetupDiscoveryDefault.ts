import { resolveRequestAuth } from "../../auth/defaultAuth";
import { getAuthConfig } from "../../auth/config";
import { createAdminProviderCredentialTester } from "./credentialTester";
import { createAdminProviderCustomDiscoveryHandler } from "./customSetupDiscoveryHandlers";

export const adminProviderCustomDiscoveryPOST = createAdminProviderCustomDiscoveryHandler({
  proofKey: () => getAuthConfig().sessionSecret,
  resolveAuth: resolveRequestAuth,
  tester: createAdminProviderCredentialTester()
});
