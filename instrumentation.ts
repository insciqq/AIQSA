export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startDefaultRunRecoveryScheduler } = await import(
    "./lib/server/runs/defaultRecoveryScheduler"
  );
  startDefaultRunRecoveryScheduler();
  try {
    const { getDefaultMcpRuntimeCoordinator } = await import(
      "./lib/server/mcp/defaultRuntime"
    );
    getDefaultMcpRuntimeCoordinator();
  } catch {
    // MCP is an optional subsystem. A missing/invalid MCP deployment setting must
    // not prevent the core QSA application from starting.
  }
}
