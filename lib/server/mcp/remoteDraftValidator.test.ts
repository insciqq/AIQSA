import type { McpDraftConfiguration } from "@/lib/contracts/mcp";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { describe, expect, it, vi } from "vitest";
import {
  McpClientSessionError,
  type AiqsaMcpToolDefinition,
  type McpClientSessionOptions
} from "./clientSession";
import {
  createRemoteMcpDraftValidator,
  type McpRemoteDraftValidationSession,
  type McpRemoteDraftValidationSessionFactory
} from "./remoteDraftValidator";

const SECRET = "Bearer validation-secret";
const URL_SECRET = "query-secret-must-not-leak";

function remoteDraft(input: {
  auth?: McpDraftConfiguration["auth"];
  slots?: McpDraftConfiguration["slots"];
  url?: string;
} = {}): McpDraftConfiguration {
  return {
    auth: input.auth ?? { mode: "static" },
    runtime: { callTimeoutMs: 28_000, startupTimeoutMs: 41_000 },
    slots: input.slots ?? [
      {
        label: "Authorization",
        policy: { allowPersonalOverride: true, kind: "shared" },
        sensitive: true,
        slotKey: "authorization",
        target: { kind: "header", name: "Authorization" },
        valueType: "secret"
      },
      {
        label: "Workspace",
        policy: { kind: "personal", required: true },
        sensitive: false,
        slotKey: "workspace",
        target: { kind: "header", name: "X-Workspace" },
        valueType: "string"
      },
      {
        label: "Retries",
        policy: { kind: "literal", value: 3 },
        sensitive: false,
        slotKey: "retries",
        target: { kind: "header", name: "X-Retries" },
        valueType: "number"
      }
    ],
    source: {
      kind: "remote",
      url: input.url ?? `https://mcp.example.test/rpc?api_key=${URL_SECRET}`
    },
    transport: "streamable_http"
  };
}

function localDraft(): McpDraftConfiguration {
  return {
    auth: { mode: "none" },
    runtime: { callTimeoutMs: 28_000, startupTimeoutMs: 41_000 },
    slots: [],
    source: { args: [], kind: "npm", packageName: "example-mcp", versionSelector: "1.0.0" },
    transport: "stdio"
  };
}

function tool(input: Partial<AiqsaMcpToolDefinition> & { name: string }): AiqsaMcpToolDefinition {
  return {
    definitionHash: "a".repeat(64),
    description: null,
    inputSchema: { type: "object" },
    ...input
  };
}

function sessionHarness(input: {
  initializeError?: Error;
  listError?: Error;
  tools?: readonly AiqsaMcpToolDefinition[];
} = {}) {
  const events: string[] = [];
  const options: McpClientSessionOptions[] = [];
  const session: McpRemoteDraftValidationSession = {
    async close() {
      events.push("close");
    },
    async initialize() {
      events.push("initialize");
      if (input.initializeError) throw input.initializeError;
    },
    async listAllTools() {
      events.push("listAllTools");
      if (input.listError) throw input.listError;
      return input.tools ?? [];
    }
  };
  const sessionFactory: McpRemoteDraftValidationSessionFactory = (sessionOptions) => {
    options.push(sessionOptions);
    return session;
  };
  return { events, options, sessionFactory };
}

const safeFetch: McpClientSessionOptions["fetch"] = async () => new Response("unused");

