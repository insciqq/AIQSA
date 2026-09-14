import "./worker-bootstrap.cjs";
import { logEvent } from "../lib/server/observability";
import { getDefaultToolHiveDriver } from "@/lib/server/mcp/defaultToolHive";
import {
  parseToolHiveCleanupArgs,
  runToolHiveCleanup,
  toolHiveCleanupUsage
} from "@/lib/server/mcp/toolhiveCleanupCli";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (parseToolHiveCleanupArgs(args).help) {
    console.log(toolHiveCleanupUsage());
    return;
  }
  await runToolHiveCleanup({ args, driver: getDefaultToolHiveDriver() });
}

main().catch(() => {
  logEvent("runtime_lifecycle", { subsystem: "mcp", stage: "cleanup", outcome: "failed", code: "mcp_cleanup_failed", action: "stop" });
  process.exitCode = 1;
});
