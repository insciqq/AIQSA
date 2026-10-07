import type { Prisma, PrismaClient } from "@prisma/client";
import { mergeTokenUsage, normalizeTokenUsage, type TokenUsage } from "../../domain/usage";
import {
  boundedKnowledgeImageObservation, decodeKnowledgeImageObservationBlock, KNOWLEDGE_IMAGE_OBSERVATION_LIMITS as LIMITS,
  KNOWLEDGE_IMAGE_OBSERVATION_SYSTEM_PROMPT, knowledgeImageObservationQuestion, knowledgeImageObservationRequestHash,
  type KnowledgeImageObservationBlock, type KnowledgeImageObservationPlan
} from "../knowledge/imageObservation";
import { hashCanonicalMcpValue } from "../mcp/definitions";
import type { createAcceptedProviderRequestExecutor } from "../providerRuntime/acceptedRequestExecutor";
import type { AvailableVisionAnalysisPlan } from "../providerRuntime/visionAnalysis";
import { observedFailureCode } from "../providers/providerObservability";
import { normalizeProviderExecutionSnapshot } from "../providers/runtimeFactory";
import type { ProviderRunRequest } from "../providers/types";
import { visionAnalysisTimeoutMs } from "../tools/analyzeImage";
import { ConversationImageError, type ConversationImageSource, type ConversationVisionImage } from "./conversationImages";
import { authorizeVisionPlan, lockVisionRun, recordVisionUsage, VisionAnalysisError, visionRunAccess } from "./store";

/** What a Knowledge run may do with its one image description. */
export type KnowledgeImageObservationOutcome =
  | Readonly<{ kind: "observed"; observation: KnowledgeImageObservationBlock }>
  | Readonly<{ kind: "failed"; code: string }>
  | Readonly<{ kind: "unknown" }>;

type Context = Readonly<{ runId: string; userId: string; chatId: string; requestHash: string }>;
type Destination = Readonly<{
  bindingKey: "answer" | "vision_analysis";
  authority: Pick<AvailableVisionAnalysisPlan["authority"], "connectionId" | "providerModelId" | "credentialId" | "credentialVersionId">;
  snapshot: AvailableVisionAnalysisPlan["snapshot"];
  /** The accepted binding's stored execution snapshot, which the dispatch claim rechecks. */
  snapshotHash: string;
  reasoningEffort: string | null;
}>;
type Settlement = Readonly<{ kind: "observed"; observation: KnowledgeImageObservationBlock }> | Readonly<{ kind: "failed"; code: string }>;

