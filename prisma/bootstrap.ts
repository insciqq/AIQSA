import { PrismaClient } from "@prisma/client";
import {
  bootstrapInstallationDatabase,
  installationBootstrapInputFromEnv
} from "../lib/server/bootstrap/installationBootstrap";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const input = installationBootstrapInputFromEnv();
  const result = await bootstrapInstallationDatabase(
    prisma,
    input
  );
  const adoptedUser = await prisma.user.findFirst({
    select: { id: true },
    where: {
      email: {
        equals: input.email,
        mode: "insensitive"
      }
    }
  });
  if (!adoptedUser) {
    throw new Error("Installation bootstrap could not resolve the adopted initial admin.");
  }
  await prisma.userMemorySettings.upsert({
    create: { userId: adoptedUser.id },
    update: {},
    where: { userId: adoptedUser.id }
  });

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
