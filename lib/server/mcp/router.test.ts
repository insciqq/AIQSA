import { describe, expect, it, vi } from "vitest";
import type { ProviderAdmissionRole } from "../providerRuntime/admission";
import type { McpCapabilityCatalog } from "./runPlan";
import {
  buildMcpRouterPrompt,
  createMcpSemanticRouter,
  McpSemanticRouterError
} from "./router";

const jiraTool = "mcp_jira_create_issue_1111111111";
const githubTool = "mcp_github_create_pull_request_2222222222";
const calendarTool = "mcp_calendar_create_event_3333333333";

const catalog: McpCapabilityCatalog = {
  servers: [{
    description: "Issue tracking and sprint planning",
    instructions: "Use project keys when creating work items.",
    namespace: "jira",
    revisionId: "revision-jira",
    serverId: "server-jira",
    serverName: "Jira",
    tools: [{
      arguments: [{
        description: "Project issue title",
        name: "summary",
        types: ["string"]
      }],
      description: "Create an issue in a project",
      namespacedName: jiraTool,
      originalName: "create_issue",
      title: "Create issue"
    }]
  }, {
    description: "Source code collaboration",
    namespace: "github",
    revisionId: "revision-github",
    serverId: "server-github",
    serverName: "GitHub",
    tools: [{
      arguments: [],
      description: "Open a pull request",
      namespacedName: githubTool,
      originalName: "create_pull_request"
    }]
  }, {
    description: "Team calendar",
    namespace: "calendar",
    revisionId: "revision-calendar",
    serverId: "server-calendar",
    serverName: "Calendar",
    tools: [{
      arguments: [],
      description: "Create a calendar event",
      namespacedName: calendarTool,
      originalName: "create_event"
    }]
  }],
  version: 1
};

function role(structuredOutput = true): ProviderAdmissionRole {
  const capabilities = {
    nativePdfInput: false,
    nativeSearch: false,
    pdf: false,
    reasoning: false,
    ...(structuredOutput ? { structuredOutput: true } : {}),
    vision: false
  };
  return {
    authority: {
      connectionId: "connection-system",
      connectionVersion: 1,
      credentialId: "credential-system",
      credentialVersionId: "credential-version-system",
      modelVersion: 1,
      providerModelId: "deployment-system"
    },
    credentialSource: "default",
    modelConfiguration: {
      adapterKind: "openai_responses_native",
      capabilities,
      defaultParams: {}
    },
    snapshot: {
      connection: {
        allowPrivateNetwork: false,
        apiRoot: "https://api.openai.example.test/v1",
        authenticationMode: "bearer",
        responseTimeoutMs: 300_000
      },
      connectionDisplayName: "System provider",
      connectionId: "connection-system",
      credentialId: "credential-system",
      credentialVersionId: "credential-version-system",
      model: {
        adapterKind: "openai_responses_native",
        answerSelectable: true,
        capabilities,
        defaultParams: {},
        modelClass: "answer",
        upstreamModelId: "gpt-router"
      },
      modelDisplayName: "Router model",
      providerFamily: "openai",
      providerModelId: "deployment-system",
      version: 1
    }
  };
}

function request(text = "Please create the issue") {
  return {
    content: {
      blocks: [
        { text, type: "text" },
        {
          base64Data: "ATTACHMENT_BYTES_CANARY",
          fileName: "private-roadmap.pdf",
          type: "attachment"
        }
      ]
    },
    context: {
      messages: [{
        content: { blocks: [{ text: "We discussed release planning.", type: "text" }] },
        id: "prior-user",
        role: "user" as const
      }, {
        content: {
          blocks: [{ text: "PRIVATE_SKILL_INSTRUCTIONS_CANARY", type: "text" }]
        },
        id: "skill-context:current-user",
        purpose: "skill_context" as const,
        role: "user" as const
      }, {
        content: {
          blocks: [{ privateToolResult: "RAW_TOOL_RESULT_CANARY", type: "tool_result" }]
        },
        id: "prior-tool",
        role: "assistant" as const
      }],
      mode: "branch_path" as const
    }
  };
}

function resolution(structuredOutput = true) {
  return {
    credentialScope: "installation" as const,
    ok: true as const,
    policyVersion: 1,
    providerModelId: "deployment-system",
    reasoningEffort: null,
    role: role(structuredOutput)
  };
}

