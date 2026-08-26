import { PrismaClient } from "@prisma/client";
import { aiqsaPostgresRuntimeOptions } from "./postgresRuntimeOptions";

// PostgreSQL JIT compilation can dominate AIQSA's bounded authority-heavy
// OLTP queries by seconds. Apply the setting before Prisma opens its pool;
// changing it later is unreliable once prepared statements have been cached.
process.env.PGOPTIONS = aiqsaPostgresRuntimeOptions(process.env.PGOPTIONS);

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
