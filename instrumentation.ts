import type { Instrumentation } from "next";

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { installProcessFailureHooks } = await import(
      "./lib/server/observability/process.cjs"
    );
    installProcessFailureHooks();
    const { announceProcess, reportSubsystemFailure, reportSubsystemHealthy } = await import(
      "./lib/server/observability"
    );
    try {
      const { startDefaultTelemetryRecorder } = await import("./lib/server/telemetry/defaultRecorder");
      startDefaultTelemetryRecorder();
      reportSubsystemHealthy("telemetry", "startup");
    } catch (error) {
      // Telemetry is operator diagnostics only: stdout logging and every
      // product path continue without it.
      reportSubsystemFailure({ error, subsystem: "telemetry", stage: "startup", code: "telemetry_startup_failed", action: "degrade" });
    }
    announceProcess({ attachments: "starting", memory: "unknown", knowledge: "starting", mcp: "starting", workspace: "unknown", email: "unknown" });
    const { startNativeRoutingAdoption } = await import("./lib/server/bootstrap/nativeRoutingAdoption");
    startNativeRoutingAdoption();
    const { startDecisionModelAdoption } = await import("./lib/server/bootstrap/decisionModelAdoption");
    startDecisionModelAdoption();
    const { startCatalogCostBackfill } = await import("./lib/server/bootstrap/catalogCostBackfill");
    startCatalogCostBackfill();
    const { startDefaultRunRecoveryScheduler } = await import(
      "./lib/server/runs/defaultRecoveryScheduler"
    );
    try {
      startDefaultRunRecoveryScheduler();
      reportSubsystemHealthy("run_recovery", "startup");
    } catch (error) {
      reportSubsystemFailure({ error, subsystem: "run_recovery", stage: "startup", code: "run_recovery_startup_failed", action: "stop" });
      throw error;
    }
    try {
      const { startDefaultScheduledTaskRunner } = await import(
        "./lib/server/scheduledTasks/defaultRunner"
      );
      startDefaultScheduledTaskRunner();
      reportSubsystemHealthy("scheduled_tasks", "startup");
    } catch (error) {
      // Scheduled tasks are feature-local: due occurrences wait in PostgreSQL
      // and the owner API keeps working while the runner is unavailable.
      reportSubsystemFailure({ error, subsystem: "scheduled_tasks", stage: "startup", code: "scheduled_task_runner_startup_failed", action: "degrade" });
    }
    try {
      const { startDefaultBrowserPush } = await import("./lib/server/push/defaultBrowserPush");
      startDefaultBrowserPush();
    } catch (error) {
      // Browser push is best effort; runs and scheduled tasks settle without it.
      reportSubsystemFailure({ error, subsystem: "push", stage: "startup", code: "push_unavailable", action: "degrade" });
    }
    try {
      const { getDefaultAttachmentProcessingCoordinator } = await import(
        "./lib/server/uploads/defaultProcessing"
      );
      getDefaultAttachmentProcessingCoordinator();
      reportSubsystemHealthy("attachments", "startup");
    } catch (error) {
      // Attachment processing is feature-local. Startup remains available so
      // status/retry endpoints can expose a durable failure instead of crashing.
      reportSubsystemFailure({ error, subsystem: "attachments", stage: "startup", code: "attachment_processing_startup_failed", action: "degrade" });
    }
    try {
      const { getWorkspaceUploadService } = await import("./lib/server/uploads/defaultWorkspaceUploads");
      getWorkspaceUploadService();
    } catch (error) {
      // Durable original uploads recover independently of document processing.
      reportSubsystemFailure({ error, subsystem: "attachments", stage: "startup", code: "workspace_upload_startup_failed", action: "degrade" });
    }
    try {
      const { startDefaultObjectDeletionWorker } = await import("./lib/server/retention/defaultObjectDeletion");
      startDefaultObjectDeletionWorker();
      reportSubsystemHealthy("object_storage", "startup");
    } catch (error) {
      // Deletion jobs stay durable in PostgreSQL; `npm run prune` still drains them.
      reportSubsystemFailure({ error, subsystem: "object_storage", stage: "startup", code: "object_deletion_startup_failed", action: "degrade" });
    }
    try {
      const { getDefaultKnowledgeIngestionCoordinator } = await import(
        "./lib/server/knowledge/defaultIngestion"
      );
      getDefaultKnowledgeIngestionCoordinator();
      reportSubsystemHealthy("knowledge", "startup");
    } catch (error) {
      // Knowledge ingestion is feature-local. Durable per-document state remains
      // inspectable and retryable when its parser/provider/storage boundary is unavailable.
      reportSubsystemFailure({ error, subsystem: "knowledge", stage: "startup", code: "knowledge_ingestion_startup_failed", action: "degrade" });
    }
    try {
      const { getDefaultMcpActivationCoordinator } = await import(
        "./lib/server/mcp/defaultActivation"
      );
      const { getDefaultMcpRuntimeCoordinator } = await import(
        "./lib/server/mcp/defaultRuntime"
      );
      getDefaultMcpActivationCoordinator();
      getDefaultMcpRuntimeCoordinator();
      reportSubsystemHealthy("mcp", "startup");
    } catch (error) {
      // MCP is an optional subsystem. A missing/invalid MCP deployment setting must
      // not prevent the core application from starting.
      reportSubsystemFailure({ error, subsystem: "mcp", stage: "startup", code: "mcp_runtime_startup_failed", action: "degrade" });
    }
    if (process.env.NODE_ENV !== "production") {
      try {
        const { startDefaultMemoryCoordinatorFeatureLocally } = await import(
          "./lib/server/memory/coordinator/startup"
        );
        await startDefaultMemoryCoordinatorFeatureLocally();
      } catch (error) {
        // Memory coordination is feature-local. Development web readiness and
        // ordinary non-Memory behavior remain available when startup is blocked.
        reportSubsystemFailure({ error, subsystem: "memory", stage: "startup", code: "memory_coordinator_startup_failed", action: "degrade" });
      }
    }
  }
}

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { reportNextRequestError } = await import("./lib/server/observability/http.cjs");
    reportNextRequestError(request.method, context.routePath, error);
  }
};
