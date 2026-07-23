import type { ToolHiveMcpRuntimeDriver } from "./toolhiveRuntimeDriver";

type CleanupDriver = Pick<
  ToolHiveMcpRuntimeDriver,
  "cleanupOwnedInstallation" | "groupName" | "listOwnedWorkloads"
>;

type CleanupOutput = (line: string) => void;

export type ToolHiveCleanupOptions = Readonly<{
  execute: boolean;
  help: boolean;
}>;

export function toolHiveCleanupUsage(): string {
  return [
    "Usage: npm run mcp:cleanup -- [--dry-run|--execute]",
    "",
    "Defaults to --dry-run and lists only exact AIQSA-owned ToolHive workloads.",
    "Pass --execute to delete those workloads and their empty AIQSA ownership group."
  ].join("\n");
}

export function parseToolHiveCleanupArgs(args: readonly string[]): ToolHiveCleanupOptions {
  let mode: "dry-run" | "execute" | null = null;
  let help = false;

  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--dry-run") {
      if (mode === "execute") throw new Error("Choose either --dry-run or --execute");
      mode = "dry-run";
      continue;
    }
    if (arg === "--execute") {
      if (mode === "dry-run") throw new Error("Choose either --dry-run or --execute");
      mode = "execute";
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { execute: mode === "execute", help };
}

export async function runToolHiveCleanup(input: Readonly<{
  args: readonly string[];
  driver: CleanupDriver;
  output?: CleanupOutput;
}>): Promise<void> {
  const output = input.output ?? console.log;
  const options = parseToolHiveCleanupArgs(input.args);
  if (options.help) {
    output(toolHiveCleanupUsage());
    return;
  }

  const owned = await input.driver.listOwnedWorkloads();
  if (!options.execute) {
    output(JSON.stringify({
      group: input.driver.groupName,
      mode: "dry-run",
      ownedWorkloadCount: owned.length,
      ownedWorkloads: owned.map((workload) => workload.name)
    }, null, 2));
    return;
  }

  const result = await input.driver.cleanupOwnedInstallation();
  const remaining = await input.driver.listOwnedWorkloads();
  if (remaining.length > 0) {
    const noun = remaining.length === 1 ? "workload" : "workloads";
    throw new Error(`ToolHive cleanup incomplete: ${remaining.length} owned ${noun} still present`);
  }

  output(JSON.stringify({
    deletedWorkloadCount: result.deletedWorkloads.length,
    deletedWorkloads: result.deletedWorkloads,
    group: input.driver.groupName,
    groupDeleted: result.groupDeleted,
    mode: "execute",
    ownedWorkloadCountBefore: owned.length,
    ownedWorkloadCountRemaining: 0
  }, null, 2));
}
