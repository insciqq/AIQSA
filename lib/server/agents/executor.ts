import { searchExecutionConfiguration } from "../search/toolExecutor";
import { AgentExecutionError, agentFailureCode } from "./failures";
import { prisma } from "../prisma";
import { sumTokenUsage } from "@/lib/domain/usage";
import type { ThreadWorkspaceActivityEntry } from "@/lib/contracts/workspace";
import type { ModelRunSseEvent } from "@/lib/domain/modelRunEvents";
import type { ProviderRunRequest, ProviderRunResult } from "../providers/types";
import { supportsAgentNativeWebSearch, supportsAgentStandaloneWebSearch, type AgentResponsesTransport } from "../providers/agentResponses";
import type { WorkspaceCoordinator } from "../workspace/coordinator";
import type { RunUsageAttribution } from "../runs/runRepositoryContract";
import { namespacedWorkspaceToolName } from "../workspace/toolCatalog";
import { createAgentRunStore } from "./store";
import { agentPrompts } from "./prompt";
import type { CodexManagedProfile } from "./codexProfile";

export async function executeCodexTurn(input: Readonly<{
  request: ProviderRunRequest;
  runId: string;
  userId: string;
  signal: AbortSignal;
  transport: AgentResponsesTransport;
  workspace: WorkspaceCoordinator;
  onEvent(event: ModelRunSseEvent): Promise<void>;
  onActivity(entry: ThreadWorkspaceActivityEntry): Promise<void>;
  onUsage(attributions: RunUsageAttribution[]): Promise<void>;
}>): Promise<ProviderRunResult> {
  const configuration = input.request.agent;
  if (!configuration || !input.request.workspace || !input.workspace.executeAgent) throw new Error("agent_unavailable");
  const prompts = agentPrompts(input.request);
  const store = createAgentRunStore(prisma, { runId: input.runId, userId: input.userId, configuration });
  const controller = new AbortController();
  const signal = AbortSignal.any([input.signal, controller.signal]);
  const fail = (code: string) => controller.abort(new Error(code));
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let renewing: Promise<void> | null = null;
  let completed = false;
  let callId: string | null = null;
  let finalText = "";
  const onUsage = async () => input.onUsage(await store.usage());
  try {
    const grant = await store.arm(prompts.previousAssistantMessageId);
    heartbeat = setInterval(() => {
      renewing ??= store.renew().then(onUsage).catch((error) => fail(agentFailureCode(error) ?? "agent_authority_expired")).finally(() => { renewing = null; });
    }, 10_000);
    heartbeat.unref();
    const effort = input.request.reasoningEffort;
    const profile: CodexManagedProfile = {
      gatewayOrigin: configuration.gatewayOrigin, modelId: input.request.modelId,
      contextWindowTokens: input.request.modelCapabilities.contextWindow ?? 128000,
      maxOutputTokens: configuration.maxOutputTokens,
      nativeWebSearch: supportsAgentNativeWebSearch(input.transport.snapshot),
      standaloneWebSearch: supportsAgentStandaloneWebSearch(input.transport.snapshot),
      developerInstructions: prompts.developerInstructions,
      mcpMode: configuration.mcpMode === "all" && !input.request.mcp?.tools.length ? "off" : configuration.mcpMode,
      aiqsaSearch: input.request.searchPlan.options.length > 0,
      mcpTimeoutSeconds: Math.max(input.request.toolBudgets?.mcpAutoDiscoveryTimeoutSeconds ?? 90,
        ...input.request.searchPlan.options.map((option) => Math.ceil(searchExecutionConfiguration(option).timeoutMs / 1000))),
      ...(effort && ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(effort)
        ? { reasoningEffort: effort as CodexManagedProfile["reasoningEffort"] } : {})
    };
    callId = await store.toolCall(namespacedWorkspaceToolName("sandbox_exec_start"), { managedAgent: true }, true);
    await input.workspace.executeAgent({
      modelRunToolCallId: callId, onActivity: input.onActivity, profile,
      prompt: prompts.prompt, resumePrompt: prompts.resumePrompt,
      runId: input.runId, runToken: grant.token, signal, threadId: grant.threadId,
      timeoutSeconds: configuration.timeoutSeconds, userId: input.userId, workspace: input.request.workspace,
      async onEvent(event) {
        signal.throwIfAborted();
        if (event.type === "thread_started") await store.setThread(event.threadId);
        if (event.type === "message") {
          const delta = `${finalText ? "\n\n" : ""}${event.text}`;
          finalText += delta;
          await input.onEvent({ type: "token", data: { delta } });
        }
        if (event.type === "activity" && (event.kind === "mcp" || event.kind === "search")) await input.onEvent({ type: "artifact", data: {
          artifactType: event.phase === "running" ? "tool_call" : "tool_result",
          payload: { name: event.kind === "search" ? "Codex web search" : "AIQSA MCP", origin: event.kind === "search" ? "tool" : "mcp", status: event.phase === "running" ? "requested" : event.phase === "succeeded" ? "complete" : "error" }
        } });
        if (event.type === "activity" && (event.kind === "command" || event.kind === "file_change")) await input.onActivity({
          id: `agent:${input.runId}:${event.id}`, kind: event.kind === "command" ? "command" : "file_write",
          phase: event.phase,
          ...(event.kind === "command" ? { command: { preview: "Codex" } } : {})
        });
      }
    });
    signal.throwIfAborted();
    await store.settleTool(callId, "complete", { status: "complete" });
    completed = true;
    await onUsage();
    return { finalText, usage: sumTokenUsage((await store.usage()).map((entry) => entry.usage)),
      finalProviderResponsePreview: { engine: "codex", version: configuration.codexVersion } };
  } catch (error) {
    const cause = agentFailureCode(signal.aborted ? signal.reason : error);
    if (cause) await store.fail(cause);
    const persisted = await store.failure();
    if (persisted) throw new AgentExecutionError(persisted);
    throw error;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    controller.abort();
    await renewing;
    await store.revoke(completed);
    if (!completed) await store.drain();
    if (!completed && callId) await store.settleTool(callId, "error", { status: "interrupted" });
    await onUsage();
  }
}
