import "./worker-bootstrap.cjs";
import { logEvent } from "../lib/server/observability";
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
    if (summary.cleanupClaimed > 0 || summary.cleanupFailed > 0 || summary.idleFailed > 0) {
      logEvent("runtime_lifecycle", { subsystem: "workspace", stage: "cleanup",
        outcome: summary.cleanupFailed + summary.idleFailed > 0 ? "failed" : "completed",
        claimed_count: summary.cleanupClaimed, completed_count: summary.cleanupCompleted,
        failed_count: summary.cleanupFailed + summary.idleFailed });
    }
    if (once) {
      console.log(JSON.stringify(summary));
      return;
    }
    await wait(intervalMs);
  } while (true);
}

main()
  .catch(() => {
    logEvent("runtime_lifecycle", { subsystem: "workspace", stage: "cleanup", outcome: "failed", code: "workspace_maintenance_failed", action: "stop" });
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
