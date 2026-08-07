import type { McpDraftConfiguration } from "@/lib/contracts/mcp";
import { describe, expect, it, vi } from "vitest";
import { McpDraftValidationAbortedError } from "./draftValidator";
import { createInFlightValidationWorkloadRegistry } from "./inFlightValidationWorkloads";
import type { McpRuntimeSession } from "./runtimeCoordinator";
import { createLocalMcpDraftValidator } from "./localDraftValidator";

const TOKEN = "a".repeat(32);
const GENERATED_IMAGE = "toolhivelocal/example-mcp:resolved-1-2-3";

const draft: McpDraftConfiguration = {
  auth: { mode: "static" },
  runtime: { callTimeoutMs: 12_000, startupTimeoutMs: 90_000 },
  slots: [{
    label: "API key",
    policy: { allowPersonalOverride: true, kind: "shared" },
    sensitive: true,
    slotKey: "api-key",
    target: { kind: "environment", name: "API_KEY" },
    valueType: "secret"
  }, {
    label: "Mode",
    policy: { kind: "literal", value: "safe" },
    sensitive: false,
    slotKey: "mode",
    target: { kind: "environment", name: "MODE" },
    valueType: "string"
  }],
  source: {
    args: ["--stdio"],
    kind: "npm",
    packageName: "example-mcp",
    versionSelector: "^1.0.0"
  },
  transport: "stdio"
};

function session(): McpRuntimeSession {
  return {
    callTool: vi.fn(async () => ({
      isError: false,
      structuredContent: null,
      text: [],
      unsupportedContentTypes: []
    })),
    close: vi.fn(async () => undefined),
    listTools: vi.fn(async () => [{
      definitionHash: "b".repeat(64),
      description: "Runs the example operation",
      inputSchema: { type: "object" },
      name: "example.run"
    }])
  };
}

function detail(image = GENERATED_IMAGE) {
  return {
    cmdArguments: ["--stdio"],
    envVars: { API_KEY: "super-secret", MODE: "safe" },
    group: "aiqsa-owner",
    host: "0.0.0.0",
    image,
    name: `aiqsa-owner-${TOKEN}`,
    networkIsolation: false,
    proxyMode: "streamable-http",
    proxyPort: 20_000,
    transport: "stdio"
  } as const;
}

