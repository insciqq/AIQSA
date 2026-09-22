import { agentMcpEnvelopeTimeoutSeconds } from "./mcpTimeout";
import { AgentExecutionError, agentFailureCode } from "./failures";
import { prisma } from "../prisma";
import { sumTokenUsage } from "@/lib/domain/usage";
import type { ThreadWorkspaceActivityEntry } from "@/lib/contracts/workspace";
import type { ModelRunSseEvent } from "@/lib/domain/modelRunEvents";
import type { ProviderRunRequest, ProviderRunResult } from "../providers/types";
import { effectiveProviderResponseTimeoutMs } from "../providers/providerConfiguration";
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
import { followupTokenCost, type RunFollowupOperations } from "../runs/runFollowups";
import { AGENT_PROMPT_MAX_BYTES } from "./guest";

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
  followups?: Readonly<{
    operations: RunFollowupOperations;
    beforeDelivery(): Promise<string>;
    onDelivery(revision: number): Promise<void>;
  }>;
}>): Promise<ProviderRunResult & { followupRevision: number }> {
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
  let followupRevision = 0;
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
    let grant = { ...await store.arm(prompts.previousAssistantMessageId), timeoutSeconds: configuration.timeoutSeconds };
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
      responseTimeoutMs: effectiveProviderResponseTimeoutMs(input.transport.snapshot.connection,
        input.transport.snapshot.model.adapterKind === "fake" ? null : input.transport.snapshot.model),
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
    let previousToolCallId: string | undefined;
    let lastFollowupRead = 0;
    for (;;) {
      signal.throwIfAborted();
      const batch = await input.followups?.operations.load({ runId: input.runId, userId: input.userId });
      const additions = batch?.entries.filter(entry => entry.delivery === "accepted") ?? [];
      const clarification = additions.length ? JSON.stringify(additions.map(entry => ({ role: "user", text: entry.text }))) : "";
      const prompt = previousToolCallId ? clarification : [prompts.prompt, clarification].filter(Boolean).join("\n\n");
      const resumePrompt = previousToolCallId ? clarification : [prompts.resumePrompt, clarification].filter(Boolean).join("\n\n");
      if (previousToolCallId && !clarification || Buffer.byteLength(prompt) > AGENT_PROMPT_MAX_BYTES ||
        Buffer.byteLength(resumePrompt) > AGENT_PROMPT_MAX_BYTES) throw new Error("agent_context_too_large");
      callId = await store.toolCall(namespacedWorkspaceToolName("sandbox_exec_start"), { managedAgent: true }, true);
      // Native item IDs restart at zero in every exec; retain earlier activity.
      const projectActivity = createCodexActivityProjection(`${input.runId}\0${callId}`, input.request);
      const outcome = await input.workspace.executeAgent({
        modelRunToolCallId: callId, onActivity: input.onActivity, profile,
        prompt, resumePrompt, previousToolCallId,
        runId: input.runId, runToken: grant.token, signal, threadId: grant.threadId,
        timeoutSeconds: grant.timeoutSeconds, userId: input.userId, workspace: input.request.workspace,
        async shouldInterrupt() {
          if (!batch || !input.followups || Date.now() - lastFollowupRead < 500) return false;
          lastFollowupRead = Date.now();
          const current = await input.followups.operations.load({ runId: input.runId, userId: input.userId });
          if (!current || current.revision <= followupRevision) return false;
          return store.claimFollowupInterrupt(grant.token);
        },
        async onEvent(event, text) {
          if (event.type === "thread_started") {
            signal.throwIfAborted();
            await store.setThread(event.threadId);
          }
          if (event.type === "turn_started" && batch && additions.length && input.followups) {
            // A signal is not a delivery receipt. Confirm only once native
            // execution has accepted this segment's actual user prompt.
            await publishFinalText();
            const precedingText = await input.followups.beforeDelivery();
            const delivered = await input.followups.operations.deliver({ runId: input.runId, userId: input.userId,
              revision: batch.revision, precedingText, confirmedThrough: true,
              budgetTokens: Math.max(0, (input.request.followupContextReserveTokens ?? 0) - batch.entries.reduce((sum, entry) => sum + followupTokenCost(entry.text), 0)) });
            if (!delivered) throw new Error("followup_execution_closed");
            followupRevision = batch.revision;
            finalText = "";
            textPublished = false;
            await input.followups.onDelivery(followupRevision);
          }
          if (event.type === "message") {
            finalText = text.text(event.text);
          }
          const entry = projectActivity(event, text);
          if (entry) await input.onActivity(entry);
        }
      });
      signal.throwIfAborted();
      await store.assertActive();
      await progress?.refresh();
      await store.settleTool(callId, "complete", { status: outcome === "interrupted" ? "followup_interrupted" : "complete" });
      if (!batch || !input.followups || await input.followups.operations.close({ runId: input.runId, userId: input.userId, revision: followupRevision })) break;
      grant = await store.continueAfterExit(grant.token, callId);
      signal.throwIfAborted();
      previousToolCallId = callId;
    }
    completed = true;
    await publishFinalText();
    await onUsage();
    return { finalText, followupRevision, usage: sumTokenUsage((await store.usage()).map((entry) => entry.usage)),
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
