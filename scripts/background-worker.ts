import "./worker-bootstrap.cjs";
import { prisma } from "../lib/server/prisma";
import { registerDefaultBackgroundPasses } from "../lib/server/background/defaultPasses";
import { createPrismaBackgroundWorkerHeartbeat } from "../lib/server/background/heartbeat";
import { defaultBackgroundPassRegistry } from "../lib/server/background/passes";
import { runBackgroundWorkerProcess } from "../lib/server/background/process";
import { createBackgroundWorker } from "../lib/server/background/worker";
import { startTelemetryRecorder } from "../lib/server/telemetry/recorder";

/**
 * The background worker: the `memory-worker` Compose service runs it (`scripts/memory-coordinator.ts`, the
 * previous entry point, starts the same worker). It runs the chat deletion duties and the past-chat search index
 * (`lib/server/background/defaultPasses.ts`); the old Memory coordinator is no longer started, since its job kinds
 * ended with the cutover to the note and past-chat search. Further duties register their passes before it starts,
 * with `registerBackgroundPass` from `lib/server/background/passes.ts`.
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
    signals: process
  }).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
