import {
  createProviderAdaptersFromEnv,
  createSearchProviderAdaptersFromEnv
} from "../providers/registry";
import { createS3StorageAdapter } from "../uploads/storage";
import { activeRunControllerRegistry } from "./runExecution";
import { createPrismaRunRepository } from "./prismaRepository";
import { reconcileInstallationRuns } from "./runRecovery";
import { RunRecoveryScheduler } from "./recoveryScheduler";

const globalForRecoveryScheduler = globalThis as unknown as {
  __aiqsaRunRecoveryScheduler?: RunRecoveryScheduler;
};

export function getDefaultRunRecoveryScheduler(): RunRecoveryScheduler {
  if (!globalForRecoveryScheduler.__aiqsaRunRecoveryScheduler) {
    const deps = {
      providers: createProviderAdaptersFromEnv(),
      registry: activeRunControllerRegistry,
      repository: createPrismaRunRepository(),
      searchProviders: createSearchProviderAdaptersFromEnv(),
      storage: createS3StorageAdapter()
    };
    globalForRecoveryScheduler.__aiqsaRunRecoveryScheduler = new RunRecoveryScheduler({
      reconcile: () => reconcileInstallationRuns(deps)
    });
  }
  return globalForRecoveryScheduler.__aiqsaRunRecoveryScheduler;
}

export function startDefaultRunRecoveryScheduler(): void {
  getDefaultRunRecoveryScheduler().start();
}
