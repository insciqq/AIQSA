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

  logEvent("runtime_lifecycle", { subsystem: "database", stage: "initialize", outcome: "completed",
    code: result.status === "created" ? "installation_created" : "installation_already_adopted", count: result.catalogModelCount });
}

main()
  .catch((error: unknown) => {
    logEvent("runtime_lifecycle", { subsystem: "database", stage: "initialize", outcome: "failed",
      code: error instanceof InstallationBootstrapError ? error.code : "installation_bootstrap_failed", action: "stop" });
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
