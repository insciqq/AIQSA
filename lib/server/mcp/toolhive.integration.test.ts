import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpClientSessionFactory } from "./clientSessionFactory";
import type { McpRuntimeSession } from "./runtimeCoordinator";
import { createMcpSafeFetch } from "./safeFetch";
import { ToolHiveClient } from "./toolhiveClient";
import { ToolHiveMcpRuntimeDriver } from "./toolhiveRuntimeDriver";
import { createToolHiveMcpSessionFactory } from "./toolhiveSessionFactory";

const enabled = process.env.AIQSA_TOOLHIVE_INTEGRATION_TEST === "1";
const integration = enabled ? describe : describe.skip;
const OCI_FIXTURE = process.env.AIQSA_TOOLHIVE_OCI_SMOKE_IMAGE ??
  "ghcr.io/stackloklabs/yardstick/yardstick-server@sha256:87a40f4f8f3689682e78e7f3840775833184753bfcb69336dc4ac57f1024008e";

integration("ToolHive runtime integration", () => {
  let driver: ToolHiveMcpRuntimeDriver | null = null;
  let session: McpRuntimeSession | null = null;

  afterEach(async () => {
    if (session?.dispose) await session.dispose().catch(() => undefined);
    else await session?.close().catch(() => undefined);
    await driver?.cleanupOwnedInstallation().catch(() => undefined);
    session = null;
    driver = null;
  });

  it("initializes a digest-pinned OCI stdio workload through the common SDK session", async () => {
    const client = new ToolHiveClient({
      baseUrl: process.env.AIQSA_TOOLHIVE_URL ?? "http://toolhive-runtime:8080"
    });
    driver = new ToolHiveMcpRuntimeDriver({
      client,
      ownerToken: randomBytes(8).toString("hex")
    });
    const directSessions = createMcpClientSessionFactory({
      fetch: createMcpSafeFetch({ allowInsecureHttp: true, allowPrivateNetwork: true }),
      limits: {
        maxListPages: 4,
        maxToolArgumentBytes: 64 * 1_024,
        maxToolMetadataBytes: 256 * 1_024,
        maxToolResultBytes: 512 * 1_024,
        maxToolSchemaBytes: 64 * 1_024,
        maxTools: 64
      }
    });
    const sessions = createToolHiveMcpSessionFactory({ directSessions, driver });
    const token = randomBytes(16).toString("hex");

    session = await sessions.create({
      callTimeoutMs: 10_000,
      fingerprint: token.padEnd(64, "0"),
      generationId: `smoke-${token}`,
    headers: {},
    onToolsChanged() {},
    redactionValues: [],
    retryAt: null,
      startupTimeoutMs: 120_000,
      toolHive: {
        cmdArguments: [],
        envVars: {},
        generationToken: token,
        image: OCI_FIXTURE
      }
    });

    await expect(session.listTools()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "echo" })
    ]));
  }, 180_000);
});
