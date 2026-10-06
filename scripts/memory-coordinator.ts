import "./worker-bootstrap.cjs";
import { prisma } from "../lib/server/prisma";
import {
  startDefaultMemoryCoordinatorFeatureLocally
} from "../lib/server/memory/coordinator/startup";
import { stopDefaultMemoryCoordinator } from "../lib/server/memory/coordinator/defaultCoordinator";
import { defaultMemoryWorkerHeartbeat } from "../lib/server/memory/coordinator/workerHeartbeat";
import { runMemoryCoordinatorWorker } from "../lib/server/memory/coordinator/workerProcess";
import { startTelemetryRecorder } from "../lib/server/telemetry/recorder";

if (process.env.AIQSA_RELEASE_DEPENDENCY_CHECK !== "1") {
  const telemetry = startTelemetryRecorder({ prisma });
  void runMemoryCoordinatorWorker({
    // The bounded final telemetry write shares the database-close step.
    disconnect: async () => {
      await telemetry.stop();
      await prisma.$disconnect();
    },
    signals: process,
    start: startDefaultMemoryCoordinatorFeatureLocally,
    stopCoordinator: stopDefaultMemoryCoordinator,
    stopHeartbeat: () => defaultMemoryWorkerHeartbeat.stop()
  }).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
