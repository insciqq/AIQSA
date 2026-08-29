import { Prisma, type PrismaClient } from "@prisma/client";

export const AIQSA_POSTGRES_RUNTIME = Object.freeze({
  pgvectorVersion: "0.8.6",
  postgresMajorMinor: "18.6"
});

type PostgresRuntimeRow = Readonly<{
  pgTrgmAvailable: boolean;
  pgvectorVersion: string | null;
  postgresVersion: string;
}>;

export async function assertAiqsaPostgresRuntime(
  prisma: PrismaClient
): Promise<void> {
  const rows = await prisma.$queryRaw<PostgresRuntimeRow[]>(Prisma.sql`
    SELECT
      EXISTS (
        SELECT 1
        FROM pg_available_extensions
        WHERE name = 'pg_trgm'
      ) AS "pgTrgmAvailable",
      (
        SELECT extversion
        FROM pg_extension
        WHERE extname = 'vector'
      ) AS "pgvectorVersion",
      current_setting('server_version') AS "postgresVersion"
  `);
  const runtime = rows[0];
  const postgresMatches = runtime !== undefined &&
    /^18\.6(?:\D|$)/u.test(runtime.postgresVersion);
  if (
    !postgresMatches ||
    runtime.pgvectorVersion !== AIQSA_POSTGRES_RUNTIME.pgvectorVersion ||
    runtime.pgTrgmAvailable !== true
  ) {
    throw new Error("aiqsa_postgres_runtime_incompatible");
  }
}
