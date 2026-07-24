import { pathToFileURL } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";
import { getSecretEncryptionKey } from "../../lib/server/secrets/envelope";
import {
  cutOverMcpEnvelopesToV2InTransaction,
  MCP_ENVELOPE_CUTOVER_LOCK_KEY,
  type McpEnvelopeV2CutoverResult
} from "./mcp-envelope-v2-cutover";
import {
  importLegacyProviderEnvironment,
  type LegacyProviderImportResult
} from "./provider-env-import";
import {
  importLegacySmtpEnvironment,
  type LegacySmtpImportResult
} from "./smtp-env-import";

export type ControlPlaneCutoverResult = Readonly<{
  mcp: McpEnvelopeV2CutoverResult;
  providers: LegacyProviderImportResult;
  smtp: LegacySmtpImportResult;
}>;

export async function runControlPlaneCutover(
  client: PrismaClient,
  key: Buffer,
  env: Record<string, string | undefined>
): Promise<ControlPlaneCutoverResult> {
  return client.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${MCP_ENVELOPE_CUTOVER_LOCK_KEY}, 0)
      )::text AS "lock"
    `;
    await tx.$executeRaw`
      LOCK TABLE
        "ProviderConnection",
        "ProviderCredential",
        "ProviderModel",
        "SmtpControl"
      IN SHARE ROW EXCLUSIVE MODE
    `;

    const mcp = await cutOverMcpEnvelopesToV2InTransaction(tx, key);
    const providers = await importLegacyProviderEnvironment(tx, key, env);
    const smtp = await importLegacySmtpEnvironment(tx, key, env);
    return { mcp, providers, smtp };
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 10_000,
    timeout: 300_000
  });
}

function safeCutoverErrorCode(error: unknown): string {
  if (
    error instanceof Error &&
    /^(?:mcp_envelope_cutover|provider_env|smtp_env)_[a-z0-9_]+$/u.test(error.message)
  ) {
    return error.message;
  }
  return "control_plane_cutover_failed";
}

async function main(): Promise<void> {
  const client = new PrismaClient();
  try {
    const result = await runControlPlaneCutover(
      client,
      getSecretEncryptionKey(),
      process.env
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await client.$disconnect();
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${safeCutoverErrorCode(error)}\n`);
    process.exitCode = 1;
  });
}
