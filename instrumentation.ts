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
    announceProcess({ attachments: "starting", memory: "unknown", knowledge: "starting", mcp: "starting", workspace: "unknown", email: "unknown" });
    const { startNativeRoutingAdoption } = await import("./lib/server/bootstrap/nativeRoutingAdoption");
    startNativeRoutingAdoption();
    const { startDecisionModelAdoption } = await import("./lib/server/bootstrap/decisionModelAdoption");
    startDecisionModelAdoption();
    const { startDefaultRunRecoveryScheduler } = await import(
      "./lib/server/runs/defaultRecoveryScheduler"
    );
    try {
      startDefaultRunRecoveryScheduler();
      reportSubsystemHealthy("run_recovery", "startup");
    } catch (error) {
      reportSubsystemFailure({ subsystem: "run_recovery", stage: "startup", code: "run_recovery_startup_failed", action: "stop" });
      throw error;
    }
    try {
      const { getDefaultAttachmentProcessingCoordinator } = await import(
        "./lib/server/uploads/defaultProcessing"
      );
      getDefaultAttachmentProcessingCoordinator();
      reportSubsystemHealthy("attachments", "startup");
    } catch {
      // Attachment processing is feature-local. Startup remains available so
      // status/retry endpoints can expose a durable failure instead of crashing.
      reportSubsystemFailure({ subsystem: "attachments", stage: "startup", code: "attachment_processing_startup_failed", action: "degrade" });
    }
    try {
      const { getWorkspaceUploadService } = await import("./lib/server/uploads/defaultWorkspaceUploads");
      getWorkspaceUploadService();
    } catch {
      // Durable original uploads recover independently of document processing.
      reportSubsystemFailure({ subsystem: "attachments", stage: "startup", code: "workspace_upload_startup_failed", action: "degrade" });
    }
    try {
      const { getDefaultKnowledgeIngestionCoordinator } = await import(
        "./lib/server/knowledge/defaultIngestion"
      );
      getDefaultKnowledgeIngestionCoordinator();
      reportSubsystemHealthy("knowledge", "startup");
    } catch {
      // Knowledge ingestion is feature-local. Durable per-document state remains
      // inspectable and retryable when its parser/provider/storage boundary is unavailable.
      reportSubsystemFailure({ subsystem: "knowledge", stage: "startup", code: "knowledge_ingestion_startup_failed", action: "degrade" });
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
    } catch {
      // MCP is an optional subsystem. A missing/invalid MCP deployment setting must
      // not prevent the core application from starting.
      reportSubsystemFailure({ subsystem: "mcp", stage: "startup", code: "mcp_runtime_startup_failed", action: "degrade" });
    }
    if (process.env.NODE_ENV !== "production") {
      try {
        const { startDefaultMemoryCoordinatorFeatureLocally } = await import(
          "./lib/server/memory/coordinator/startup"
        );
        await startDefaultMemoryCoordinatorFeatureLocally();
      } catch {
        // Memory coordination is feature-local. Development web readiness and
        // ordinary non-Memory behavior remain available when startup is blocked.
        reportSubsystemFailure({ subsystem: "memory", stage: "startup", code: "memory_coordinator_startup_failed", action: "degrade" });
      }
    }
  }
}

export const onRequestError: Instrumentation.onRequestError = async (_error, request, context) => {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { reportNextRequestError } = await import("./lib/server/observability/http.cjs");
    reportNextRequestError(request.method, context.routePath);
  }
};
