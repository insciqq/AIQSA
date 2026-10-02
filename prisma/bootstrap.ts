import "../scripts/worker-bootstrap.cjs";
import { logEvent } from "../lib/server/observability";
import { PrismaClient } from "@prisma/client";
import {
  bootstrapInstallationDatabase,
  InstallationBootstrapError,
  installationBootstrapInputFromEnv
} from "../lib/server/bootstrap/installationBootstrap";
import { assertAiqsaPostgresRuntime } from "../lib/server/postgresRuntimePreflight";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  await assertAiqsaPostgresRuntime(prisma);
  const input = installationBootstrapInputFromEnv();
  const result = await bootstrapInstallationDatabase(
    prisma,
    input
  );

  if (result.localMcpRemovedCount !== undefined) {
    logEvent("runtime_lifecycle", { subsystem: "mcp", stage: "cleanup", outcome: "completed",
      code: "local_mcp_sources_removed", count: result.localMcpRemovedCount });
  }
  logEvent("runtime_lifecycle", { subsystem: "database", stage: "initialize", outcome: "completed",
    code: result.status === "created" ? "installation_created" : "installation_already_adopted", count: result.catalogModelCount });
}

main()
  .catch((error: unknown) => {
    const bootstrapError = error instanceof InstallationBootstrapError ? error : null;
    logEvent("runtime_lifecycle", { subsystem: "database", stage: "initialize", outcome: "failed",
      code: bootstrapError?.code ?? "installation_bootstrap_failed", action: "stop",
      ...(bootstrapError?.count !== undefined ? { count: bootstrapError.count } : {}) });
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
