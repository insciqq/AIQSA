import { setTimeout as wait } from "node:timers/promises";
import { prisma } from "@/lib/server/prisma";
import { runWorkspaceMaintenance } from "@/lib/server/workspace/cleanup";
import { getWorkspaceConfig } from "@/lib/server/workspace/config";
import { createWorkspaceRuntime } from "@/lib/server/workspace/defaultRuntime";

const once = process.argv.includes("--once");
const config = getWorkspaceConfig();
const runtime = createWorkspaceRuntime(config);
const intervalMs = 30_000;

async function main(): Promise<void> {
  do {
    const summary = await runWorkspaceMaintenance({ config, prisma, runtime });
    if (once) {
      console.log(JSON.stringify(summary));
      return;
    }
    await wait(intervalMs);
  } while (true);
}

main()
  .catch(() => {
    console.error("workspace_maintenance_failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
