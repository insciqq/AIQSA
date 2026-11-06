import "../scripts/worker-bootstrap.cjs";
import { logEvent } from "../lib/server/observability";
import { PrismaClient } from "@prisma/client";
import { aiqsaPostgresRuntimeUrl } from "../lib/server/postgresRuntimeOptions";
import {
  bootstrapInstallationDatabase,
  InstallationBootstrapError,
  installationBootstrapInputFromEnv
} from "../lib/server/bootstrap/installationBootstrap";
import { synchronizeShippedSkills } from "../lib/server/bootstrap/shippedSkills";
import { loadShippedSkills } from "../lib/server/skills/shippedSkills";
import { assertAiqsaPostgresRuntime } from "../lib/server/postgresRuntimePreflight";

const prisma = new PrismaClient({
  datasourceUrl: aiqsaPostgresRuntimeUrl(process.env.DATABASE_URL)
});

class ShippedSkillsSynchronizationError extends Error {}

async function main(): Promise<void> {
  await assertAiqsaPostgresRuntime(prisma);
  const input = installationBootstrapInputFromEnv();
  // Read before any write, so a release with an unreadable shipped Skill stops untouched.
  const shippedSkills = (() => {
    try { return loadShippedSkills(); } catch (error) {
      throw new ShippedSkillsSynchronizationError("Shipped Skills could not be read.", { cause: error });
    }
  })();
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

  // After the installation exists: a fresh database is adopted first, and a
  // refused bootstrap never writes shipped content.
  const shipped = await synchronizeShippedSkills(prisma, shippedSkills).catch((error: unknown) => {
    throw new ShippedSkillsSynchronizationError("Shipped Skills could not be synchronized.", { cause: error });
  });
  logEvent("runtime_lifecycle", { subsystem: "database", stage: "initialize", outcome: "completed",
    code: "shipped_skills_synchronized", count: shipped.created + shipped.updated + shipped.retired });
}

main()
  .catch((error: unknown) => {
    const bootstrapError = error instanceof InstallationBootstrapError ? error : null;
    logEvent("runtime_lifecycle", { subsystem: "database", stage: "initialize", outcome: "failed",
      code: bootstrapError?.code ?? (error instanceof ShippedSkillsSynchronizationError ? "shipped_skills_failed" : "installation_bootstrap_failed"),
      action: "stop",
      ...(bootstrapError?.count !== undefined ? { count: bootstrapError.count } : {}) });
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
