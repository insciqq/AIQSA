import { getAuthConfig } from "../auth/config";
import { canonicalConnectOrigin } from "./distribution";

/**
 * The origin AIQSA Connect's install commands, downloads and `install.sh`
 * name: this installation's canonical base URL, or null when it is not a
 * plain origin a shell command can carry. A public address, not a secret.
 */
export function connectInstallOrigin(): string | null {
  return canonicalConnectOrigin(getAuthConfig().appBaseUrl);
}
