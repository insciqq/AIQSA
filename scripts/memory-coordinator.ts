import "./worker-bootstrap.cjs";
import { logEvent, reportSubsystemFailure } from "../lib/server/observability";
import { prisma } from "../lib/server/prisma";
import {
  startDefaultMemoryCoordinatorFeatureLocally
} from "../lib/server/memory/coordinator/startup";
import { stopDefaultMemoryCoordinator } from "../lib/server/memory/coordinator/defaultCoordinator";
import { defaultMemoryWorkerHeartbeat } from "../lib/server/memory/coordinator/workerHeartbeat";

async function main(): Promise<void> {
  const result = await startDefaultMemoryCoordinatorFeatureLocally();
  if (result.status === "blocked") {
    logEvent("runtime_lifecycle", { subsystem: "memory", stage: "startup", outcome: "blocked", code: result.code, action: "stop" });
    process.exitCode = 1;
    await prisma.$disconnect();
    return;
  }

  logEvent("runtime_lifecycle", { subsystem: "memory", stage: "startup", outcome: "completed" });
  const keepAlive = setInterval(() => undefined, 60_000);
  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void stopDefaultMemoryCoordinator().then(resolve);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  clearInterval(keepAlive);
  await defaultMemoryWorkerHeartbeat.stop();
  await prisma.$disconnect();
}

void main().catch(async () => {
  reportSubsystemFailure({ subsystem: "memory", stage: "startup", code: "memory_coordinator_startup_failed", action: "stop" });
  process.exitCode = 1;
  await stopDefaultMemoryCoordinator().catch(() => undefined);
  await defaultMemoryWorkerHeartbeat.stop().catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
});
