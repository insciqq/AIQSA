import { describe, expect, it, vi } from "vitest";
import type { ProviderAdmissionRole } from "../providerRuntime/admission";
import { mcpChatDiscoveryContext } from "./chatDiscoveryContext";
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
  it.each([false, true])("gives a 114-tool catalog the configured reasoning/JSON allowance (reasoning=%s)", async (reasoning) => {
    const largeCatalog: McpCapabilityCatalog = { ...catalog, servers: [{ ...catalog.servers[0]!,
      tools: Array.from({ length: 114 }, (_, index) => ({ description: "Read synthetic data", namespacedName: `mcp_test_${index}`, originalName: `test_${index}` }))
    }] };
    const executeStructuredOutput = vi.fn(async (_role, structured, options) => {
      options?.onUsage?.({ inputTokens: 100, outputTokens: structured.maxOutputTokens === 1024 ? 1024 : 3242 });
      if (structured.maxOutputTokens === 1024) throw new Error("structured_output_output_limit_exceeded");
      expect(structured.reasoningEffort).toBe(reasoning ? "high" : null);
      return { mcp_needed: true, requirements: [{ outcome: "Read data", status: "covered", tool_ids: ["mcp_test_0"] }] };
    });
    const router = createMcpSemanticRouter({ executeStructuredOutput, resolveSystemModel: async () => ({
      ...resolution(), reasoningEffort: reasoning ? "high" : null
    }) });
    const input = { activeToolNames: new Set<string>(), catalog: largeCatalog, goals: ["Read data"], limit: 10, context: mcpChatDiscoveryContext(request()) };
    await expect(router.route({ ...input, maxOutputTokens: null })).rejects.toMatchObject({
      code: "mcp_router_output_limit", usageAttribution: { usage: { outputTokens: 1024 } }
    });
    await expect(router.route(input)).resolves.toMatchObject({ toolNames: ["mcp_test_0"] });
    await expect(router.route({ ...input, maxOutputTokens: 4096 })).resolves.toMatchObject({ toolNames: ["mcp_test_0"] });
    expect(executeStructuredOutput.mock.calls.map((call) => call[1].maxOutputTokens)).toEqual([1024, 8192, 4096]);
  });

  it.each(["saved", "catalog"])("rejects the %s model ceiling before I/O without reducing the requested cap", async (source) => {
    const executeStructuredOutput = vi.fn();
    let resolved = resolution();
    if (source === "saved") {
      resolved.role.modelConfiguration.capabilities.maxOutputTokens = 8192;
    } else {
      resolved = { ...resolved, role: {
        ...resolved.role,
        modelConfiguration: { ...resolved.role.modelConfiguration, adapterKind: "openrouter_chat_completions" },
        snapshot: { ...resolved.role.snapshot, providerFamily: "openrouter", model: {
          ...resolved.role.snapshot.model, adapterKind: "openrouter_chat_completions",
          answerSelectable: true, modelClass: "answer",
          upstreamModelId: "perplexity/sonar-pro-search"
        } }
      } };
    }
    const router = createMcpSemanticRouter({ executeStructuredOutput, resolveSystemModel: async () => resolved });
    await expect(router.route({ activeToolNames: new Set(), catalog, goals: ["Read data"], limit: 10,
      maxOutputTokens: 32768, context: mcpChatDiscoveryContext(request()) })).rejects.toMatchObject({ code: "mcp_router_model_output_limit" });
    expect(executeStructuredOutput).not.toHaveBeenCalled();
  });

  it("shares the frozen cap and remaining deadline with refinement", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const executeStructuredOutput = vi.fn(async (_role, _request, options) => {
      if (executeStructuredOutput.mock.calls.length === 1) {
        expect(options?.timeoutMs).toBe(20_000);
        now.mockReturnValue(16_000);
        return { mcp_needed: true, requirements: [{ outcome: "Read data", status: "uncovered", tool_ids: [] }] };
      }
      expect(options?.timeoutMs).toBe(5_000);
      return { mcp_needed: true, requirements: [{ outcome: "Read data", status: "covered", tool_ids: [jiraTool] }] };
    });
    try {
      const router = createMcpSemanticRouter({ executeStructuredOutput, resolveSystemModel: async () => resolution() });
      await expect(router.route({ activeToolNames: new Set(), catalog, goals: ["Read data"], limit: 10,
        maxOutputTokens: 4096, timeoutMs: 20_000, context: mcpChatDiscoveryContext(request()) })).resolves.toMatchObject({ toolNames: [jiraTool] });
      expect(executeStructuredOutput.mock.calls.map((call) => call[1].maxOutputTokens)).toEqual([4096, 4096]);
    } finally { now.mockRestore(); }
  });

  it("does not start refinement once the accepted deadline is exhausted", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const executeStructuredOutput = vi.fn(async () => {
      now.mockReturnValue(21_001);
      return { mcp_needed: true, requirements: [{ outcome: "Read data", status: "uncovered", tool_ids: [] }] };
    });
    try {
      const router = createMcpSemanticRouter({ executeStructuredOutput, resolveSystemModel: async () => resolution() });
      await expect(router.route({ activeToolNames: new Set(), catalog, goals: ["Read data"], limit: 10,
        maxOutputTokens: 4096, timeoutMs: 20_000, context: mcpChatDiscoveryContext(request()) })).rejects.toMatchObject({ code: "mcp_router_timeout" });
      expect(executeStructuredOutput).toHaveBeenCalledOnce();
    } finally { now.mockRestore(); }
  });

  it.each([false, true])("corrects a global selection overflow once, repeated overflow: %s", async (repeatOverflow) => {
    const prompts: Record<string, unknown>[] = [];
    const executeStructuredOutput = vi.fn(async (_role, structuredRequest, options) => {
      prompts.push(JSON.parse(structuredRequest.userPrompt));
      options?.onUsage?.({ inputTokens: 12, outputTokens: 3, reasoningTokens: 0 });
      return {
        mcp_needed: true,
        requirements: [
          { outcome: "Issue", status: "covered", tool_ids: [jiraTool] },
          { outcome: "Pull request", status: "covered", tool_ids: [githubTool] },
          ...(prompts.length === 1 || repeatOverflow
            ? [{ outcome: "Calendar", status: "covered", tool_ids: [calendarTool] }]
            : [{ outcome: "Calendar", status: "uncovered", tool_ids: [] }])
        ]
      };
    });
    const router = createMcpSemanticRouter({
      executeStructuredOutput, resolveSystemModel: async () => resolution()
    });
    const routed = router.route({
      activeToolNames: new Set(), catalog,
      goals: ["Create an issue, a pull request, and a calendar event"],
      limit: 2, context: mcpChatDiscoveryContext(request())
    });
    const usageAttribution = {
      modelId: "gpt-router", provider: "openai",
      usage: expect.objectContaining({ inputTokens: 24, outputTokens: 6 })
    };
    if (repeatOverflow) {
      await expect(routed).rejects.toMatchObject({ code: "mcp_router_output_invalid", usageAttribution });
    } else {
      await expect(routed).resolves.toEqual({ toolNames: [jiraTool, githubTool], usageAttribution });
    }
    expect(executeStructuredOutput).toHaveBeenCalledTimes(2);
    expect(prompts[0]).toMatchObject({ max_unique_tools: 2 });
    expect(prompts[1]).toMatchObject({ max_unique_tools: 2, correction: { previous_unique_tool_count: 3 } });
  });

  it.each([
    { reason: "empty batch", goals: [] },
    { reason: "oversized goal", goals: ["a".repeat(401)] },
    { reason: "oversized batch", goals: Array.from({ length: 65 }, (_, index) => `Goal ${index}`) }
  ])("rejects $reason before provider I/O", async ({ goals }) => {
    const executeStructuredOutput = vi.fn();
    const resolveSystemModel = vi.fn(async () => resolution());
    const router = createMcpSemanticRouter({ executeStructuredOutput, resolveSystemModel });

    await expect(router.route({
      activeToolNames: new Set(), catalog, goals, limit: 5, context: mcpChatDiscoveryContext(request())
    })).rejects.toMatchObject({ code: "mcp_router_request_failed", usageAttribution: null });
    expect(executeStructuredOutput).not.toHaveBeenCalled();
    expect(resolveSystemModel).not.toHaveBeenCalled();
  });

  it.each(["success", "request_failure", "invalid_output", "cancelled"] as const)(
    "preserves every batch goal and reported attempt usage on %s",
    async (outcome) => {
      const goals = ["a".repeat(400), "Create a calendar event"];
      const controller = new AbortController();
      const prompts: Record<string, unknown>[] = [];
      const executeStructuredOutput = vi.fn(async (_role, structuredRequest, options) => {
        prompts.push(JSON.parse(structuredRequest.userPrompt));
        options?.onUsage?.({ inputTokens: 12, outputTokens: 3, reasoningTokens: 0 });
        if (prompts.length === 1) {
          return {
            mcp_needed: true,
            requirements: [{ outcome: "Calendar event", status: "uncovered", tool_ids: [] }]
          };
        }
        if (outcome === "cancelled") controller.abort();
        if (outcome === "cancelled" || outcome === "request_failure") {
          throw new Error("PRIVATE_UPSTREAM_FAILURE");
        }
        return {
          mcp_needed: true,
          requirements: [{
            outcome: "Calendar event",
            status: "covered",
            tool_ids: [outcome === "invalid_output" ? "unknown-tool" : calendarTool]
          }]
        };
      });
      const router = createMcpSemanticRouter({
        executeStructuredOutput,
        resolveSystemModel: async () => resolution()
      });
      const routed = router.route({
        activeToolNames: new Set(),
        catalog,
        goals,
        limit: 5,
        context: mcpChatDiscoveryContext(request()),
        signal: controller.signal
      });
      const usageAttribution = {
        modelId: "gpt-router",
        provider: "openai",
        usage: expect.objectContaining({ inputTokens: 24, outputTokens: 6 })
      };

      if (outcome === "success") {
        await expect(routed).resolves.toEqual({ toolNames: [calendarTool], usageAttribution });
      } else {
        await expect(routed).rejects.toMatchObject({
          code: outcome === "invalid_output" ? "mcp_router_output_invalid"
            : outcome === "cancelled" ? "mcp_router_cancelled" : "mcp_router_request_failed",
          usageAttribution
        });
      }
      expect(prompts).toHaveLength(2);
      expect(prompts[0]).toMatchObject({ goals });
      expect(prompts[1]).toMatchObject({ goals, correction: expect.any(Object) });
    }
  );

  it.each(["complete", "cancelled", "unavailable"] as const)("accounts cumulative discovery snapshots once when %s", async (outcome) => {
    const controller = new AbortController();
    const settle = vi.fn(async () => undefined);
    const router = createMcpSemanticRouter({
      resolveSystemModel: async () => resolution(),
      executeStructuredOutput: async (_role, _request, options) => {
        await options?.beforeDispatch?.();
        if (outcome !== "unavailable") {
          options?.onUsage?.({ inputTokens: 10, cachedInputTokens: 0 });
          options?.onUsage?.({ outputTokens: 2 });
          options?.onUsage?.({ outputTokens: 3 });
        }
        if (outcome !== "complete") { controller.abort(); throw new Error("Interrupted"); }
        return { mcp_needed: true, requirements: [{ outcome: "Create an issue", status: "covered", tool_ids: [jiraTool] }] };
      }
    });
    const routed = router.route({ activeToolNames: new Set(), catalog, goals: ["Create an issue"], limit: 5,
      recordAttempt: async () => ({ settle }), signal: controller.signal });
    const usage = outcome === "unavailable"
      ? { inputTokens: null, outputTokens: null, totalTokens: null, completeness: "unavailable" }
      : { inputTokens: 10, outputTokens: 3, totalTokens: 13, cachedInputTokens: 0, completeness: outcome === "complete" ? "complete" : "partial" };
    if (outcome === "complete") await expect(routed).resolves.toMatchObject({ usageAttribution: { usage } });
    else await expect(routed).rejects.toMatchObject({ code: "mcp_router_cancelled", usageAttribution: { usage } });
    expect(settle).toHaveBeenCalledExactlyOnceWith({ state: outcome === "complete" ? "COMPLETE" : outcome === "cancelled" ? "ERROR" : "UNKNOWN",
      usage: expect.objectContaining(usage) });
  });

  it("retains first-attempt usage when the corrective request fails before reporting usage", async () => {
    const executeStructuredOutput = vi.fn()
      .mockImplementationOnce(async (_role, _request, options) => {
        options?.onUsage?.({ inputTokens: 12, outputTokens: 3, reasoningTokens: 0 });
        return {
          mcp_needed: true,
          requirements: [{ outcome: "Create an issue", status: "uncovered", tool_ids: [] }]
        };
      })
      .mockRejectedValueOnce(new Error("PRIVATE_UPSTREAM_FAILURE"));
    const router = createMcpSemanticRouter({
      executeStructuredOutput,
      resolveSystemModel: async () => resolution()
    });

    await expect(router.route({
      activeToolNames: new Set(),
      catalog,
      goals: ["Create an issue"],
      limit: 5,
      context: mcpChatDiscoveryContext(request())
    })).rejects.toMatchObject({
      code: "mcp_router_request_failed",
      message: "mcp_router_request_failed",
      usageAttribution: {
        modelId: "gpt-router",
        provider: "openai",
        usage: expect.objectContaining({ inputTokens: 12, outputTokens: 3, reasoningTokens: 0 })
      }
    });
  });

  it.each([
    ["создай задачу в проекте", jiraTool],
    ["open a pul reqest for this change", githubTool],
    ["добавь встречу в календарь", calendarTool]
  ])("routes multilingual or typo-rich goal %s", async (goal, selected) => {
    const executeStructuredOutput = vi.fn(async (_role, structuredRequest, options) => {
      options?.onUsage?.({ inputTokens: 12, outputTokens: 3, reasoningTokens: 0 });
      expect(structuredRequest.schema).toMatchObject({
        properties: {
          requirements: {
            items: {
              properties: {
                tool_ids: {
                  items: { enum: [jiraTool, githubTool, calendarTool] },
                  maxItems: 5,
                  uniqueItems: true
                }
              }
            }
          }
        }
      });
      return {
        mcp_needed: true,
        requirements: [{ outcome: goal, status: "covered", tool_ids: [selected] }]
      };
    });
    const router = createMcpSemanticRouter({
      executeStructuredOutput,
      resolveSystemModel: async () => resolution()
    });

    await expect(router.route({
      activeToolNames: new Set(),
      catalog,
      goals: [goal],
      limit: 5,
      context: mcpChatDiscoveryContext(request()),
    })).resolves.toEqual({
      toolNames: [selected],
      usageAttribution: {
        modelId: "gpt-router",
        provider: "openai",
        usage: expect.objectContaining({ inputTokens: 12, outputTokens: 3, reasoningTokens: 0 })
      }
    });
  });

  it("excludes loaded tools and supports an exact empty selection", async () => {
    const executeStructuredOutput = vi.fn(async (_role, structuredRequest) => {
      expect(JSON.stringify(structuredRequest.schema)).not.toContain(jiraTool);
      return { mcp_needed: false, requirements: [] };
    });
    const router = createMcpSemanticRouter({
      executeStructuredOutput,
      resolveSystemModel: async () => resolution()
    });

    await expect(router.route({
      activeToolNames: new Set([jiraTool]),
      catalog,
      goals: ["Just explain the architecture; do not perform an action"],
      limit: 5,
      context: mcpChatDiscoveryContext(request())
    })).resolves.toEqual({ toolNames: [], usageAttribution: null });
  });

  it("projects only bounded text and compact schema-free catalog metadata", () => {
    const prompt = buildMcpRouterPrompt({
      activeToolNames: new Set(),
      catalog,
      goals: ["Create the issue"],
      limit: 5,
      context: mcpChatDiscoveryContext(request())
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
      .mockResolvedValueOnce({
        mcp_needed: true,
        requirements: [{
          outcome: "Create an issue",
          status: "covered",
          tool_ids: ["unknown-tool"]
        }]
      })
      .mockResolvedValueOnce({
        mcp_needed: true,
        requirements: [{
          outcome: "Create an issue",
          status: "covered",
          tool_ids: [jiraTool, jiraTool]
        }]
      });
    const router = createMcpSemanticRouter({
      executeStructuredOutput,
      resolveSystemModel: async () => resolution()
    });
    const route = () => router.route({
      activeToolNames: new Set(),
      catalog,
      goals: ["Create an issue"],
      limit: 5,
      context: mcpChatDiscoveryContext(request())
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
      goals: ["Create an issue"],
      limit: 5,
      context: mcpChatDiscoveryContext(request())
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
