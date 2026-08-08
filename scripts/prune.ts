import { existsSync, readFileSync } from "node:fs";
import { createPrismaRetentionRepository, pruneRetention } from "@/lib/server/retention/prune";
import { createS3StorageAdapter } from "@/lib/server/uploads/storage";
import { prisma } from "@/lib/server/prisma";

type CliOptions = {
  authRetentionDays?: number;
  batchSize?: number;
  deletionJobLeaseMinutes?: number;
  dryRun: boolean;
  eventRetentionDays?: number;
  knowledgePayloadRetentionDays?: number;
  orphanAttachmentRetentionDays?: number;
};

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function loadLocalEnv() {
  if (!existsSync(".env")) {
    return;
  }

  const lines = readFileSync(".env", "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = unquoteEnvValue(trimmed.slice(separatorIndex + 1));

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function parsePositiveInteger(raw: string | undefined, flag: string): number {
  const value = Number(raw);

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }

  return value;
}

function readFlagValue(args: string[], index: number, flag: string): { nextIndex: number; value: string } {
  const arg = args[index];
  const inline = arg.startsWith(`${flag}=`) ? arg.slice(flag.length + 1) : null;

  if (inline !== null) {
    return {
      nextIndex: index,
      value: inline
    };
  }

  const value = args[index + 1];

  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }

  return {
    nextIndex: index + 1,
    value
  };
}

function usage(): string {
  return [
    "Usage: npm run prune -- [--dry-run|--execute] [--event-days N] [--orphan-attachment-days N] [--knowledge-payload-days N] [--auth-days N] [--deletion-job-lease-minutes N] [--batch-size N]",
    "",
    "Defaults to --dry-run. Pass --execute to stage orphan/stale Knowledge payloads, drain object-deletion jobs, and prune terminal event/auth rows."
  ].join("\n");
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    dryRun: true
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }

    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (arg === "--execute") {
      options.dryRun = false;
      continue;
    }

    if (arg === "--event-days" || arg.startsWith("--event-days=")) {
      const parsed = readFlagValue(args, index, "--event-days");
      options.eventRetentionDays = parsePositiveInteger(parsed.value, "--event-days");
      index = parsed.nextIndex;
      continue;
    }

    if (arg === "--orphan-attachment-days" || arg.startsWith("--orphan-attachment-days=")) {
      const parsed = readFlagValue(args, index, "--orphan-attachment-days");
      options.orphanAttachmentRetentionDays = parsePositiveInteger(parsed.value, "--orphan-attachment-days");
      index = parsed.nextIndex;
      continue;
    }

    if (arg === "--knowledge-payload-days" || arg.startsWith("--knowledge-payload-days=")) {
      const parsed = readFlagValue(args, index, "--knowledge-payload-days");
      options.knowledgePayloadRetentionDays = parsePositiveInteger(parsed.value, "--knowledge-payload-days");
      index = parsed.nextIndex;
      continue;
    }

    if (arg === "--auth-days" || arg.startsWith("--auth-days=")) {
      const parsed = readFlagValue(args, index, "--auth-days");
      options.authRetentionDays = parsePositiveInteger(parsed.value, "--auth-days");
      index = parsed.nextIndex;
      continue;
    }

    if (arg === "--deletion-job-lease-minutes" || arg.startsWith("--deletion-job-lease-minutes=")) {
      const parsed = readFlagValue(args, index, "--deletion-job-lease-minutes");
      options.deletionJobLeaseMinutes = parsePositiveInteger(parsed.value, "--deletion-job-lease-minutes");
      index = parsed.nextIndex;
      continue;
    }

    if (arg === "--batch-size" || arg.startsWith("--batch-size=")) {
      const parsed = readFlagValue(args, index, "--batch-size");
      options.batchSize = parsePositiveInteger(parsed.value, "--batch-size");
      index = parsed.nextIndex;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

async function main() {
  loadLocalEnv();

  const options = parseArgs(process.argv.slice(2));
  const summary = await pruneRetention({
    authRetentionDays: options.authRetentionDays,
    batchSize: options.batchSize,
    deletionJobLeaseMinutes: options.deletionJobLeaseMinutes,
    dryRun: options.dryRun,
    eventRetentionDays: options.eventRetentionDays,
    knowledgePayloadRetentionDays: options.knowledgePayloadRetentionDays,
    orphanAttachmentRetentionDays: options.orphanAttachmentRetentionDays,
    repository: createPrismaRetentionRepository(prisma),
    storage: createS3StorageAdapter()
  });

  console.log(JSON.stringify(summary, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "Prune failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
