import "./worker-bootstrap.cjs";
import { logEvent, reportSubsystemFailure } from "../lib/server/observability";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";
import { Image, Sandbox, isInstalled } from "microsandbox";
import { DeterministicWorkspaceRuntime } from "@/lib/server/workspace/deterministicRuntime";
import { getWorkspaceConfig } from "@/lib/server/workspace/config";
import { ensureBundledMicrosandboxRuntime } from "@/lib/server/workspace/microsandboxInstall";
import { MicrosandboxWorkspaceRuntime } from "@/lib/server/workspace/microsandboxRuntime";
import { createWorkspaceRunnerServer } from "@/lib/server/workspace/runnerServer";
import { createAgentRelay, AGENT_GATEWAY_PORT } from "@/lib/server/agents/relay";

async function main(): Promise<void> {
  const token = process.env.AIQSA_WORKSPACE_RUNNER_TOKEN?.trim();
  if (!token || token.length < 32) throw new Error("workspace_runner_token_missing");

  const environment = {
    ...process.env,
    AIQSA_WORKSPACE_RUNNER_URL:
      process.env.AIQSA_WORKSPACE_RUNNER_URL ?? "http://workspace-runner.invalid/"
  };
  const config = getWorkspaceConfig(environment);
  if (config.runtimeMode !== "deterministic") {
    await ensureBundledMicrosandboxRuntime();
    if (!isInstalled()) throw new Error("workspace_runtime_unavailable");
    await Sandbox.list();
    try {
      await Image.get(config.imageRef);
    } catch {
      const archive = process.env.AIQSA_WORKSPACE_IMAGE_ARCHIVE?.trim()
        || "/opt/aiqsa/workspace-image.oci.tar";
      await access(archive, fsConstants.R_OK);
      await Image.load(archive, { tag: config.imageRef });
      await Image.get(config.imageRef);
    }
  }
  const runtime = config.runtimeMode === "deterministic"
    ? new DeterministicWorkspaceRuntime(config)
    : new MicrosandboxWorkspaceRuntime(config);
  const runtimeHome = process.env.MSB_HOME?.trim();
  if (!runtimeHome) throw new Error("workspace_runtime_unavailable");
  const server = createWorkspaceRunnerServer({ operationDirectory: join(runtimeHome, "workspace-operations"), runtime, token });
  const host = process.env.AIQSA_WORKSPACE_RUNNER_HOST?.trim() || "0.0.0.0";
  const portValue = Number(process.env.AIQSA_WORKSPACE_RUNNER_PORT ?? "4310");
  if (!Number.isSafeInteger(portValue) || portValue < 1 || portValue > 65_535) {
    throw new Error("workspace_runner_port_invalid");
  }

  const health = await runtime.health();
  if (health.state !== "ready") {
    throw new Error(health.reasonCode ?? "workspace_runtime_unavailable");
  }

  const relay = process.env.AIQSA_AGENT_APP_ORIGIN?.trim()
    ? createAgentRelay(process.env.AIQSA_AGENT_APP_ORIGIN.trim()) : null;
  if (relay) await new Promise<void>((resolve, reject) => {
    relay.once("error", reject);
    relay.listen(AGENT_GATEWAY_PORT, "127.0.0.1", resolve);
  });

  server.listen(portValue, host, () => {
    logEvent("runtime_lifecycle", { subsystem: "workspace", stage: "startup", outcome: "completed" });
  });

  const shutdown = () => {
    relay?.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch(() => {
  reportSubsystemFailure({ subsystem: "workspace", stage: "startup", code: "workspace_runner_failed", action: "stop" });
  process.exitCode = 1;
});
