import "./worker-bootstrap.cjs";
import { prisma } from "../lib/server/prisma";
import {
  startDefaultMemoryCoordinatorFeatureLocally
} from "../lib/server/memory/coordinator/startup";
import { stopDefaultMemoryCoordinator } from "../lib/server/memory/coordinator/defaultCoordinator";
import { defaultMemoryWorkerHeartbeat } from "../lib/server/memory/coordinator/workerHeartbeat";
import { runMemoryCoordinatorWorker } from "../lib/server/memory/coordinator/workerProcess";

if (process.env.AIQSA_RELEASE_DEPENDENCY_CHECK !== "1") {
  void runMemoryCoordinatorWorker({
    disconnect: () => prisma.$disconnect(),
    signals: process,
    start: startDefaultMemoryCoordinatorFeatureLocally,
    stopCoordinator: stopDefaultMemoryCoordinator,
    stopHeartbeat: () => defaultMemoryWorkerHeartbeat.stop()
  }).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
