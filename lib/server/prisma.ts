import { PrismaClient } from "@prisma/client";
import { aiqsaPostgresRuntimeOptions, aiqsaPostgresRuntimeUrl } from "./postgresRuntimeOptions";

// node-pg's Project LISTEN connection uses PGOPTIONS unless its URL supplies
// options. Prisma's Rust engine needs the startup options in its datasource URL.
process.env.PGOPTIONS = aiqsaPostgresRuntimeOptions(process.env.PGOPTIONS);

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  datasourceUrl: aiqsaPostgresRuntimeUrl(process.env.DATABASE_URL)
});

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
