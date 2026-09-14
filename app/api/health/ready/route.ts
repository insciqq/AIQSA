import { prisma } from "@/lib/server/prisma";
import { getAuthConfig } from "@/lib/server/auth/config";
import { resolveLoginRateLimitIdentity } from "@/lib/server/auth/clientIdentity";
import { reportReadiness, reportSubsystemFailure, reportSubsystemHealthy } from "@/lib/server/observability";
import { databaseFailureCode, retainDatabaseFailure } from "@/lib/server/observability/databaseFailure";
import {
  checkS3Readiness,
  runtimeConfigurationIssues
} from "@/lib/server/health/readiness";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function unavailable() {
  return Response.json(
    { status: "not_ready" },
    {
      headers: { "Cache-Control": "no-store" },
      status: 503
    }
  );
}

export async function GET(request: Request) {
  const configurationIssues = runtimeConfigurationIssues(process.env);

  if (configurationIssues.length > 0) {
    for (const code of configurationIssues) {
      reportSubsystemFailure({ subsystem: "configuration", stage: "health", code, action: "wait" });
    }
    reportReadiness("not_ready", configurationIssues[0], configurationIssues.length);
    return unavailable();
  }

  const auth = getAuthConfig(process.env);

  if (
    auth.clientIdentityMode === "direct_peer" &&
    resolveLoginRateLimitIdentity(request, auth).status !== "available"
  ) {
    reportSubsystemFailure({ subsystem: "configuration", stage: "health", code: "runtime_peer_identity", action: "wait" });
    reportReadiness("not_ready", "runtime_peer_identity", 1);
    return unavailable();
  }
  reportSubsystemHealthy("configuration", "health");

  try {
    await prisma.$queryRaw`SELECT 1`.catch(retainDatabaseFailure);
    reportSubsystemHealthy("database", "health");
  } catch (error) {
    reportSubsystemFailure({ subsystem: "database", stage: "health", code: "database_unavailable", prisma_code: databaseFailureCode(error), action: "wait" });
    reportReadiness("not_ready", "database_unavailable", 1);
    return unavailable();
  }

  try {
    await checkS3Readiness(process.env);
    reportSubsystemHealthy("object_storage", "health");
  } catch {
    reportSubsystemFailure({ subsystem: "object_storage", stage: "health", code: "object_storage_unavailable", action: "wait" });
    reportReadiness("not_ready", "object_storage_unavailable", 1);
    return unavailable();
  }

  reportReadiness("ready");

  return Response.json(
    { status: "ready" },
    {
      headers: { "Cache-Control": "no-store" }
    }
  );
}
