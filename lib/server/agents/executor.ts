import { agentMcpEnvelopeTimeoutSeconds } from "./mcpTimeout";
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
import { createCodexActivityProjection } from "./activityProjection";
import { createAgentBuiltinProgress } from "./builtinProgress";
import type { RunOutputArtifactEvent } from "../runs/runOutputEvents";

export async function executeCodexTurn(input: Readonly<{
  request: ProviderRunRequest;
  runId: string;
  userId: string;
  signal: AbortSignal;
  transport: AgentResponsesTransport;
  workspace: WorkspaceCoordinator;
  onEvent(event: ModelRunSseEvent): Promise<void>;
  onPersistedEvent(event: RunOutputArtifactEvent): Promise<void>;
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
  let progressTimer: ReturnType<typeof setInterval> | undefined;
  let renewing: Promise<void> | null = null;
  let completed = false;
  let callId: string | null = null;
  let finalText = "";
  let textPublished = false;
  const projectActivity = createCodexActivityProjection(input.runId, input.request);
  const progress = input.request.artifactTool || input.request.imagePlan ? createAgentBuiltinProgress({ runId: input.runId, store,
    onEvent: input.onEvent, onPersistedEvent: input.onPersistedEvent }) : null;
  const publishFinalText = async () => {
    if (!textPublished && finalText) {
      textPublished = true;
      await input.onEvent({ type: "token", data: { delta: finalText } });
    }
  };
  const onUsage = async () => input.onUsage(await store.usage());
  try {
    const grant = await store.arm(prompts.previousAssistantMessageId);
    heartbeat = setInterval(() => {
      renewing ??= store.renew().then(onUsage).catch((error) => fail(agentFailureCode(error) ?? "agent_authority_expired")).finally(() => { renewing = null; });
    }, 10_000);
    heartbeat.unref();
    if (progress) {
      progressTimer = setInterval(() => {
        void progress.refresh().catch(() => fail("agent_execution_interrupted"));
      }, 250);
      progressTimer.unref();
    }
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
      artifacts: input.request.artifactTool === true,
      images: Boolean(input.request.imagePlan),
      mcpTimeoutSeconds: agentMcpEnvelopeTimeoutSeconds(input.request),
      ...(effort && ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(effort)
        ? { reasoningEffort: effort as CodexManagedProfile["reasoningEffort"] } : {})
    };
    callId = await store.toolCall(namespacedWorkspaceToolName("sandbox_exec_start"), { managedAgent: true }, true);
    await input.workspace.executeAgent({
      modelRunToolCallId: callId, onActivity: input.onActivity, profile,
      prompt: prompts.prompt, resumePrompt: prompts.resumePrompt,
      runId: input.runId, runToken: grant.token, signal, threadId: grant.threadId,
      timeoutSeconds: configuration.timeoutSeconds, userId: input.userId, workspace: input.request.workspace,
      async onEvent(event, text) {
        if (event.type === "thread_started") {
          signal.throwIfAborted();
          await store.setThread(event.threadId);
        }
        if (event.type === "message") {
          finalText = text.text(event.text);
        }
        const entry = projectActivity(event, text);
        if (entry) await input.onActivity(entry);
      }
    });
    signal.throwIfAborted();
    await progress?.refresh();
    await store.settleTool(callId, "complete", { status: "complete" });
    completed = true;
    await publishFinalText();
    await onUsage();
    return { finalText, usage: sumTokenUsage((await store.usage()).map((entry) => entry.usage)),
      finalProviderResponsePreview: { engine: "codex", version: configuration.codexVersion } };
  } catch (error) {
    // Stop/error must still deliver the last completed message already received.
    // No abort check here: this publishes known text, never another external call.
    await progress?.refresh().catch(() => undefined);
    await publishFinalText();
    const cause = agentFailureCode(signal.aborted ? signal.reason : error);
    if (cause) await store.fail(cause);
    const persisted = await store.failure();
    if (persisted) throw new AgentExecutionError(persisted);
    throw error;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (progressTimer) clearInterval(progressTimer);
    controller.abort();
    await renewing;
    await store.revoke(completed);
    if (!completed) await store.drain();
    await progress?.refresh().catch(() => undefined);
    await progress?.stop(input.signal.aborted ? "cancelled" : "failed");
    if (!completed && callId) await store.settleTool(callId, "error", { status: "interrupted" });
    await onUsage();
  }
}
