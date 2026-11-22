import "./worker-bootstrap.cjs";
import { prisma } from "../lib/server/prisma";
import { registerDefaultBackgroundPasses } from "../lib/server/background/defaultPasses";
import { createPrismaBackgroundWorkerHeartbeat } from "../lib/server/background/heartbeat";
import { defaultBackgroundPassRegistry } from "../lib/server/background/passes";
import { runBackgroundWorkerProcess } from "../lib/server/background/process";
import { createBackgroundWorker } from "../lib/server/background/worker";
import { startTelemetryRecorder } from "../lib/server/telemetry/recorder";
// Until the Memory removal deletes them: the old coordinator, for the Memory job kinds that remain. Deletion
// does not depend on it; this process keeps deleting chats when its start is blocked.
import { startDefaultMemoryCoordinatorFeatureLocally } from "../lib/server/memory/coordinator/startup";
import { stopDefaultMemoryCoordinator } from "../lib/server/memory/coordinator/defaultCoordinator";
import { defaultMemoryWorkerHeartbeat } from "../lib/server/memory/coordinator/workerHeartbeat";

/**
 * The background worker: the `memory-worker` Compose service runs it (`scripts/memory-coordinator.ts`, the
 * previous entry point, starts the same worker). Further duties register their passes before it starts, with
 * `registerBackgroundPass` from `lib/server/background/passes.ts`.
 */
if (process.env.AIQSA_RELEASE_DEPENDENCY_CHECK !== "1") {
  const telemetry = startTelemetryRecorder({ prisma });
  registerDefaultBackgroundPasses();
  void runBackgroundWorkerProcess({
    createWorker: () => createBackgroundWorker({ passes: defaultBackgroundPassRegistry.list() }),
    // The bounded final telemetry write shares the database-close step.
    disconnect: async () => {
      await telemetry.stop();
      await prisma.$disconnect();
    },
    heartbeat: createPrismaBackgroundWorkerHeartbeat(prisma),
    legacy: {
      async start() {
        return (await startDefaultMemoryCoordinatorFeatureLocally()).status;
      },
      async stop() {
        await stopDefaultMemoryCoordinator();
        await defaultMemoryWorkerHeartbeat.stop();
      }
    },
    signals: process
  }).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