describe("remote MCP draft validator", () => {
  it("discovers a static-header remote draft through the injected safe session", async () => {
    const progress: string[] = [];
    const harness = sessionHarness({
      tools: [
        tool({ description: "Create a task", name: "create_task" }),
        tool({ definitionHash: "b".repeat(64), description: "List tasks", name: "list_tasks" })
      ]
    });
    const validator = createRemoteMcpDraftValidator({
      fetch: safeFetch,
      sessionFactory: harness.sessionFactory
    });
    const outcome = await validator.validate({
      draft: remoteDraft(),
      onProgress: async (stage) => {
        progress.push(stage);
      },
      values: {
        authorization: SECRET,
        retries: 3,
        workspace: "workspace-a"
      }
    });

    expect(outcome).toMatchObject({
      evidence: {
        endpointHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        toolCount: 2,
        toolDefinitionHashes: ["a".repeat(64), "b".repeat(64)],
        toolInventoryHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        transport: "streamable_http"
      },
      kind: "ok",
      resolvedArtifact: {
        endpointHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        kind: "remote",
        transport: "streamable_http"
      },
      toolInventory: [
        { description: "Create a task", name: "create_task" },
        { description: "List tasks", name: "list_tasks" }
      ]
    });
    expect(harness.events).toEqual(["initialize", "listAllTools", "close"]);
    expect(progress).toEqual(["connecting", "discovering_tools"]);
    expect(harness.options).toHaveLength(1);
    expect(harness.options[0]).toMatchObject({
      fetch: safeFetch,
      headers: {
        authorization: SECRET,
        "x-retries": "3",
        "x-workspace": "workspace-a"
      },
      requestTimeoutMs: 28_000,
      url: new URL(`https://mcp.example.test/rpc?api_key=${URL_SECRET}`)
    });
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
    expect(JSON.stringify(outcome)).not.toContain(URL_SECRET);
    expect(JSON.stringify(outcome)).not.toContain("https://mcp.example.test");
  });

  it("supports an unauthenticated remote without inventing headers", async () => {
    const harness = sessionHarness();
    const validator = createRemoteMcpDraftValidator({ fetch: safeFetch, sessionFactory: harness.sessionFactory });
    const outcome = await validator.validate({
      draft: remoteDraft({ auth: { mode: "none" }, slots: [], url: "https://mcp.example.test/rpc" }),
      values: {}
    });

    expect(outcome.kind).toBe("ok");
    expect(harness.options[0]?.headers).toEqual({});
  });

  it("rejects exact known secrets anywhere in the complete tool inventory", async () => {
    const leakingHarness = sessionHarness({
      tools: [
        tool({ description: `Server echoed ${SECRET}`, name: "safe_tool" }),
        tool({
          definitionHash: "b".repeat(64),
          description: `Endpoint echoed ${URL_SECRET}`,
          name: "endpoint_tool"
        })
      ]
    });
    const leakingValidator = createRemoteMcpDraftValidator({
      fetch: safeFetch,
      sessionFactory: leakingHarness.sessionFactory
    });
    const rejectedDescription = await leakingValidator.validate({
      draft: remoteDraft({ slots: [remoteDraft().slots[0]!] }),
      values: { authorization: SECRET }
    });
    expect(rejectedDescription).toEqual({
      issues: [{ code: "mcp_remote_inventory_unsafe", path: "tools" }],
      kind: "invalid"
    });
    expect(JSON.stringify(rejectedDescription)).not.toContain(SECRET);
    expect(JSON.stringify(rejectedDescription)).not.toContain(URL_SECRET);

    const identitySecret = "validation-secret";
    const unsafeHarness = sessionHarness({ tools: [tool({ name: `do_${identitySecret}` })] });
    const unsafeValidator = createRemoteMcpDraftValidator({
      fetch: safeFetch,
      sessionFactory: unsafeHarness.sessionFactory
    });
    const rejected = await unsafeValidator.validate({
      draft: remoteDraft({ slots: [remoteDraft().slots[0]!] }),
      values: { authorization: identitySecret }
    });
    expect(rejected).toEqual({
      issues: [{ code: "mcp_remote_inventory_unsafe", path: "tools.0.name" }],
      kind: "invalid"
    });
    expect(JSON.stringify(rejected)).not.toContain(identitySecret);
  });

  it("returns stable deferred results for local and OAuth drafts without opening a session", async () => {
    const sessionFactory = vi.fn<McpRemoteDraftValidationSessionFactory>();
    const validator = createRemoteMcpDraftValidator({ fetch: safeFetch, sessionFactory });

    await expect(validator.validate({ draft: localDraft(), values: {} })).resolves.toEqual({
      issues: [{ code: "mcp_local_runtime_unavailable", path: "source.kind" }],
      kind: "invalid"
    });
    await expect(validator.validate({
      draft: remoteDraft({
        auth: {
          allowedAuthorizationServerOrigins: ["https://auth.example.test"],
          mode: "oauth",
          scopes: ["tasks:read"]
        },
        slots: []
      }),
      values: {}
    })).resolves.toEqual({
      issues: [{ code: "mcp_oauth_validation_deferred", path: "auth.mode" }],
      kind: "invalid"
    });
    expect(sessionFactory).not.toHaveBeenCalled();
  });

  it("uses an entitled administrator validation connection for an OAuth draft", async () => {
    const harness = sessionHarness({ tools: [tool({ name: "oauth_tool" })] });
    const provider = {} as OAuthClientProvider;
    const oauthProviderForDraft = vi.fn(async () => provider);
    const validator = createRemoteMcpDraftValidator({
      fetch: safeFetch,
      oauthProviderForDraft,
      sessionFactory: harness.sessionFactory
    });
    const draft = remoteDraft({
      auth: {
        allowedAuthorizationServerOrigins: ["https://auth.example.test"],
        mode: "oauth",
        scopes: ["tasks:read"]
      },
      slots: []
    });
    const outcome = await validator.validate({
      draft,
      serverId: "server-1",
      validationUserId: "admin-1",
      values: {}
    });

    expect(outcome).toMatchObject({
      kind: "ok",
      toolInventory: [{ name: "oauth_tool" }]
    });
    expect(oauthProviderForDraft).toHaveBeenCalledWith(expect.objectContaining({
      serverId: "server-1",
      validationUserId: "admin-1"
    }));
    expect(harness.options[0]?.authProvider).toBe(provider);
    expect(harness.events).toEqual(["initialize", "listAllTools", "close"]);
  });

  it("rejects an OAuth token reflected inside a validation schema", async () => {
    const oauthSecret = "oauth-validation-access-token";
    const harness = sessionHarness({
      tools: [tool({
        inputSchema: {
          properties: { token: { default: oauthSecret, type: "string" } },
          type: "object"
        },
        name: "oauth_tool"
      })]
    });
    const provider = {
      exactKnownSecrets: () => [oauthSecret]
    } as unknown as OAuthClientProvider & { exactKnownSecrets(): readonly string[] };
    const validator = createRemoteMcpDraftValidator({
      fetch: safeFetch,
      oauthProviderForDraft: async () => provider,
      sessionFactory: harness.sessionFactory
    });

    const outcome = await validator.validate({
      draft: remoteDraft({
        auth: {
          allowedAuthorizationServerOrigins: ["https://auth.example.test"],
          mode: "oauth",
          scopes: ["tasks:read"]
        },
        slots: []
      }),
      serverId: "server-1",
      validationUserId: "admin-1",
      values: {}
    });

    expect(outcome).toEqual({
      issues: [{ code: "mcp_remote_inventory_unsafe", path: "tools" }],
      kind: "invalid"
    });
    expect(JSON.stringify(outcome)).not.toContain(oauthSecret);
  });

  it("returns only stable error codes and closes after startup or discovery failure", async () => {
    const rawSecret = `${SECRET} ${URL_SECRET}`;
    const startupHarness = sessionHarness({ initializeError: new Error(rawSecret) });
    const startupValidator = createRemoteMcpDraftValidator({
      fetch: safeFetch,
      sessionFactory: startupHarness.sessionFactory
    });
    const startupFailure = await startupValidator.validate({
      draft: remoteDraft({ auth: { mode: "none" }, slots: [] }),
      values: {}
    });
    expect(startupFailure).toEqual({
      issues: [{ code: "mcp_remote_validation_failed", path: "source" }],
      kind: "invalid"
    });
    expect(startupHarness.events).toEqual(["initialize", "close"]);
    expect(JSON.stringify(startupFailure)).not.toContain(rawSecret);

    const discoveryHarness = sessionHarness({
      listError: new McpClientSessionError({
        code: "mcp_list_tools_failed",
        operation: "list_tools",
        retryable: true
      })
    });
    const discoveryValidator = createRemoteMcpDraftValidator({
      fetch: safeFetch,
      sessionFactory: discoveryHarness.sessionFactory
    });
    await expect(discoveryValidator.validate({
      draft: remoteDraft({ auth: { mode: "none" }, slots: [] }),
      values: {}
    })).resolves.toEqual({
      issues: [{ code: "mcp_list_tools_failed", path: "tools" }],
      kind: "invalid"
    });
    expect(discoveryHarness.events).toEqual(["initialize", "listAllTools", "close"]);
  });

  it("rejects missing effective values and reserved headers before session creation", async () => {
    const sessionFactory = vi.fn<McpRemoteDraftValidationSessionFactory>();
    const validator = createRemoteMcpDraftValidator({ fetch: safeFetch, sessionFactory });
    const reservedSlot = {
      ...remoteDraft().slots[0]!,
      target: { kind: "header" as const, name: "Mcp-Session-Id" }
    };

    await expect(validator.validate({
      draft: remoteDraft({ slots: [remoteDraft().slots[0]!] }),
      values: {}
    })).resolves.toEqual({
      issues: [{ code: "mcp_effective_value_required", path: "values.authorization" }],
      kind: "invalid"
    });
    await expect(validator.validate({
      draft: remoteDraft({ slots: [reservedSlot] }),
      values: { authorization: SECRET }
    })).resolves.toEqual({
      issues: [{ code: "mcp_static_header_reserved", path: "slots.0.target.name" }],
      kind: "invalid"
    });
    expect(sessionFactory).not.toHaveBeenCalled();
  });
});
