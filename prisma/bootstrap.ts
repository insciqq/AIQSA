import { PrismaClient } from "@prisma/client";
import {
  bootstrapInstallationDatabase,
  installationBootstrapInputFromEnv
} from "../lib/server/bootstrap/installationBootstrap";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const result = await bootstrapInstallationDatabase(
    prisma,
    installationBootstrapInputFromEnv()
  );

  console.log(
    `AIQSA installation bootstrap ${result.status}: catalog models=${result.catalogModelCount}, search strategies=${result.catalogSearchStrategyCount}`
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
