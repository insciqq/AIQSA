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
import { HEALTH_SLOW_TRANSACTION_QUERY } from "./slowTransactions";
import { readAdminHealthUserFailedRuns } from "./runLookupRepository";

/** Failed runs of a report's whole range, read once; it gets more time than a page read. */
const readReportFailedRuns: HealthReportSources["failedRuns"] = (query) =>
  readFailedRunLoad(prisma, { ...query, statementTimeoutMs: 15_000 });

/** The health report over this installation's database, through the Health page's own services. */
export const healthReportSources: HealthReportSources & HealthRunReportSources = {
  health: adminHealthService,
  queues: adminHealthQueuesService,
  runs: adminHealthRunLookup,
  findings: readDefaultHealthFindings,
  connections: () => prisma.providerConnection.findMany({ select: { id: true, displayName: true, enabled: true } }),
  failedRuns: readReportFailedRuns,
  slowTransactions: (span) => adminHealthTelemetryStore.readCounters({ ...span, ...HEALTH_SLOW_TRANSACTION_QUERY })
};

/** The agent reports (`--full`, `--user`) over the same database; they only read. */
export const healthAgentReportSources: HealthAgentReportSources = {
  store: adminHealthTelemetryStore,
  providerNames: adminHealthProviderNames,
  queues: adminHealthQueuesService,
  problemReports: (query) => listAnswerProblemReports(prisma, query),
  failedRuns: (query) => readAdminHealthUserFailedRuns(prisma, query),
  failedRunGroups: readReportFailedRuns,
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