describe("semantic MCP router", () => {
  it.each([
    ["создай задачу в проекте", jiraTool],
    ["open a pul reqest for this change", githubTool],
    ["добавь встречу в календарь", calendarTool]
  ])("routes multilingual or typo-rich goal %s", async (goal, selected) => {
    const executeStructuredOutput = vi.fn(async (_role, structuredRequest, options) => {
      options?.onUsage?.({ inputTokens: 12, outputTokens: 3, reasoningTokens: 0 });
      expect(structuredRequest.schema).toMatchObject({
        properties: {
          tool_ids: {
            items: { enum: [jiraTool, githubTool, calendarTool] },
            maxItems: 5,
            uniqueItems: true
          }
        }
      });
      return { tool_ids: [selected] };
    });
    const router = createMcpSemanticRouter({
      executeStructuredOutput,
      resolveSystemModel: async () => resolution()
    });

    await expect(router.route({
      activeToolNames: new Set(),
      catalog,
      goal,
      limit: 5,
      request: request(),
    })).resolves.toEqual({
      toolNames: [selected],
      usageAttribution: {
        modelId: "gpt-router",
        provider: "openai",
        usage: { inputTokens: 12, outputTokens: 3, reasoningTokens: 0 }
      }
    });
  });

  it("excludes loaded tools and supports an exact empty selection", async () => {
    const executeStructuredOutput = vi.fn(async (_role, structuredRequest) => {
      expect(JSON.stringify(structuredRequest.schema)).not.toContain(jiraTool);
      return { tool_ids: [] };
    });
    const router = createMcpSemanticRouter({
      executeStructuredOutput,
      resolveSystemModel: async () => resolution()
    });

    await expect(router.route({
      activeToolNames: new Set([jiraTool]),
      catalog,
      goal: "Just explain the architecture; do not perform an action",
      limit: 5,
      request: request()
    })).resolves.toEqual({ toolNames: [], usageAttribution: null });
  });

  it("projects only bounded text and compact schema-free catalog metadata", () => {
    const prompt = buildMcpRouterPrompt({
      activeToolNames: new Set(),
      catalog,
      goal: "Create the issue",
      request: request()
    });
    const serialized = `${prompt.systemPrompt}\n${prompt.userPrompt}`;

    expect(serialized).toContain("Project issue title");
    expect(serialized).toContain("Use project keys");
    expect(serialized).not.toContain("private-roadmap.pdf");
    expect(serialized).not.toContain("ATTACHMENT_BYTES_CANARY");
    expect(serialized).not.toContain("RAW_TOOL_RESULT_CANARY");
    expect(serialized).not.toContain("PRIVATE_SKILL_INSTRUCTIONS_CANARY");
    expect(serialized).not.toContain("inputSchema");
    expect(serialized).not.toContain("credential-system");
    expect(serialized.length).toBeLessThan(64_000);
  });

  it("rejects unknown IDs and duplicate output with a stable reason", async () => {
    const executeStructuredOutput = vi.fn()
      .mockResolvedValueOnce({ tool_ids: ["unknown-tool"] })
      .mockResolvedValueOnce({ tool_ids: [jiraTool, jiraTool] });
    const router = createMcpSemanticRouter({
      executeStructuredOutput,
      resolveSystemModel: async () => resolution()
    });
    const route = () => router.route({
      activeToolNames: new Set(),
      catalog,
      goal: "Create an issue",
      limit: 5,
      request: request()
    });

    await expect(route()).rejects.toEqual(
      new McpSemanticRouterError("mcp_router_output_invalid")
    );
    await expect(route()).rejects.toEqual(
      new McpSemanticRouterError("mcp_router_output_invalid")
    );
  });

  it("fails closed for absent or unverified System Model capability", async () => {
    const executeStructuredOutput = vi.fn();
    const absent = createMcpSemanticRouter({
      executeStructuredOutput,
      resolveSystemModel: async () => ({ code: "system_model_absent", ok: false })
    });
    const unverified = createMcpSemanticRouter({
      executeStructuredOutput,
      resolveSystemModel: async () => resolution(false)
    });
    const input = {
      activeToolNames: new Set<string>(),
      catalog,
      goal: "Create an issue",
      limit: 5,
      request: request()
    };

    await expect(absent.route(input)).rejects.toEqual(
      new McpSemanticRouterError("mcp_router_system_model_absent")
    );
    await expect(unverified.route(input)).rejects.toEqual(
      new McpSemanticRouterError("mcp_router_structured_output_unverified")
    );
    expect(executeStructuredOutput).not.toHaveBeenCalled();
  });
});
