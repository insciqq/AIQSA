import { prisma } from "../lib/server/prisma";
import {
  startDefaultMemoryCoordinatorFeatureLocally
} from "../lib/server/memory/coordinator/startup";
import { stopDefaultMemoryCoordinator } from "../lib/server/memory/coordinator/defaultCoordinator";

async function main(): Promise<void> {
  const result = await startDefaultMemoryCoordinatorFeatureLocally();
  if (result.status === "blocked") {
    console.error(`AIQSA Memory coordinator unavailable: ${result.code}`);
    process.exitCode = 1;
    await prisma.$disconnect();
    return;
  }

  console.error("AIQSA Memory coordinator started.");
  const keepAlive = setInterval(() => undefined, 60_000);
  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      stopDefaultMemoryCoordinator();
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  clearInterval(keepAlive);
  await prisma.$disconnect();
}

void main().catch(async () => {
  console.error("AIQSA Memory coordinator unavailable: memory_coordinator_startup_failed");
  process.exitCode = 1;
  await prisma.$disconnect().catch(() => undefined);
});
