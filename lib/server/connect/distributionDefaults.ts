import { getAuthConfig } from "../auth/config";
import { applicationRootPath } from "../runtimeModulePath";
import { CONNECT_SERVER_VERSION } from "./deviceHandlers";
import {
  canonicalConnectOrigin,
  connectClientDistDirectory,
  createConnectClientDistributionReader,
  createConnectDistributionHandlers
} from "./distribution";
import { getConnectPolicyGate } from "./policy";

export const connectDistributionHandlers = createConnectDistributionHandlers({
  distribution: createConnectClientDistributionReader(() => connectClientDistDirectory(applicationRootPath())),
  origin: () => canonicalConnectOrigin(getAuthConfig().appBaseUrl),
  policy: getConnectPolicyGate(),
  version: CONNECT_SERVER_VERSION
});
