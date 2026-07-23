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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "ToolHive cleanup failed");
  process.exitCode = 1;
});
