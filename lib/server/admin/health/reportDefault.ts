import { Prisma } from "@prisma/client";
import { readDefaultHealthFindings } from "../attention/defaultHealth";
import { databaseFailureCode } from "../../observability/databaseFailure";
import { prisma } from "../../prisma";
import { adminHealthService } from "./defaultService";
import { adminHealthQueuesService } from "./queuesDefault";
import type { HealthReportSources, HealthRunReportSources } from "./report";
import { adminHealthRunLookup } from "./runLookupDefault";

/** The health report over this installation's database, through the Health page's own services. */
export const healthReportSources: HealthReportSources & HealthRunReportSources = {
  health: adminHealthService,
  queues: adminHealthQueuesService,
  runs: adminHealthRunLookup,
  findings: readDefaultHealthFindings,
  connections: () => prisma.providerConnection.findMany({ select: { id: true, displayName: true, enabled: true } })
};

/** A content-free reason for a failed read: the Prisma error code when one is known, never a message. */
export function healthReportFailureCode(error: unknown): string {
  const retained = databaseFailureCode(error);
  if (retained !== "unknown") return `database_${retained}`;
  if (error instanceof Prisma.PrismaClientKnownRequestError) return `database_${error.code}`;
  if (error instanceof Prisma.PrismaClientInitializationError) {
    return error.errorCode ? `database_${error.errorCode}` : "database_unavailable";
  }
  return "unknown";
}

export function closeHealthReportSources(): Promise<void> {
  return prisma.$disconnect();
}
