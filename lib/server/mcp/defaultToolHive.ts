import { createHmac } from "node:crypto";
import { getMcpEncryptionKey } from "./encryption";
import type { McpRuntimeLifecycle } from "./runtimeCoordinator";
import { ToolHiveClient } from "./toolhiveClient";
import { ToolHiveMcpRuntimeDriver } from "./toolhiveRuntimeDriver";

type ToolHiveGlobal = typeof globalThis & {
  __aiqsaToolHiveClient?: ToolHiveClient;
  __aiqsaToolHiveDriver?: ToolHiveMcpRuntimeDriver;
};

function ownerToken(): string {
  return createHmac("sha256", getMcpEncryptionKey())
    .update("aiqsa-toolhive-installation-owner-v1")
    .digest("hex")
    .slice(0, 20);
}

export function getDefaultToolHiveClient(): ToolHiveClient {
  const scope = globalThis as ToolHiveGlobal;
  scope.__aiqsaToolHiveClient ??= new ToolHiveClient({
    baseUrl: process.env.AIQSA_TOOLHIVE_URL ?? "http://toolhive-runtime:8080"
  });
  return scope.__aiqsaToolHiveClient;
}

export function getDefaultToolHiveDriver(): ToolHiveMcpRuntimeDriver {
  const scope = globalThis as ToolHiveGlobal;
  scope.__aiqsaToolHiveDriver ??= new ToolHiveMcpRuntimeDriver({
    client: getDefaultToolHiveClient(),
    ownerToken: ownerToken()
  });
  return scope.__aiqsaToolHiveDriver;
}

export function createToolHiveRuntimeLifecycle(
  driver: Pick<ToolHiveMcpRuntimeDriver, "cleanupOwnedWorkloads">
): McpRuntimeLifecycle {
  return {
    async cleanupOrphans(keepGenerationTokens) {
      await driver.cleanupOwnedWorkloads({ keepGenerationTokens });
    }
  };
}
