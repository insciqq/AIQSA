import { Prisma } from "@prisma/client";

/** Owner-scoped canonical fact identity. NULL is the deliberate fail-closed
 * result for a broken, cyclic, over-depth, or non-active move chain. */
export function memoryCanonicalFactRootIdSql(
  userId: string | Prisma.Sql,
  factId: Prisma.Sql
): Prisma.Sql {
  return Prisma.sql`aiqsa_memory_fact_root_id(${userId}, ${factId})`;
}
