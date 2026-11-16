import { applicationRootPath } from "../runtimeModulePath";
import { CONNECT_SERVER_VERSION } from "./deviceHandlers";
import {
  connectClientDistDirectory,
  createConnectClientDistributionReader,
  createConnectDistributionHandlers
} from "./distribution";
import { connectInstallOrigin } from "./installOrigin";
import { getConnectPolicyGate } from "./policy";

export const connectDistributionHandlers = createConnectDistributionHandlers({
  distribution: createConnectClientDistributionReader(() => connectClientDistDirectory(applicationRootPath())),
  origin: connectInstallOrigin,
  policy: getConnectPolicyGate(),
  version: CONNECT_SERVER_VERSION
});
