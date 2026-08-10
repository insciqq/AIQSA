import { describe, expect, it } from "vitest";
import {
  boundedRedactedToolPreview,
  persistedToolCallActivity,
  toolCallInspectionArtifact,
  toolResultInspectionArtifact
} from "./toolInspection";

const mcp = {
  servers: [{
    credentialSources: ["oauth" as const],
    externalAccountLabel: "Memory workspace",
    fingerprint: "a".repeat(64),
    revisionId: "revision-1",
    serverId: "server-1",
    serverName: "Mem0"
  }],
  tools: [{
    definitionHash: "b".repeat(64),
    description: "Remember a fact",
    inputSchema: { type: "object" },
    name: "remember",
    namespacedName: "mcp_mem0_remember_1234567890",
    originalName: "remember",
    serverId: "server-1",
    serverName: "Mem0"
  }],
  version: 1 as const
};

describe("tool inspection evidence", () => {
  it("keeps a bounded useful shape while redacting credential-like fields and values", () => {
    const preview = boundedRedactedToolPreview({
      apiKey: "sk-super-secret-value",
      connector: {
        accessKey: "access-key-value",
        accessKeyId: "access-key-id-value",
        encryptionKey: "encryption-key-value",
        key: "generic-key-value",
        keyboardLayout: "qwerty",
        passphrase: "passphrase-value",
        signingKey: "signing-key-value",
        sshKey: "ssh-key-value"
      },
      nested: {
        authorization: "Bearer abcdefghijklmnop",
        query: "remember this with m0-abcdefghijklmnop and ntn_abcdefghijklmnop"
      },
      oauthToken: "oauth-secret-value",
      privateKey: "private-key-value",
      sessionToken: "session-secret-value",
      token: "plain-token-value",
      tokenLikeValue: "eyJabcdefghijk.abcdefghijk.abcdefghijk"
    });

    expect(JSON.stringify(preview)).toContain("remember this");
    expect(preview).toMatchObject({
      apiKey: "[redacted]",
      connector: {
        accessKey: "[redacted]",
        accessKeyId: "[redacted]",
        encryptionKey: "[redacted]",
        key: "[redacted]",
        keyboardLayout: "qwerty",
        passphrase: "[redacted]",
        signingKey: "[redacted]",
        sshKey: "[redacted]"
      },
      oauthToken: "[redacted]",
      privateKey: "[redacted]",
      sessionToken: "[redacted]",
      token: "[redacted]",
      tokenLikeValue: "[redacted]"
    });
    expect(JSON.stringify(preview)).not.toContain("super-secret");
    expect(JSON.stringify(preview)).not.toContain("abcdefghijklmnop");
    expect(JSON.stringify(preview)).not.toContain("m0-");
    expect(JSON.stringify(preview)).not.toContain("ntn_");
    expect(Buffer.byteLength(JSON.stringify(preview), "utf8")).toBeLessThanOrEqual(2_048);
  });

  it("publishes safe MCP snapshot metadata with bounded argument and result previews", () => {
    const call = {
      arguments: { apiKey: "sk-private", text: "useful" },
      id: "call-1",
      name: "mcp_mem0_remember_1234567890"
    };
    const callEvent = toolCallInspectionArtifact({ call, mcp, ordinal: 0, round: 1 });
    const resultEvent = toolResultInspectionArtifact({
      call,
      durationMs: 42.4,
      mcp,
      ordinal: 0,
      result: {
        callId: call.id,
        content: [{ text: "saved; Bearer abcdefghijklmnop", type: "text" }],
        name: call.name,
        status: "complete"
      },
      round: 1
    });

    expect(callEvent).toMatchObject({
      data: {
        payload: {
          argumentsPreview: { apiKey: "[redacted]", text: "useful" },
          snapshot: {
            capability: "mcp",
            credentialSources: ["oauth"],
            definitionHash: "b".repeat(64),
            externalAccountLabel: "Memory workspace",
            runtimeGenerationFingerprint: "a".repeat(64),
            serverName: "Mem0",
            toolName: "remember"
          }
        }
      }
    });
    expect(resultEvent).toMatchObject({
      data: {
        payload: {
          durationMs: 42,
          resultPreview: {
            content: [{ text: "saved; Bearer [redacted]", type: "text" }]
          }
        }
      }
    });
    expect(JSON.stringify(callEvent)).not.toContain("sk-private");
    expect(JSON.stringify(resultEvent)).not.toContain("abcdefghijklmnop");
  });

  it("labels first-party Memory actions separately from Search and MCP", () => {
    const event = toolCallInspectionArtifact({
      call: {
        arguments: { statement: "I prefer concise answers" },
        id: "memory-call-1",
        name: "save_memory"
      },
      ordinal: 0,
      round: 0
    });

    expect(event).toMatchObject({
      data: {
        payload: {
          snapshot: { capability: "memory", toolName: "save_memory" }
        }
      }
    });
  });

  it("projects a durable MCP call even when no artifact event was appended", () => {
    const activity = persistedToolCallActivity({
      call: {
        arguments: { apiKey: "sk-private-secret", query: "find memory" },
        completedAt: "2026-07-23T12:00:00.140Z",
        mcpRunBindingId: "binding-1",
        ordinal: 0,
        providerCallId: "provider-call-1",
        result: {
          callId: "provider-call-1",
          content: [{ text: "found memory", type: "text" }],
          name: "mcp_mem0_remember_1234567890",
          status: "complete"
        },
        roundIndex: 2,
        startedAt: "2026-07-23T12:00:00.000Z",
        state: "complete",
        toolName: "mcp_mem0_remember_1234567890"
      },
      normalizedRequest: { mcp },
      runStatus: "complete"
    });

    expect(activity).toMatchObject({
      argumentsPreview: { apiKey: "[redacted]", query: "find memory" },
      capability: "mcp",
      durationMs: 140,
      resultPreview: { content: [{ text: "found memory", type: "text" }] },
      round: 2,
      serverName: "Mem0",
      status: "complete",
      toolName: "remember"
    });
    expect(JSON.stringify(activity)).not.toContain("private-secret");
  });

  it("publishes and reconstructs bounded Search executions under their originating tool call", () => {
    const call = {
      arguments: { query: "latest news in Moscow" },
      id: "search-call-1",
      name: "search_selected_engines"
    };
    const result = {
      callId: call.id,
      content: [{ text: "Search completed", type: "text" as const }],
      name: call.name,
      rawPreview: {
        finalProviderResponsePreview: {
          searchExecutions: [{
            displayName: "Web Search · Sol",
            durationMs: 145_800,
            invocationId: "opaque-provider-invocation",
            modelId: "gpt-5.6-sol",
            optionId: "web-search-sol",
            provider: "openai-compatible",
            providerOperations: [{
              id: "ws-1",
              kind: "search",
              ordinal: 0,
              pattern: null,
              queries: ["Moscow latest news", "Moscow news today"],
              status: "complete",
              url: null
            }],
            query: "latest news in Moscow",
            requestPreview: { queryCharacters: 21 },
            revisionId: "revision-1",
            sources: [{ title: "Moscow news", url: "https://example.com/moscow" }],
            status: "complete",
            usage: { inputTokens: 2, outputTokens: 3, reasoningTokens: 0 }
          }]
        }
      },
      status: "complete" as const
    };

    const resultEvent = toolResultInspectionArtifact({
      call,
      durationMs: 145_900,
      ordinal: 0,
      result,
      round: 1
    });
    expect(resultEvent.data).toMatchObject({
      artifactType: "tool_result",
      payload: {
        callId: call.id,
        searchExecutions: [{
          displayName: "Web Search · Sol",
          durationMs: 145_800,
          providerOperations: [{
            kind: "search",
            queries: ["Moscow latest news", "Moscow news today"]
          }],
          query: "latest news in Moscow",
          sourceCount: 1
        }]
      }
    });

    const activity = persistedToolCallActivity({
      call: {
        arguments: call.arguments,
        completedAt: "2026-07-31T12:02:25.900Z",
        ordinal: 0,
        providerCallId: call.id,
        result,
        roundIndex: 1,
        startedAt: "2026-07-31T12:00:00.000Z",
        state: "complete",
        toolName: call.name
      },
      normalizedRequest: {},
      runStatus: "complete"
    });

    expect(activity).toMatchObject({
      callId: call.id,
      capability: "web_search",
      searchExecutions: [{
        displayName: "Web Search · Sol",
        providerOperations: [{
          kind: "search",
          queries: ["Moscow latest news", "Moscow news today"]
        }],
        query: "latest news in Moscow"
      }],
      toolName: "search_selected_engines"
    });
    expect(JSON.stringify(activity)).not.toContain("opaque-provider-invocation");
    expect(JSON.stringify(activity)).not.toContain("requestPreview");
  });
});
