export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { warnIgnoredProviderTimeoutEnvironmentOnce } = await import(
    "./lib/server/providers/legacyTimeoutEnvironment"
  );
  warnIgnoredProviderTimeoutEnvironmentOnce();
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
}
