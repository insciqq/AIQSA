import { PrismaClient } from "@prisma/client";
import {
  bootstrapInstallationDatabase,
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

  console.log(
    `AIQSA installation bootstrap ${result.status}: catalog models=${result.catalogModelCount}, search options=${result.catalogSearchOptionCount}`
  );
}

main()
  .catch((error: unknown) => {
    console.error(
      error instanceof Error
        ? error.message
        : "AIQSA installation bootstrap failed for an unknown reason."
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
