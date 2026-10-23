import "./worker-bootstrap.cjs";
import { logEvent } from "../lib/server/observability";
import { setTimeout as wait } from "node:timers/promises";
import { prisma } from "@/lib/server/prisma";
import { runWorkspaceMaintenance } from "@/lib/server/workspace/cleanup";
import { runProjectDeletionMaintenance } from "@/lib/server/projects/deletion";
import { getWorkspaceConfig } from "@/lib/server/workspace/config";
import { createWorkspaceRuntime } from "@/lib/server/workspace/defaultRuntime";
import { startTelemetryRecorder } from "@/lib/server/telemetry/recorder";

const once = process.argv.includes("--once");
const config = getWorkspaceConfig();
const runtime = createWorkspaceRuntime(config);
const intervalMs = 30_000;
// The maintenance service records telemetry; a one-shot pass does not.
const telemetry = once ? null : startTelemetryRecorder({ prisma });

async function main(): Promise<void> {
  do {
    const summary = await runWorkspaceMaintenance({ config, prisma, runtime });
    if (summary.cleanupClaimed > 0 || summary.cleanupFailed > 0 || summary.idleFailed > 0) {
      logEvent("runtime_lifecycle", { subsystem: "workspace", stage: "cleanup",
        outcome: summary.cleanupFailed + summary.idleFailed > 0 ? "failed" : "completed",
        claimed_count: summary.cleanupClaimed, completed_count: summary.cleanupCompleted,
        failed_count: summary.cleanupFailed + summary.idleFailed });
    }
    // Projects were removed: the fenced ones left by the upgrade are deleted here.
    const projectDeletions = await runProjectDeletionMaintenance({ prisma, runtime });
    if (projectDeletions.completed > 0 || projectDeletions.failed > 0) {
      logEvent("runtime_lifecycle", { subsystem: "projects", stage: "delete",
        outcome: projectDeletions.failed > 0 ? "failed" : "completed",
        completed_count: projectDeletions.completed, failed_count: projectDeletions.failed,
        pending_count: projectDeletions.pending,
        ...(projectDeletions.failed > 0 ? { action: "retry" as const, code: "project_deletion_failed" } : {}) });
    }
    if (once) {
      console.log(JSON.stringify({ ...summary, projectDeletions }));
      return;
    }
    await wait(intervalMs);
  } while (true);
}

main()
  .catch((error: unknown) => {
    logEvent("runtime_lifecycle", { error, subsystem: "workspace", stage: "cleanup", outcome: "failed", code: "workspace_maintenance_failed", action: "stop" });
    process.exitCode = 1;
  })
  .finally(async () => {
    await telemetry?.stop();
    await prisma.$disconnect();
  });
