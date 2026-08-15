export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startDefaultRunRecoveryScheduler } = await import(
    "./lib/server/runs/defaultRecoveryScheduler"
  );
  startDefaultRunRecoveryScheduler();
  try {
    const { getDefaultAttachmentProcessingCoordinator } = await import(
      "./lib/server/uploads/defaultProcessing"
    );
    getDefaultAttachmentProcessingCoordinator();
  } catch {
    // Attachment processing is feature-local. Startup remains available so
    // status/retry endpoints can expose a durable failure instead of crashing.
  }
  try {
    const { getDefaultKnowledgeIngestionCoordinator } = await import(
      "./lib/server/knowledge/defaultIngestion"
    );
    getDefaultKnowledgeIngestionCoordinator();
  } catch {
    // Knowledge ingestion is feature-local. Durable per-document state remains
    // inspectable and retryable when its parser/provider/storage boundary is unavailable.
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
  } catch {
    // MCP is an optional subsystem. A missing/invalid MCP deployment setting must
    // not prevent the core application from starting.
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
    }
  }
}