const KNOWN_FAILURES = new Set([
  "vision_model_unavailable", "vision_analysis_access_denied", "vision_analysis_limit_exceeded", "vision_analysis_cancelled",
  "vision_analysis_response_invalid", "chat_image_unavailable", "chat_image_unsupported", "chat_image_invalid", "chat_image_limit_exceeded"
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function outcome(c: Context, row: Readonly<{ requestHash: string; state: string; result: Prisma.JsonValue | null }>): KnowledgeImageObservationOutcome {
  // A row for another request is never reused as this run's observation.
  if (row.requestHash !== c.requestHash) return { kind: "failed", code: "knowledge_image_observation_conflict" };
  if (row.state !== "settled" || !record(row.result) || row.result.version !== 1) return { kind: "unknown" };
  if (row.result.kind === "observed") {
    const observation = decodeKnowledgeImageObservationBlock(row.result.observation);
    return observation ? { kind: "observed", observation } : { kind: "unknown" };
  }
  return row.result.kind === "failed" && typeof row.result.code === "string" ? { kind: "failed", code: row.result.code } : { kind: "unknown" };
}

/** The run-level dispatch fence: the row exists before the provider request and settles once. */
export function createKnowledgeImageObservationStore(prisma: PrismaClient) {
  return {
    async load(c: Context): Promise<KnowledgeImageObservationOutcome | null> {
      const row = await prisma.knowledgeImageObservation.findUnique({ where: { modelRunId: c.runId },
        select: { requestHash: true, state: true, result: true } });
      return row ? outcome(c, row) : null;
    },
    /** The admitted destination: the run's answer binding, or the System Vision binding the plan froze. */
    async destination(c: Context, plan: KnowledgeImageObservationPlan): Promise<Destination | null> {
      const bindingKey = plan.route === "system_vision" ? "vision_analysis" : "answer";
      const binding = await prisma.providerRunBinding.findFirst({ where: { modelRunId: c.runId, bindingKey },
        select: { connectionId: true, providerModelId: true, credentialId: true, credentialVersionId: true, executionSnapshot: true } });
      if (!binding?.connectionId || !binding.providerModelId || !binding.credentialId || !binding.credentialVersionId) return null;
      const snapshotHash = hashCanonicalMcpValue(binding.executionSnapshot);
      if (plan.route === "system_vision") {
        const vision = plan.vision;
        return binding.connectionId === vision.authority.connectionId && binding.providerModelId === vision.authority.providerModelId &&
          binding.credentialId === vision.authority.credentialId && binding.credentialVersionId === vision.authority.credentialVersionId &&
          snapshotHash === hashCanonicalMcpValue(vision.snapshot)
          ? { bindingKey, authority: vision.authority, snapshot: vision.snapshot, snapshotHash, reasoningEffort: vision.reasoningEffort } : null;
      }
      // The answer model describes images only with the image input its accepted binding was admitted with.
      let snapshot: Destination["snapshot"];
      try { snapshot = normalizeProviderExecutionSnapshot(binding.executionSnapshot); } catch { return null; }
      return snapshot.model.capabilities.vision === true && snapshot.connectionId === binding.connectionId &&
        snapshot.providerModelId === binding.providerModelId && snapshot.credentialVersionId === binding.credentialVersionId
        ? { bindingKey, snapshot, snapshotHash, reasoningEffort: null, authority: { connectionId: binding.connectionId,
          providerModelId: binding.providerModelId, credentialId: binding.credentialId, credentialVersionId: binding.credentialVersionId } } : null;
    },
    /** Claims the one dispatch with its usage receipt; an existing row returns its outcome instead. */
    async dispatch(c: Context, destination: Destination, images: Prisma.InputJsonValue): Promise<KnowledgeImageObservationOutcome | null> {
      return prisma.$transaction(async tx => {
        await lockVisionRun(tx, c.runId);
        const authority = await visionRunAccess(tx, c);
        if (!authority.active) throw new VisionAnalysisError("vision_analysis_cancelled");
        const existing = await tx.knowledgeImageObservation.findUnique({ where: { modelRunId: c.runId },
          select: { requestHash: true, state: true, result: true } });
        if (existing) return outcome(c, existing);
        const binding = await tx.providerRunBinding.findFirst({ where: { modelRunId: c.runId, bindingKey: destination.bindingKey,
          connectionId: destination.authority.connectionId, providerModelId: destination.authority.providerModelId,
          credentialId: destination.authority.credentialId, credentialVersionId: destination.authority.credentialVersionId }, select: { executionSnapshot: true } });
        if (!binding || hashCanonicalMcpValue(binding.executionSnapshot) !== destination.snapshotHash ||
          !await authorizeVisionPlan(tx, destination)) throw new VisionAnalysisError("vision_model_unavailable");
        await tx.knowledgeImageObservation.create({ data: { modelRunId: c.runId, providerBindingKey: destination.bindingKey,
          requestHash: c.requestHash, images } });
        await tx.usageEvent.create({ data: { visionAnalysis: true, knowledgeImageObservationRunId: c.runId, purpose: "knowledge_indexing",
          userId: c.userId, chatId: c.chatId, modelRunId: c.runId, projectId: authority.projectId,
          provider: destination.snapshot.providerFamily, providerModelId: destination.authority.providerModelId,
          modelId: destination.snapshot.model.upstreamModelId } });
        return null;
      });
    },
    /** Records the result and provider-reported usage once; a late success after Stop is never published. */
    async settle(c: Context, result: Settlement, usage: TokenUsage, unknown: boolean, signal: AbortSignal): Promise<KnowledgeImageObservationOutcome> {
      return prisma.$transaction(async tx => {
        await lockVisionRun(tx, c.runId);
        const row = await tx.knowledgeImageObservation.findUnique({ where: { modelRunId: c.runId },
          select: { requestHash: true, state: true, result: true } });
        if (!row) return { kind: "failed", code: "vision_analysis_cancelled" };
        if (row.state !== "dispatched") return outcome(c, row);
        const allowed = await visionRunAccess(tx, c).catch(() => null);
        const final: Settlement = allowed?.active && (result.kind === "failed" || !signal.aborted)
          ? result : { kind: "failed", code: "vision_analysis_cancelled" };
        const receipt = await tx.usageEvent.findUnique({ where: { knowledgeImageObservationRunId: c.runId },
          select: { id: true, providerModelId: true } });
        if (receipt) await recordVisionUsage(tx, receipt, usage);
        await tx.knowledgeImageObservation.update({ where: { modelRunId: c.runId }, data: {
          state: unknown ? "ambiguous" : "settled", settledAt: new Date(),
          result: (final.kind === "observed" ? { version: 1, kind: "observed", observation: final.observation }
            : { version: 1, kind: "failed", code: final.code }) as Prisma.InputJsonValue,
          failureCode: final.kind === "failed" ? final.code : null } });
        return unknown ? { kind: "unknown" } : final;
      });
    }
  };
}

export type KnowledgeImageObservationStore = ReturnType<typeof createKnowledgeImageObservationStore>;

export type KnowledgeImageObservationInput = Readonly<{
  plan: KnowledgeImageObservationPlan;
  /** The accepted question text; only its bounded prefix focuses the description. */
  question: string;
  runId: string;
  userId: string;
  chatId: string;
  /** The caller's current run authority (answer entitlement, Project access); false refuses before any image is read. */
  authorize(): Promise<boolean>;
  /** Optional dispatch journal around the one provider request. */
  onDispatch?(request: ProviderRunRequest, destination: Readonly<{ provider: string; modelId: string }>): Promise<((ok: boolean, code: string | null) => Promise<void>) | null>;
  timeoutMs?: number;
  /** The output allowance, reasoning included; System Vision's analysis allowance by default. */
  maxOutputTokens?: number;
  signal: AbortSignal;
}>;

/**
 * Describes the current message's admitted images once per run, before the
 * grounded Knowledge answer: authority and bounds before reading pixels, the
 * dispatch claim before the provider request, and one settlement with usage.
 * A settled or dispatched description is returned, never requested again.
 */
export function createKnowledgeImageObservation(prisma: PrismaClient, options: Readonly<{
  store?: KnowledgeImageObservationStore;
  execute: ReturnType<typeof createAcceptedProviderRequestExecutor>;
  conversationImages?: ConversationImageSource;
  boundedRequest: typeof import("./service").boundedVisionRequest;
  providerRequest: typeof import("./service").visionProviderRequest;
}>) {
  const store = options.store ?? createKnowledgeImageObservationStore(prisma);
  return async function observe(input: KnowledgeImageObservationInput): Promise<KnowledgeImageObservationOutcome> {
    const c: Context = { runId: input.runId, userId: input.userId, chatId: input.chatId,
      requestHash: knowledgeImageObservationRequestHash(input.plan, input.question) };
    const existing = await store.load(c);
    if (existing) return existing;
    // System Vision waits by its frozen reasoning effort, like analyze_image.
    const timeoutMs = Math.min(Math.max(input.timeoutMs ?? (input.plan.route === "system_vision"
      ? visionAnalysisTimeoutMs(input.plan.vision) : LIMITS.timeoutMs), 1_000), 600_000);
    const bounded = AbortSignal.any([input.signal, AbortSignal.timeout(timeoutMs)]);
    let images: readonly ConversationVisionImage[] = [];
    // Claimed: the row exists and must settle. Sent: the provider may have it.
    let dispatched = false;
    let sent = false;
    let completed = false;
    let usage = normalizeTokenUsage({});
    let finish: ((ok: boolean, code: string | null) => Promise<void>) | null = null;
    try {
      let result: Settlement;
      try {
        bounded.throwIfAborted();
        const destination = await store.destination(c, input.plan);
        if (!destination || !await input.authorize()) throw new VisionAnalysisError("vision_model_unavailable");
        if (!options.conversationImages) throw new VisionAnalysisError("vision_model_unavailable");
        const prepared = await options.conversationImages.prepare({ runId: c.runId, userId: c.userId, chatId: c.chatId,
          admittedImageIds: input.plan.imageIds, images: input.plan.imageIds.map(imageId => ({ imageId })) }, bounded);
        images = prepared.images;
        const question = knowledgeImageObservationQuestion(input.question);
        const maxOutputTokens = Math.min(Math.max(input.maxOutputTokens ?? LIMITS.maxOutputTokens, LIMITS.minOutputTokens),
          LIMITS.answerModelMaxOutputTokens);
        const request = await options.boundedRequest({ snapshot: destination.snapshot, images, maxOutputTokens,
          build: attachments => options.providerRequest(destination, c.chatId, question ? `Question: ${question}` : "Describe the attached images.",
            attachments, { system: KNOWLEDGE_IMAGE_OBSERVATION_SYSTEM_PROMPT, maxOutputTokens }),
          invalidImage: () => new ConversationImageError("chat_image_invalid"), signal: bounded });
        await prepared.assertAccess();
        bounded.throwIfAborted();
        const claimed = await store.dispatch(c, destination, images.map(image => image.descriptor) as unknown as Prisma.InputJsonValue);
        if (claimed) return claimed;
        dispatched = true;
        finish = await input.onDispatch?.(request, { provider: destination.snapshot.providerFamily,
          modelId: destination.snapshot.model.upstreamModelId }) ?? null;
        bounded.throwIfAborted();
        sent = true;
        const response = await options.execute(destination.snapshot, request, { signal: bounded, timeoutMs,
          onUsage: update => { usage = mergeTokenUsage(usage, update); } });
        completed = true;
        usage = mergeTokenUsage(usage, response.usage);
        bounded.throwIfAborted();
        if (!response.finalText.trim() || response.toolCalls?.length) throw new VisionAnalysisError("vision_analysis_response_invalid");
        result = { kind: "observed", observation: boundedKnowledgeImageObservation(response.finalText) };
      } catch (error) {
        const observed = observedFailureCode(error);
        const code = input.signal.aborted ? "vision_analysis_cancelled" : bounded.aborted ? "vision_analysis_timeout"
          : KNOWN_FAILURES.has(observed) ? observed : sent ? "vision_analysis_provider_failed" : "vision_analysis_internal_failed";
        result = { kind: "failed", code };
      }
      // Nothing was claimed: the run fails visibly and nothing needs settling.
      if (!dispatched) return result;
      // A claim that never reached the provider settles as a definite failure.
      const unknown = sent && !completed;
      await finish?.(result.kind === "observed", result.kind === "failed" ? result.code : null).catch(() => undefined);
      // The settlement is keyed by the run and has one winner; retry only this identical local write.
      // Only Stop withholds a completed description; a deadline passing during settlement does not.
      try { return await store.settle(c, result, usage, unknown, input.signal); }
      catch {
        try { return await store.settle(c, result, usage, unknown, input.signal); }
        catch { return { kind: "unknown" }; }
      }
    } finally {
      for (const image of images) image.dispose();
    }
  };
}
