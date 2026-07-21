import { PrismaClient } from "@prisma/client";
import {
  bootstrapProductionDatabase,
  productionBootstrapInputFromEnv
} from "../lib/server/bootstrap/productionBootstrap";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const result = await bootstrapProductionDatabase(
    prisma,
    productionBootstrapInputFromEnv()
  );

  console.log(
    `AIQSA production bootstrap ${result.status}: catalog models=${result.catalogModelCount}, search strategies=${result.catalogSearchStrategyCount}`
  );
}

main()
  .catch((error: unknown) => {
    console.error(
      error instanceof Error
        ? error.message
        : "AIQSA production bootstrap failed for an unknown reason."
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