function deferred<Value = void>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("local MCP draft validation", () => {
  it("materializes an exact npm package, inventories tools, and deletes the validation workload", async () => {
    const progress: string[] = [];
    const active = session();
    const retentionRegistry = createInFlightValidationWorkloadRegistry();
    const create = vi.fn(async () => {
      expect(retentionRegistry.snapshot()).toEqual([TOKEN]);
      return active;
    });
    const deleteOwnedWorkload = vi.fn(async () => true);
    const getWorkload = vi.fn(async () => detail());
    const validator = createLocalMcpDraftValidator({
      client: { getWorkload, getWorkloadLogs: vi.fn(async () => "") },
      driver: {
        deleteOwnedWorkload,
        workloadName: (token) => `aiqsa-owner-${token}`
      },
      packageResolver: async () => ({
        kind: "ok",
        value: {
          artifactUrl: "https://registry.npmjs.org/example-mcp/-/example-mcp-1.2.3.tgz",
          exactVersion: "1.2.3",
          integrity: "sha512-YWJjZA==",
          materializer: "npx",
          packageName: "example-mcp",
          protocolImage: "npx://example-mcp@1.2.3",
          sourceKind: "npm"
        }
      }),
      randomToken: () => {
        throw new Error("persisted workload token must win");
      },
      retentionRegistry,
      sessions: { create }
    });

    const outcome = await validator.validate({
      draft,
      onProgress: async (stage) => {
        progress.push(stage);
      },
      values: { "api-key": "super-secret", mode: "safe" },
      workloadToken: TOKEN
    });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      callTimeoutMs: 12_000,
      startupTimeoutMs: 90_000,
      toolHive: {
        cmdArguments: ["--stdio"],
        envVars: { API_KEY: "super-secret", MODE: "safe" },
        generationToken: TOKEN,
        image: "npx://example-mcp@1.2.3"
      }
    }));
    expect(getWorkload).toHaveBeenCalledWith(`aiqsa-owner-${TOKEN}`);
    expect(outcome).toMatchObject({
      evidence: {
        materializer: "npx",
        toolCount: 1,
        transport: "stdio"
      },
      kind: "ok",
      resolvedArtifact: {
        exactVersion: "1.2.3",
        imageRef: GENERATED_IMAGE,
        imageReferenceKind: "toolhive_generated_tag",
        kind: "toolhive_local",
        materializer: "npx",
        packageName: "example-mcp",
        registryIntegrity: "sha512-YWJjZA==",
        sourceKind: "npm",
        toolhiveVersion: "v0.40.1"
      },
      toolInventory: [{ description: "Runs the example operation", name: "example.run" }]
    });
    expect(JSON.stringify(outcome)).not.toContain("super-secret");
    expect(active.close).toHaveBeenCalledTimes(1);
    expect(deleteOwnedWorkload).toHaveBeenCalledWith(TOKEN);
    expect(retentionRegistry.snapshot()).toEqual([]);
    expect(progress).toEqual(["resolving", "preparing_runtime", "discovering_tools"]);
  });

  it("rejects a package artifact when ToolHive did not return a generated image", async () => {
    const active = session();
    const validator = createLocalMcpDraftValidator({
      client: {
        getWorkload: vi.fn(async () => detail("npx://example-mcp@1.2.3")),
        getWorkloadLogs: vi.fn(async () => "")
      },
      driver: {
        deleteOwnedWorkload: vi.fn(async () => true),
        workloadName: (token) => `aiqsa-owner-${token}`
      },
      packageResolver: async () => ({
        kind: "ok",
        value: {
          artifactUrl: "https://registry.npmjs.org/example-mcp/-/example-mcp-1.2.3.tgz",
          exactVersion: "1.2.3",
          integrity: "sha512-YWJjZA==",
          materializer: "npx",
          packageName: "example-mcp",
          protocolImage: "npx://example-mcp@1.2.3",
          sourceKind: "npm"
        }
      }),
      randomToken: () => TOKEN,
      sessions: { create: vi.fn(async () => active) }
    });

    await expect(validator.validate({
      draft,
      values: { "api-key": "super-secret", mode: "safe" }
    })).resolves.toEqual({
      issues: [{ code: "mcp_local_artifact_invalid", path: "source" }],
      kind: "invalid"
    });
  });

  it("rejects an exact known secret anywhere in the complete tool inventory", async () => {
    const active = session();
    active.listTools = vi.fn(async () => [{
      definitionHash: "b".repeat(64),
      description: "Safe description",
      inputSchema: {
        properties: {
          value: { default: "super-secret", type: "string" }
        },
        type: "object"
      },
      name: "example.run"
    }]);
    const deleteOwnedWorkload = vi.fn(async () => true);
    const retentionRegistry = createInFlightValidationWorkloadRegistry();
    const validator = createLocalMcpDraftValidator({
      client: {
        getWorkload: vi.fn(async () => detail()),
        getWorkloadLogs: vi.fn(async () => "")
      },
      driver: {
        deleteOwnedWorkload,
        workloadName: (token) => `aiqsa-owner-${token}`
      },
      packageResolver: async () => ({
        kind: "ok",
        value: {
          artifactUrl: "https://registry.npmjs.org/example-mcp/-/example-mcp-1.2.3.tgz",
          exactVersion: "1.2.3",
          integrity: "sha512-YWJjZA==",
          materializer: "npx",
          packageName: "example-mcp",
          protocolImage: "npx://example-mcp@1.2.3",
          sourceKind: "npm"
        }
      }),
      randomToken: () => TOKEN,
      retentionRegistry,
      sessions: { create: vi.fn(async () => active) }
    });

    const outcome = await validator.validate({
      draft,
      values: { "api-key": "super-secret", mode: "safe" }
    });

    expect(outcome).toEqual({
      issues: [{ code: "mcp_local_inventory_unsafe", path: "tools" }],
      kind: "invalid"
    });
    expect(JSON.stringify(outcome)).not.toContain("super-secret");
    expect(active.close).toHaveBeenCalledTimes(1);
    expect(deleteOwnedWorkload).toHaveBeenCalledWith(TOKEN);
    expect(retentionRegistry.snapshot()).toEqual([]);
  });

  it("turns bounded startup output into an actionable missing-environment issue", async () => {
    const rawOutput = [
      "internal startup detail that must not escape",
      "canvas-mcp: missing CANVAS_BASE_URL. Create ~/.canvas.env from .canvas.env.example."
    ].join("\n");
    const getWorkloadLogs = vi.fn(async () => rawOutput);
    const deleteOwnedWorkload = vi.fn(async () => true);
    const canvasDraft: McpDraftConfiguration = {
      auth: { mode: "none" },
      runtime: { callTimeoutMs: 5_000, startupTimeoutMs: 20_000 },
      slots: [],
      source: {
        args: [],
        kind: "pypi",
        packageName: "canvas-local-mcp",
        versionSelector: "0.1.1"
      },
      transport: "stdio"
    };
    const validator = createLocalMcpDraftValidator({
      client: {
        getWorkload: vi.fn(async () => detail()),
        getWorkloadLogs
      },
      driver: {
        deleteOwnedWorkload,
        workloadName: (token) => `aiqsa-owner-${token}`
      },
      packageResolver: async () => ({
        kind: "ok",
        value: {
          artifactUrl: "https://files.pythonhosted.org/canvas-local-mcp-0.1.1.tar.gz",
          exactVersion: "0.1.1",
          integrity: "sha256:example",
          materializer: "uvx",
          packageName: "canvas-local-mcp",
          protocolImage: "uvx://canvas-local-mcp@0.1.1",
          sourceKind: "pypi"
        }
      }),
      randomToken: () => TOKEN,
      sessions: {
        create: vi.fn(async () => {
          throw new Error("untrusted process failure");
        })
      }
    });

    const outcome = await validator.validate({ draft: canvasDraft, values: {} });

    expect(outcome).toEqual({
      issues: [{
        code: "mcp_local_environment_missing",
        path: "slots.CANVAS_BASE_URL"
      }],
      kind: "invalid"
    });
    expect(getWorkloadLogs).toHaveBeenCalledWith(`aiqsa-owner-${TOKEN}`);
    expect(deleteOwnedWorkload).toHaveBeenCalledWith(TOKEN);
    expect(JSON.stringify(outcome)).not.toContain("internal startup detail");
    expect(getWorkloadLogs.mock.invocationCallOrder[0]).toBeLessThan(
      deleteOwnedWorkload.mock.invocationCallOrder[0] ?? 0
    );
  });

  it("does not return unclassified workload output in a validation response", async () => {
    const rawOutput = "Traceback: arbitrary workload output and configuration detail";
    const validator = createLocalMcpDraftValidator({
      client: {
        getWorkload: vi.fn(async () => detail()),
        getWorkloadLogs: vi.fn(async () => rawOutput)
      },
      driver: {
        deleteOwnedWorkload: vi.fn(async () => true),
        workloadName: (token) => `aiqsa-owner-${token}`
      },
      packageResolver: async () => ({
        kind: "ok",
        value: {
          artifactUrl: "https://registry.npmjs.org/example-mcp/-/example-mcp-1.2.3.tgz",
          exactVersion: "1.2.3",
          integrity: "sha512-YWJjZA==",
          materializer: "npx",
          packageName: "example-mcp",
          protocolImage: "npx://example-mcp@1.2.3",
          sourceKind: "npm"
        }
      }),
      randomToken: () => TOKEN,
      sessions: {
        create: vi.fn(async () => {
          throw new Error("startup failed");
        })
      }
    });

    const outcome = await validator.validate({
      draft,
      values: { "api-key": "super-secret", mode: "safe" }
    });

    expect(outcome).toEqual({
      issues: [{ code: "mcp_local_process_failed", path: "source" }],
      kind: "invalid"
    });
    expect(JSON.stringify(outcome)).not.toContain(rawOutput);
    expect(JSON.stringify(outcome)).not.toContain("super-secret");
  });

  it("releases retention when validation is aborted before a session exists", async () => {
    const retentionRegistry = createInFlightValidationWorkloadRegistry();
    const deleteOwnedWorkload = vi.fn(async () => {
      throw new Error("cleanup unavailable");
    });
    const validator = createLocalMcpDraftValidator({
      client: {
        getWorkload: vi.fn(async () => detail()),
        getWorkloadLogs: vi.fn(async () => "")
      },
      driver: {
        deleteOwnedWorkload,
        workloadName: (token) => `aiqsa-owner-${token}`
      },
      packageResolver: async () => ({
        kind: "ok",
        value: {
          artifactUrl: "https://registry.npmjs.org/example-mcp/-/example-mcp-1.2.3.tgz",
          exactVersion: "1.2.3",
          integrity: "sha512-YWJjZA==",
          materializer: "npx",
          packageName: "example-mcp",
          protocolImage: "npx://example-mcp@1.2.3",
          sourceKind: "npm"
        }
      }),
      randomToken: () => TOKEN,
      retentionRegistry,
      sessions: {
        create: vi.fn(async () => {
          expect(retentionRegistry.snapshot()).toEqual([TOKEN]);
          throw new McpDraftValidationAbortedError();
        })
      }
    });

    await expect(validator.validate({
      draft,
      values: { "api-key": "super-secret", mode: "safe" }
    })).rejects.toBeInstanceOf(McpDraftValidationAbortedError);
    expect(deleteOwnedWorkload).toHaveBeenCalledWith(TOKEN);
    expect(retentionRegistry.snapshot()).toEqual([]);
  });

  it("retains concurrent validation workloads independently", async () => {
    const firstToken = "c".repeat(32);
    const secondToken = "d".repeat(32);
    const firstEntered = deferred();
    const secondEntered = deferred();
    const releaseFirst = deferred();
    const releaseSecond = deferred();
    const retentionRegistry = createInFlightValidationWorkloadRegistry();
    const validator = createLocalMcpDraftValidator({
      client: {
        getWorkload: vi.fn(async () => detail()),
        getWorkloadLogs: vi.fn(async () => "")
      },
      driver: {
        deleteOwnedWorkload: vi.fn(async () => true),
        workloadName: (token) => `aiqsa-owner-${token}`
      },
      packageResolver: async () => ({
        kind: "ok",
        value: {
          artifactUrl: "https://registry.npmjs.org/example-mcp/-/example-mcp-1.2.3.tgz",
          exactVersion: "1.2.3",
          integrity: "sha512-YWJjZA==",
          materializer: "npx",
          packageName: "example-mcp",
          protocolImage: "npx://example-mcp@1.2.3",
          sourceKind: "npm"
        }
      }),
      retentionRegistry,
      sessions: {
        create: vi.fn(async (launch) => {
          if (launch.toolHive?.generationToken === firstToken) {
            firstEntered.resolve();
            await releaseFirst.promise;
          } else {
            secondEntered.resolve();
            await releaseSecond.promise;
          }
          return session();
        })
      }
    });
    const first = validator.validate({
      draft,
      values: { "api-key": "super-secret", mode: "safe" },
      workloadToken: firstToken
    });
    const second = validator.validate({
      draft,
      values: { "api-key": "super-secret", mode: "safe" },
      workloadToken: secondToken
    });

    await Promise.all([firstEntered.promise, secondEntered.promise]);
    expect(retentionRegistry.snapshot()).toEqual([firstToken, secondToken]);
    releaseFirst.resolve();
    await first;
    expect(retentionRegistry.snapshot()).toEqual([secondToken]);
    releaseSecond.resolve();
    await second;
    expect(retentionRegistry.snapshot()).toEqual([]);
  });

  it("does not retain remote-source validation", async () => {
    const register = vi.fn(() => ({ release: vi.fn() }));
    const validator = createLocalMcpDraftValidator({
      client: { getWorkload: vi.fn(), getWorkloadLogs: vi.fn() },
      driver: { deleteOwnedWorkload: vi.fn(), workloadName: vi.fn() },
      retentionRegistry: { register, snapshot: () => [] },
      sessions: { create: vi.fn() }
    });

    await expect(validator.validate({
      draft: {
        ...draft,
        source: { allowPrivateNetwork: false, kind: "remote", url: "https://mcp.example.test" },
        transport: "streamable_http"
      },
      values: { "api-key": "super-secret", mode: "safe" }
    })).resolves.toEqual({
      issues: [{ code: "mcp_local_source_required", path: "source.kind" }],
      kind: "invalid"
    });
    expect(register).not.toHaveBeenCalled();
  });

  it("runs a digest-pinned OCI draft directly without package resolution", async () => {
    const image = `example.invalid/mcp@sha256:${"c".repeat(64)}`;
    const active = session();
    const create = vi.fn(async () => active);
    const packageResolver = vi.fn(async () => {
      throw new Error("package resolver must not run for OCI");
    });
    const validator = createLocalMcpDraftValidator({
      client: {
        getWorkload: vi.fn(async () => detail(image)),
        getWorkloadLogs: vi.fn(async () => "")
      },
      driver: {
        deleteOwnedWorkload: vi.fn(async () => true),
        workloadName: (token) => `aiqsa-owner-${token}`
      },
      packageResolver,
      randomToken: () => TOKEN,
      sessions: { create }
    });
    const ociDraft: McpDraftConfiguration = {
      auth: { mode: "none" },
      runtime: { callTimeoutMs: 5_000, startupTimeoutMs: 20_000 },
      slots: [],
      source: { args: ["--stdio"], image, kind: "oci" },
      transport: "stdio"
    };

    const outcome = await validator.validate({ draft: ociDraft, values: {} });

    expect(packageResolver).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      toolHive: expect.objectContaining({ image })
    }));
    expect(outcome).toMatchObject({
      kind: "ok",
      resolvedArtifact: {
        imageRef: image,
        imageReferenceKind: "oci_digest",
        materializer: "oci",
        sourceKind: "oci"
      }
    });
  });
});
