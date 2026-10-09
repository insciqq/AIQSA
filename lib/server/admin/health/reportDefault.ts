import { Prisma } from "@prisma/client";
import { readDefaultHealthFindings } from "../attention/defaultHealth";
import { databaseFailureCode } from "../../observability/databaseFailure";
import { listAnswerProblemReports } from "../../answerProblemReports/repository";
import { prisma } from "../../prisma";
import type { HealthAgentReportSources } from "./agentReport";
import { adminHealthProviderNames, adminHealthService, adminHealthTelemetryStore } from "./defaultService";
import { readFailedRunLoad } from "./failedRuns";
import { adminHealthQueuesService } from "./queuesDefault";
import type { HealthReportSources, HealthRunReportSources } from "./report";
import { adminHealthRunLookup } from "./runLookupDefault";
import { readAdminHealthUserFailedRuns } from "./runLookupRepository";

/** The health report over this installation's database, through the Health page's own services. */
export const healthReportSources: HealthReportSources & HealthRunReportSources = {
  health: adminHealthService,
  queues: adminHealthQueuesService,
  runs: adminHealthRunLookup,
  findings: readDefaultHealthFindings,
  connections: () => prisma.providerConnection.findMany({ select: { id: true, displayName: true, enabled: true } })
};

/** The agent reports (`--full`, `--user`) over the same database; they only read. */
export const healthAgentReportSources: HealthAgentReportSources = {
  store: adminHealthTelemetryStore,
  providerNames: adminHealthProviderNames,
  queues: adminHealthQueuesService,
  problemReports: (query) => listAnswerProblemReports(prisma, query),
  failedRuns: (query) => readAdminHealthUserFailedRuns(prisma, query),
  // The agent report reads a whole range once; it gets more time than a page read.
  failedRunGroups: (query) => readFailedRunLoad(prisma, { ...query, statementTimeoutMs: 15_000 }),
  userExists: async (userId) => (await prisma.user.findUnique({ where: { id: userId }, select: { id: true } })) !== null
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
