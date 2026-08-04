import { describe, expect, it, vi } from "vitest";
import type { McpRuntimeLaunch, McpRuntimeSession } from "./runtimeCoordinator";
import { createToolHiveMcpSessionFactory } from "./toolhiveSessionFactory";

function session(): McpRuntimeSession {
  return {
    callTool: vi.fn(async () => ({
      isError: false,
      structuredContent: null,
      text: [],
      unsupportedContentTypes: []
    })),
    close: vi.fn(async () => undefined),
    fatalResponseErrorCode: vi.fn(() => null),
    isClosed: vi.fn(() => false),
    listTools: vi.fn(async () => [])
  };
}

function localLaunch(): McpRuntimeLaunch & { onToolsChanged(): void } {
  return {
    callTimeoutMs: 5_000,
    fingerprint: "a".repeat(64),
    generationId: "generation-1",
    headers: {},
    onToolsChanged() {},
    redactionValues: ["secret"],
    retryAt: null,
    startupTimeoutMs: 10_000,
    toolHive: {
      cmdArguments: ["--stdio"],
      envVars: { API_KEY: "per-user-value" },
      generationToken: "a".repeat(64),
      image: "npx://example-mcp@1.2.3"
    }
  };
}

describe("ToolHive MCP session factory", () => {
  it("starts a local workload and connects the common SDK to its rewritten proxy URL", async () => {
    const events: string[] = [];
    const active = session();
    const directCreate = vi.fn(async () => {
      events.push("direct-connect");
      return active;
    });
    const deleteOwnedWorkload = vi.fn(async () => true);
    const ensureReadyWorkload = vi.fn(async (_spec, options: {
      probe(url: string): Promise<void>;
    }) => {
      await options.probe("http://toolhive-runtime:28471/mcp");
      return {
        name: "owned-workload",
        port: 28_471,
        status: "running" as const,
        url: "http://toolhive-runtime:28471/mcp"
      };
    });
    const factory = createToolHiveMcpSessionFactory({
      directSessions: { create: directCreate },
      driver: { deleteOwnedWorkload, ensureReadyWorkload }
    });
    const launch = localLaunch();
    launch.onConnecting = async () => {
      events.push("connecting-boundary");
    };

    const wrapped = await factory.create(launch);

    expect(ensureReadyWorkload).toHaveBeenCalledWith(launch.toolHive, expect.objectContaining({
      timeoutMs: 10_000
    }));
    expect(directCreate).toHaveBeenCalledWith(expect.objectContaining({
      allowPrivateNetwork: true,
      headers: {},
      toolHive: undefined,
      trustedInternalHttp: true,
      url: "http://toolhive-runtime:28471/mcp"
    }));
    expect(events).toEqual(["connecting-boundary", "direct-connect"]);
    vi.mocked(active.fatalResponseErrorCode!).mockReturnValue("mcp_response_too_large");
    expect(wrapped.fatalResponseErrorCode?.()).toBe("mcp_response_too_large");
    expect(active.fatalResponseErrorCode).toHaveBeenCalledOnce();
    expect(wrapped.isClosed?.()).toBe(false);
    expect(active.isClosed).toHaveBeenCalledOnce();
    await wrapped.close();
    expect(active.close).toHaveBeenCalledTimes(1);
    expect(deleteOwnedWorkload).not.toHaveBeenCalled();

    await wrapped.dispose?.();
    expect(deleteOwnedWorkload).toHaveBeenCalledWith("a".repeat(64));
  });

  it("passes remote launches directly through without touching ToolHive", async () => {
    const active = session();
    const directCreate = vi.fn(async () => active);
    const driver = {
      deleteOwnedWorkload: vi.fn(async () => true),
      ensureReadyWorkload: vi.fn()
    };
    const factory = createToolHiveMcpSessionFactory({
      directSessions: { create: directCreate },
      driver
    });
    const launch = {
      ...localLaunch(),
      toolHive: undefined,
      url: "https://mcp.example.test/mcp"
    };

    await expect(factory.create(launch)).resolves.toBe(active);
    expect(directCreate).toHaveBeenCalledWith(launch);
    expect(driver.ensureReadyWorkload).not.toHaveBeenCalled();
  });
});
